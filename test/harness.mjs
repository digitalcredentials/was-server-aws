// Builds HTTP API payload v2 events, signed the way @interop/was-client's
// ezcap signs them (an invocation of the request URL's own root capability,
// with a Digest over the body), routes them as the gateway would, runs the
// real authorizer, and invokes the endpoint function in process.

import "./env.mjs";
import { signCapabilityInvocation } from "@interop/http-signature-zcap-invoke";
import { Ed25519VerificationKey } from "@interop/ed25519-verification-key";

import { lambdaHandler as authorizer } from "../src/authorizer/app.mjs";
import { matchRoute, GATEWAY_404 } from "./routes.mjs";

export const HOST = "localhost:3000";
export const PROTO = "http";
export const BASE = `${PROTO}://${HOST}`;

const handlers = new Map();
async function handlerFor(fn) {
  if (!handlers.has(fn)) {
    handlers.set(fn, (await import(`../src/endpoints/${fn}/app.mjs`)).lambdaHandler);
  }
  return handlers.get(fn);
}

// A throwaway key for a seed that is public in this repo. Never point it at
// a real deployment.
export async function keyFromSeed(seed) {
  const keyPair = await Ed25519VerificationKey.generate({
    seed: new TextEncoder().encode(seed.padEnd(32, "x").slice(0, 32)),
  });
  keyPair.controller = `did:key:${keyPair.fingerprint()}`;
  keyPair.id = `${keyPair.controller}#${keyPair.fingerprint()}`;
  return keyPair;
}

export const controllerKey = await keyFromSeed("my-secret-seed-that-is-long-enou");
export const strangerKey = await keyFromSeed("somebody-else-entirely-0000000000");

function isText(contentType) {
  return /^(text\/|application\/(json|xml|javascript))|\+(json|xml)/.test(contentType);
}

// Sends one request. `path` is the path as the client addresses it (ids
// percent-encoded as a client would); the event delivers it decoded, as
// API Gateway does. `json` is signed and sent as JSON; `body` (a Buffer or
// string) is signed and sent as given with `contentType`. `deliveredJson`
// replaces the body after signing (a body/digest mismatch).
export async function invoke({
  method = "GET",
  path,
  json,
  body,
  contentType,
  headers = {},
  signer = controllerKey,
  tamper = false,
  deliveredJson,
}) {
  const url = `${BASE}${path}`;
  const bodyBuffer =
    json !== undefined
      ? Buffer.from(JSON.stringify(json))
      : body !== undefined
        ? Buffer.isBuffer(body)
          ? body
          : Buffer.from(body)
        : null;
  const type = json !== undefined ? "application/json" : contentType;

  let requestHeaders = {
    host: HOST,
    accept: "application/json",
    ...(type && { "content-type": type }),
    ...headers,
  };
  if (signer) {
    const signed = await signCapabilityInvocation({
      url,
      method,
      headers: { host: HOST, accept: "application/json", ...(type && { "content-type": type }), ...headers },
      ...(json !== undefined && { json }),
      ...(json === undefined && bodyBuffer !== null && { body: bodyBuffer }),
      capabilityAction: method,
      invocationSigner: signer.signer(),
    });
    requestHeaders = { ...requestHeaders, ...signed };
    if (tamper) {
      requestHeaders.authorization = requestHeaders.authorization.replace(
        /signature="[^"]+"/,
        'signature="aW52YWxpZC1zaWduYXR1cmU="'
      );
    }
  }
  requestHeaders["x-forwarded-proto"] = PROTO;

  const [rawPath, rawQueryString = ""] = path.split("?");
  const decodedPath = rawPath
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");

  const matched = matchRoute(method, decodedPath);
  if (matched === null) {
    return { status: 404, headers: GATEWAY_404.headers, body: GATEWAY_404.body, json: JSON.parse(GATEWAY_404.body), fn: null };
  }
  const { route, params } = matched;
  const delivered = deliveredJson !== undefined ? Buffer.from(JSON.stringify(deliveredJson)) : bodyBuffer;
  const event = {
    version: "2.0",
    routeKey: route.path ? `${method} ${route.path}` : "$default",
    rawPath: decodedPath,
    rawQueryString,
    headers: requestHeaders,
    pathParameters: params,
    requestContext: {
      domainName: HOST,
      http: { method, path: decodedPath, protocol: "HTTP/1.1", sourceIp: "127.0.0.1" },
      routeKey: route.path ? `${method} ${route.path}` : "$default",
      stage: "$default",
    },
    body: delivered === null ? null : type && !isText(type) ? delivered.toString("base64") : delivered.toString("utf8"),
    isBase64Encoded: delivered !== null && Boolean(type) && !isText(type),
  };

  if (route.auth !== false) {
    const { context } = await authorizer({ ...event, type: "REQUEST" }, {});
    event.requestContext.authorizer = { lambda: context };
  }

  const handler = await handlerFor(route.fn);
  const response = await handler(event, {});
  const lower = Object.fromEntries(Object.entries(response.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  let parsed;
  if (/json/.test(lower["content-type"] ?? "") && response.body) {
    parsed = JSON.parse(response.body);
  }
  return {
    status: response.statusCode,
    headers: lower,
    body: response.body,
    isBase64Encoded: response.isBase64Encoded ?? false,
    json: parsed,
    fn: route.fn,
  };
}

// Registers a Space in the fake registry and creates its bucket with
// metadata, the way POST /spaces/ would.
export async function seedSpace(fakes, { spaceId, controller = controllerKey.controller, name = "Test Space", type = ["Space"] }) {
  const bucket = new Map();
  const doc = {
    id: spaceId,
    type,
    name,
    controller,
    createdBy: controller,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  fakes.s3.buckets.set(spaceId, bucket);
  await fakes.s3.send({
    constructor: { name: "PutObjectCommand" },
    input: { Bucket: spaceId, Key: "meta/space.json", Body: JSON.stringify(doc), ContentType: "application/json" },
  });
  fakes.dynamo.tables["wallet-spaces"].set(`${BASE}/space/${spaceId}`, {
    spaceURL: { S: `${BASE}/space/${spaceId}` },
    did: { S: controller },
    type: { L: type.map((entry) => ({ S: entry })) },
    name: { S: name },
    CreatedAt: { S: "2026-01-01T00:00:00.000Z" },
  });
  return doc;
}

export async function seedObject(fakes, spaceId, key, body, contentType = "application/json", metadata = {}) {
  await fakes.s3.send({
    constructor: { name: "PutObjectCommand" },
    input: {
      Bucket: spaceId,
      Key: key,
      Body: typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body),
      ContentType: contentType,
      Metadata: metadata,
    },
  });
}
