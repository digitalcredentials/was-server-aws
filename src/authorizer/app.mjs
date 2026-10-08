// Must be evaluated before @interop/jsonld (CJS) is pulled in by the
// verification stack, which require()s this ESM package mid-graph and hits a
// TDZ error otherwise.
import "@interop/http-client";

import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { verifyInvocation, signerDid, rootCapabilityId } from "./zcap.mjs";

// The HTTP API's REQUEST authorizer (payload v2, simple responses): it
// verifies a signed request's capability invocation and reports the result
// in the request context. It never denies -- a gateway denial is always a
// 403, and the spec's answers to an unauthorized request (404, an empty
// listing, 401 for an unsigned write) are shaped by the endpoint functions
// from this context. Context values must be strings.
//
//   signed           "true" when an Authorization header was present
//   verified         "true" when the invocation verified
//   controller       the verified signer's DID (the invoker)
//   delegated        "true" when a delegated capability was invoked
//   space            "missing" when the URL names a Space the registry
//                    does not hold
//   spaceController  the Space's registered controller DID
//   spaceType        the Space's type array, as JSON
//
// For a Space URL the invocation is verified against the Space's registered
// controller; for the Spaces Repository (no Space in the URL) against the
// DID that signed it, which the POST handler then compares to the stated
// controller.

const dynamo = new DynamoDBClient({});
const SPACES_TABLE = process.env.SPACES_TABLE_NAME ?? "wallet-spaces";

function header(headers, name) {
  const match = Object.keys(headers).find((key) => key.toLowerCase() === name);
  return match === undefined ? undefined : headers[match];
}

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

async function getSpace(spaceUrl) {
  const { Item } = await dynamo.send(
    new GetItemCommand({ TableName: SPACES_TABLE, Key: { spaceURL: { S: spaceUrl } } })
  );
  if (!Item) {
    return null;
  }
  const type = Item.type?.L
    ? Item.type.L.map((entry) => entry.S)
    : Item.type?.S === "batch"
      ? ["Space", "BatchSpace"]
      : ["Space"];
  return { controller: Item.did?.S?.split("#")[0], type };
}

export const lambdaHandler = async (event) => {
  const headers = event.headers ?? {};
  const method = event.requestContext?.http?.method ?? event.httpMethod;
  const rawPath = event.rawPath ?? event.requestContext?.path ?? event.path ?? "/";
  const proto = header(headers, "x-forwarded-proto") ?? "https";
  const host = header(headers, "host") ?? event.requestContext?.domainName;
  const search = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const base = `${proto}://${host}`;

  // The URL as delivered (API Gateway hands the path percent-decoded) and
  // the URL the client signed, re-encoded from the decoded segments.
  const trailingSlash = rawPath.length > 1 && rawPath.endsWith("/");
  const segments = rawPath === "/" ? [] : rawPath.split("/").slice(1).map(decodeSegment);
  const ids = trailingSlash ? segments.slice(0, -1) : segments;
  const encodedPath = "/" + ids.map(encodeURIComponent).join("/") + (trailingSlash ? "/" : "");
  const urls = [...new Set([`${base}${rawPath}${search}`, `${base}${encodedPath}${search}`])];

  const authorization = header(headers, "authorization");
  const context = {
    signed: String(Boolean(authorization)),
    verified: "false",
    controller: "",
    delegated: "false",
    space: "",
    spaceController: "",
    spaceType: "",
  };

  const request = { method, host, headers: { ...headers, authorization } };

  if (ids[0] === "spaces") {
    const signer = authorization ? signerDid(authorization) : undefined;
    if (signer) {
      const result = await verifyInvocation(request, { controller: signer, urls });
      if (result) {
        context.verified = "true";
        context.controller = result.controller;
        context.delegated = String(result.delegated);
      }
    }
  } else if (ids[0] === "space" && ids[1]) {
    const space = await getSpace(`${base}/space/${ids[1]}`);
    if (!space) {
      context.space = "missing";
    } else {
      context.spaceController = space.controller;
      context.spaceType = JSON.stringify(space.type);
      if (authorization) {
        const spaceUrl = `${base}/space/${encodeURIComponent(ids[1])}/`;
        const roots = [rootCapabilityId(spaceUrl)];
        if (ids[2] !== undefined) {
          roots.push(rootCapabilityId(`${spaceUrl}${encodeURIComponent(ids[2])}/`));
        }
        const result = await verifyInvocation(request, { controller: space.controller, urls, roots });
        if (result) {
          context.verified = "true";
          context.controller = result.controller;
          context.delegated = String(result.delegated);
        }
      }
    }
  }

  return { isAuthorized: true, context };
};
