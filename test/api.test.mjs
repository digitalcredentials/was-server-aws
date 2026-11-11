// In-process tests of the API function against the WAS v0.5 behaviour the
// @interop/was-client (0.93+) relies on. S3 and DynamoDB are faked; every
// request is signed the way the client signs it.
//
//   cd test && npm test

// http-client first: @interop/jsonld requires it at load, and the ezcap
// imports below would otherwise reach jsonld before it is initialized.
import "@interop/http-client";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { installFakes } from "./fakes.mjs";
import { invoke, seedSpace, seedObject, controllerKey, strangerKey, BASE, asWebvh, mintWebvh, seedWebvhLog, bucketOf, clearWebvhCache } from "./harness.mjs";
import { deriveSpaceId } from "was-lib/webvh.mjs";
import { applyObjectEvent, readCounter, classifyKey } from "was-lib/feed.mjs";
import { sweepBucket, lambdaHandler as sweep } from "../src/feed/sweep/app.mjs";
import { lambdaHandler as feedConsumer } from "../src/feed/consumer/app.mjs";
import { updateDID, signerFromDidKeySigner, logToJsonlString } from "@interop/did-method-webvh";
import { ZcapClient } from "@interop/ezcap";
import { Ed25519Signature2020 } from "@interop/ed25519-signature";
import { EddsaJcs2022 } from "@interop/ed25519-signature/eddsa-jcs-2022";
import { rootCapabilityId } from "../src/authorizer/zcap.mjs";

const SPACE = "dcc-was-01011f5b-59ea-4e62-880e-d6ad666e361c";
const SPACE_URL = `${BASE}/space/${SPACE}/`;
const PROBLEM = "application/problem+json";

let fakes;
beforeEach(async () => {
  fakes = installFakes();
  clearWebvhCache();
  await seedSpace(fakes, { spaceId: SPACE });
  fakes.dynamo.tables["was-coupons"].set("open-sesame", { coupon: { S: "open-sesame" } });
  fakes.dynamo.tables["was-coupons"].set("one-shot", { coupon: { S: "one-shot" }, usesRemaining: { N: "1" } });
});

const objectKeys = () => fakes.s3.keys(SPACE);

// --- discovery ---------------------------------------------------------------

test("GET / serves the service description with the service link", async () => {
  const res = await invoke({ path: "/", signer: null });
  assert.equal(res.status, 200);
  assert.equal(res.headers.link, `<${BASE}/service>; rel="service"`);
  // The one read that may be cached without revalidation: the description
  // sets its own short lifetime instead of the no-cache every other read gets
  assert.equal(res.headers["cache-control"], "public, max-age=300");
  assert.equal(res.json.url, `${BASE}/service`);
  const entry = res.json.specs["https://w3id.org/pws"][0];
  assert.equal(entry.version, "0.5");
  assert.equal(entry.spaces, `${BASE}/spaces/`);
  assert.ok(entry.features.includes("listing"));
});

test("GET /service serves the same description, where a base-URL client reads it", async () => {
  const res = await invoke({ path: "/service", signer: null });
  assert.equal(res.status, 200);
  assert.equal(res.headers.link, `<${BASE}/service>; rel="service"`);
  assert.equal(res.json.url, `${BASE}/service`);
  assert.deepEqual(res.json, (await invoke({ path: "/", signer: null })).json);
  const head = await invoke({ method: "HEAD", path: "/service", signer: null });
  assert.equal(head.status, 200);
  assert.equal(head.body, "");
});

test("HEAD / carries the link and no body", async () => {
  const res = await invoke({ method: "HEAD", path: "/", signer: null });
  assert.equal(res.status, 200);
  assert.equal(res.headers.link, `<${BASE}/service>; rel="service"`);
  assert.equal(res.body, "");
});

test("an unknown path below a resource is a problem+json 404 that still carries the link", async () => {
  const res = await invoke({ path: `/space/${SPACE}/c/r/nothing/here`, signer: null });
  assert.equal(res.status, 404);
  assert.equal(res.headers["content-type"], PROBLEM);
  assert.equal(res.json.type, "https://w3id.org/pws#not-found");
  assert.ok(res.headers.link);
  // Outside every route the gateway answers its own 404.
  const outside = await invoke({ path: "/nothing/here", signer: null });
  assert.equal(outside.status, 404);
  assert.equal(outside.fn, null);
});

// --- spaces repository ---------------------------------------------------------

test("POST /spaces/ provisions a Space for the stated controller", async () => {
  const res = await invoke({
    method: "POST",
    path: "/spaces/",
    json: { controller: controllerKey.controller, name: "Home", coupon: "open-sesame" },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.match(res.headers.location, /^http:\/\/localhost:3000\/space\/dcc-was-[0-9a-f-]{36}\/$/);
  assert.ok(res.headers.etag);
  assert.deepEqual(res.json.type, ["Space"]);
  assert.equal(res.json.name, "Home");
  assert.equal(res.json.controller, controllerKey.controller);
  const id = res.json.id;
  assert.ok(fakes.s3.buckets.has(id));
  assert.ok(fakes.s3.buckets.get(id).has("meta/space.json"));
  const row = fakes.dynamo.tables["was-spaces"].get(`${BASE}/space/${id}`);
  assert.equal(row.did.S, controllerKey.controller);
  assert.deepEqual(row.type.L, [{ S: "Space" }]);
});

test("POST /spaces/ keeps a typed Space's type array", async () => {
  const res = await invoke({
    method: "POST",
    path: "/spaces/",
    json: { controller: controllerKey.controller, type: ["Space", "BatchSpace"], coupon: "one-shot" },
  });
  assert.equal(res.status, 201);
  assert.deepEqual(res.json.type, ["Space", "BatchSpace"]);
  // The finite coupon is spent.
  const again = await invoke({
    method: "POST",
    path: "/spaces/",
    json: { controller: controllerKey.controller, coupon: "one-shot" },
  });
  assert.equal(again.status, 403);
});

test("POST /spaces/ refuses a request not signed by the stated controller", async () => {
  const res = await invoke({
    method: "POST",
    path: "/spaces/",
    json: { controller: strangerKey.controller, coupon: "open-sesame" },
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.type, "https://w3id.org/pws#invalid-request-body");
});

test("POST /spaces/ validates the body", async () => {
  const noController = await invoke({ method: "POST", path: "/spaces/", json: { coupon: "open-sesame" } });
  assert.equal(noController.status, 400);
  const badType = await invoke({
    method: "POST",
    path: "/spaces/",
    json: { controller: controllerKey.controller, type: ["Other"], coupon: "open-sesame" },
  });
  assert.equal(badType.status, 400);
  const clientId = await invoke({
    method: "POST",
    path: "/spaces/",
    json: { controller: controllerKey.controller, id: "mine", coupon: "open-sesame" },
  });
  assert.equal(clientId.status, 400);
});

test("GET /spaces/ lists the signer's Spaces and pages them", async () => {
  await seedSpace(fakes, { spaceId: "dcc-was-00000000-0000-4000-8000-000000000002", name: "Second" });
  await seedSpace(fakes, { spaceId: "dcc-was-00000000-0000-4000-8000-000000000003", controller: strangerKey.controller });
  const res = await invoke({ path: "/spaces/" });
  assert.equal(res.status, 200);
  assert.equal(res.json.totalItems, 2);
  assert.deepEqual(res.json.items.map((item) => item.name).sort(), ["Second", "Test Space"]);
  assert.ok(res.json.items.every((item) => item.url.endsWith("/") && Array.isArray(item.type)));

  const first = await invoke({ path: "/spaces/?limit=1" });
  assert.equal(first.json.items.length, 1);
  assert.ok(first.json.next.startsWith(`${BASE}/spaces/?cursor=`));
  const second = await invoke({ path: first.json.next.slice(BASE.length) });
  assert.equal(second.json.items.length, 1);
  assert.equal(second.json.next, undefined);
  assert.notEqual(first.json.items[0].id, second.json.items[0].id);
});

test("HEAD /spaces/ carries the service link, signed or not", async () => {
  const unsigned = await invoke({ method: "HEAD", path: "/spaces/", signer: null });
  assert.equal(unsigned.status, 200);
  assert.equal(unsigned.headers.link, `<${BASE}/service>; rel="service"`);
  assert.equal(unsigned.body, "");
  const signed = await invoke({ method: "HEAD", path: "/spaces/" });
  assert.equal(signed.status, 200);
  assert.equal(signed.headers.link, `<${BASE}/service>; rel="service"`);
});

test("GET /spaces/ answers an empty list to an unsigned or badly signed caller", async () => {
  const unsigned = await invoke({ path: "/spaces/", signer: null });
  assert.equal(unsigned.status, 200);
  assert.deepEqual(unsigned.json.items, []);
  const tampered = await invoke({ path: "/spaces/", tamper: true });
  assert.equal(tampered.status, 200);
  assert.deepEqual(tampered.json.items, []);
});

// --- space ---------------------------------------------------------------------

test("the bare Space URL redirects to its trailing-slash form", async () => {
  const res = await invoke({ path: `/space/${SPACE}` });
  assert.equal(res.status, 308);
  assert.equal(res.headers.location, SPACE_URL);
});

test("GET /space/{s}/meta returns the Space Metadata with an ETag", async () => {
  const res = await invoke({ path: `/space/${SPACE}/meta` });
  assert.equal(res.status, 200);
  assert.ok(res.headers.etag);
  assert.equal(res.headers["cache-control"], "no-cache");
  assert.equal(res.json.id, SPACE);
  assert.equal(res.json.url, SPACE_URL);
  assert.equal(res.json.controller, controllerKey.controller);
  assert.deepEqual(res.json.type, ["Space"]);
});

test("PUT /space/{s}/meta renames the Space under If-Match and mirrors the name to the registry", async () => {
  const current = await invoke({ path: `/space/${SPACE}/meta` });
  const res = await invoke({
    method: "PUT",
    path: `/space/${SPACE}/meta`,
    json: { id: SPACE, name: "Renamed", controller: controllerKey.controller },
    headers: { "if-match": current.headers.etag },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.name, "Renamed");
  assert.ok(res.headers.etag && res.headers.etag !== current.headers.etag);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(fakes.dynamo.tables["was-spaces"].get(`${BASE}/space/${SPACE}`).name.S, "Renamed");

  const stale = await invoke({
    method: "PUT",
    path: `/space/${SPACE}/meta`,
    json: { name: "Again", controller: controllerKey.controller },
    headers: { "if-match": current.headers.etag },
  });
  assert.equal(stale.status, 412);
  assert.equal(stale.json.type, "https://w3id.org/pws#precondition-failed");
});

test("PUT /space/{s}/meta refuses a controller change and a type change", async () => {
  const controller = await invoke({
    method: "PUT",
    path: `/space/${SPACE}/meta`,
    json: { name: "x", controller: strangerKey.controller },
  });
  assert.equal(controller.status, 400);
  assert.equal(controller.json.type, "https://w3id.org/pws#controller-mismatch");
  const type = await invoke({
    method: "PUT",
    path: `/space/${SPACE}/meta`,
    json: { name: "x", controller: controllerKey.controller, type: ["Space", "Other"] },
  });
  assert.equal(type.status, 400);
});

test("unimplemented reserved endpoints answer 405", async () => {
  for (const path of [`/space/${SPACE}/linkset`, `/space/${SPACE}/quotas`, `/space/${SPACE}/c/r/chunks/0`]) {
    const res = await invoke({ path });
    assert.equal(res.status, 405, path);
  }
});

// --- collections -----------------------------------------------------------------

test("POST /space/{s}/ creates a Collection and lists it", async () => {
  const res = await invoke({
    method: "POST",
    path: `/space/${SPACE}/`,
    json: { id: "vault", name: "Vault", encryption: { scheme: "edv" } },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.equal(res.headers.location, `${SPACE_URL}vault/`);
  assert.ok(res.headers.etag);
  assert.equal(res.json.id, "vault");
  assert.deepEqual(res.json.type, ["Collection"]);
  assert.deepEqual(res.json.encryption, { scheme: "edv" });
  assert.equal(res.json.createdBy, controllerKey.controller);
  assert.ok(res.json.createdAt);

  const list = await invoke({ path: `/space/${SPACE}/` });
  assert.equal(list.status, 200);
  assert.equal(list.json.url, SPACE_URL);
  assert.deepEqual(list.json.items.map((item) => item.id), ["vault"]);
  assert.equal(list.json.items[0].url, `${SPACE_URL}vault/`);
  assert.equal(list.json.items[0].name, "Vault");

  const dup = await invoke({ method: "POST", path: `/space/${SPACE}/`, json: { id: "vault" } });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.type, "https://w3id.org/pws#id-conflict");
});

test("POST /space/{s}/ assigns an id when none is given, and refuses reserved or malformed ids", async () => {
  const assigned = await invoke({ method: "POST", path: `/space/${SPACE}/`, json: { name: "Anon" } });
  assert.equal(assigned.status, 201);
  assert.match(assigned.json.id, /^[0-9a-f-]{36}$/);
  const reserved = await invoke({ method: "POST", path: `/space/${SPACE}/`, json: { id: "meta" } });
  assert.equal(reserved.status, 409);
  assert.equal(reserved.json.type, "https://w3id.org/pws#reserved-id");
  const malformed = await invoke({ method: "POST", path: `/space/${SPACE}/`, json: { id: "a/b" } });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.json.type, "https://w3id.org/pws#invalid-id");
});

test("the Collection listing includes implicit collections and pages", async () => {
  await invoke({ method: "POST", path: `/space/${SPACE}/`, json: { id: "alpha" } });
  await invoke({ method: "POST", path: `/space/${SPACE}/`, json: { id: "beta" } });
  // Written straight into the bucket by another service, with no metadata.
  await seedObject(fakes, SPACE, "collections/logs/log.json", { entries: [] });
  const page1 = await invoke({ path: `/space/${SPACE}/?limit=2` });
  assert.deepEqual(page1.json.items.map((item) => item.id), ["alpha", "beta"]);
  assert.ok(page1.json.next);
  const page2 = await invoke({ path: page1.json.next.slice(BASE.length) });
  assert.deepEqual(page2.json.items.map((item) => item.id), ["logs"]);
  assert.equal(page2.json.items[0].name, "logs");
  assert.equal(page2.json.next, undefined);
});

test("the bare Collection URL redirects to its trailing-slash form", async () => {
  const res = await invoke({ path: `/space/${SPACE}/vault` });
  assert.equal(res.status, 308);
  assert.equal(res.headers.location, `${SPACE_URL}vault/`);
});

test("Collection Metadata: GET, replace under If-Match, create with If-None-Match", async () => {
  await invoke({ method: "POST", path: `/space/${SPACE}/`, json: { id: "vault", name: "Vault" } });
  const read = await invoke({ path: `/space/${SPACE}/vault/meta` });
  assert.equal(read.status, 200);
  assert.equal(read.json.name, "Vault");
  assert.ok(read.headers.etag);

  const replaced = await invoke({
    method: "PUT",
    path: `/space/${SPACE}/vault/meta`,
    json: {
      id: "vault",
      name: "Vault 2",
      custom: { name: "My vault" },
      encryption: {
        scheme: "edv",
        currentEpoch: "e1",
        epochs: [{ id: "e1", recipients: [{ header: { kid: "did:key:z6MkReader#z6LSReader", alg: "ECDH-ES+A256KW" }, encrypted_key: "AAAA" }] }],
      },
    },
    headers: { "if-match": read.headers.etag },
  });
  assert.equal(replaced.status, 200, JSON.stringify(replaced.json));
  assert.equal(replaced.json.name, "Vault 2");
  assert.deepEqual(replaced.json.custom, { name: "My vault" });
  assert.equal(replaced.json.encryption.currentEpoch, "e1");
  assert.equal(replaced.json.createdAt, read.json.createdAt);
  assert.ok(replaced.headers.etag !== read.headers.etag);

  const stale = await invoke({
    method: "PUT",
    path: `/space/${SPACE}/vault/meta`,
    json: { name: "x" },
    headers: { "if-match": read.headers.etag },
  });
  assert.equal(stale.status, 412);

  const created = await invoke({
    method: "PUT",
    path: `/space/${SPACE}/fresh/meta`,
    json: { id: "fresh", name: "Fresh" },
    headers: { "if-none-match": "*" },
  });
  assert.equal(created.status, 201);
  const again = await invoke({
    method: "PUT",
    path: `/space/${SPACE}/fresh/meta`,
    json: { name: "Fresh" },
    headers: { "if-none-match": "*" },
  });
  assert.equal(again.status, 412);

  const missing = await invoke({ path: `/space/${SPACE}/absent/meta` });
  assert.equal(missing.status, 404);
});

test("an implicit Collection has readable, unversioned metadata", async () => {
  await seedObject(fakes, SPACE, "collections/logs/log.json", { entries: [] });
  const res = await invoke({ path: `/space/${SPACE}/logs/meta` });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.type, ["Collection"]);
  assert.equal(res.headers.etag, undefined);
});

test("DELETE /space/{s}/{c}/ removes the Collection, its content, metadata and policies", async () => {
  await invoke({ method: "POST", path: `/space/${SPACE}/`, json: { id: "vault" } });
  await invoke({ method: "PUT", path: `/space/${SPACE}/vault/doc`, json: { a: 1 } });
  await invoke({ method: "PUT", path: `/space/${SPACE}/vault/doc/meta`, json: { custom: { name: "n" } } });
  await invoke({ method: "PUT", path: `/space/${SPACE}/vault/policy`, json: { type: "PublicCanRead" } });
  const res = await invoke({ method: "DELETE", path: `/space/${SPACE}/vault/` });
  assert.equal(res.status, 204);
  assert.deepEqual(objectKeys(), ["meta/space.json"]);
  const gone = await invoke({ method: "DELETE", path: `/space/${SPACE}/vault/` });
  assert.equal(gone.status, 404);
});

// --- resources -------------------------------------------------------------------

test("PUT creates then updates a Resource with validators and the spec's status codes", async () => {
  const created = await invoke({ method: "PUT", path: `/space/${SPACE}/docs/one`, json: { v: 1 }, headers: { "key-epoch": "e1" } });
  assert.equal(created.status, 201, created.body);
  assert.equal(created.headers.location, `${SPACE_URL}docs/one`);
  assert.ok(created.headers.etag);
  assert.equal(created.headers["content-type"], undefined);
  assert.equal(created.body, "");
  // A first write into a new collection gives it metadata.
  assert.ok(objectKeys().includes("meta/docs.json"));

  const updated = await invoke({ method: "PUT", path: `/space/${SPACE}/docs/one`, json: { v: 2 }, headers: { "if-match": created.headers.etag } });
  assert.equal(updated.status, 204);
  assert.ok(updated.headers.etag && updated.headers.etag !== created.headers.etag);

  const stale = await invoke({ method: "PUT", path: `/space/${SPACE}/docs/one`, json: { v: 3 }, headers: { "if-match": created.headers.etag } });
  assert.equal(stale.status, 412);
  const insert = await invoke({ method: "PUT", path: `/space/${SPACE}/docs/one`, json: { v: 3 }, headers: { "if-none-match": "*" } });
  assert.equal(insert.status, 412);

  const read = await invoke({ path: `/space/${SPACE}/docs/one` });
  assert.equal(read.status, 200);
  assert.deepEqual(read.json, { v: 2 });
  assert.equal(read.headers.etag, updated.headers.etag);
  assert.equal(read.headers["content-type"], "application/json");
  assert.ok(read.headers["last-modified"]);
  // A read with Last-Modified and no Cache-Control would be heuristically
  // cached by browsers; the server requires revalidation instead
  assert.equal(read.headers["cache-control"], "no-cache");

  const cached = await invoke({ path: `/space/${SPACE}/docs/one`, headers: { "if-none-match": updated.headers.etag } });
  assert.equal(cached.status, 304);
  assert.equal(cached.body, "");
  assert.equal(cached.headers["cache-control"], "no-cache");

  const head = await invoke({ method: "HEAD", path: `/space/${SPACE}/docs/one` });
  assert.equal(head.status, 200);
  assert.equal(head.body, "");
  assert.equal(head.headers.etag, updated.headers.etag);
});

test("a Resource write needs a signature and a Digest that matches the body", async () => {
  const unsigned = await invoke({ method: "PUT", path: `/space/${SPACE}/docs/one`, json: { v: 1 }, signer: null });
  assert.equal(unsigned.status, 401);
  assert.equal(unsigned.json.type, "https://w3id.org/pws#missing-authorization");
  // Signed over one body, delivered with another.
  const signed = await invoke({ method: "PUT", path: `/space/${SPACE}/docs/one`, json: { v: 1 }, deliveredJson: { v: 2 } });
  assert.equal(signed.status, 400);
  assert.equal(signed.json.type, "https://w3id.org/pws#invalid-authorization-header");
});

test("POST /space/{s}/{c}/ creates a Resource with a server-assigned id", async () => {
  const res = await invoke({ method: "POST", path: `/space/${SPACE}/docs/`, json: { hello: "world" } });
  assert.equal(res.status, 201, res.body);
  assert.match(res.json.id, /^[0-9a-f-]{36}$/);
  assert.equal(res.headers.location, `${SPACE_URL}docs/${res.json.id}`);
  assert.equal(res.json.url, res.headers.location);
  assert.ok(res.headers.etag);
  const read = await invoke({ path: `/space/${SPACE}/docs/${res.json.id}` });
  assert.deepEqual(read.json, { hello: "world" });
});

test("binary content round-trips base64-encoded", async () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
  const put = await invoke({ method: "PUT", path: `/space/${SPACE}/files/pic.png`, body: bytes, contentType: "image/png" });
  assert.equal(put.status, 201, put.body);
  const read = await invoke({ path: `/space/${SPACE}/files/pic.png` });
  assert.equal(read.status, 200);
  assert.equal(read.headers["content-type"], "image/png");
  assert.equal(read.isBase64Encoded, true);
  assert.deepEqual(Buffer.from(read.body, "base64"), bytes);
});

test("the Resource listing pages and carries the stamps", async () => {
  await invoke({ method: "PUT", path: `/space/${SPACE}/docs/a`, json: { v: 1 }, headers: { "key-epoch": "e1" } });
  await invoke({ method: "PUT", path: `/space/${SPACE}/docs/b`, json: { v: 2 } });
  await invoke({ method: "PUT", path: `/space/${SPACE}/docs/c`, json: { v: 3 } });
  const page1 = await invoke({ path: `/space/${SPACE}/docs/?limit=2` });
  assert.equal(page1.status, 200);
  assert.equal(page1.json.id, "docs");
  assert.equal(page1.json.url, `${SPACE_URL}docs/`);
  assert.deepEqual(page1.json.type, ["Collection"]);
  assert.deepEqual(page1.json.items.map((item) => item.id), ["a", "b"]);
  assert.equal(page1.json.items[0].epoch, "e1");
  assert.equal(page1.json.items[0].contentType, "application/json");
  assert.equal(page1.json.items[0].url, `${SPACE_URL}docs/a`);
  assert.ok(page1.json.next.startsWith(`${SPACE_URL}docs/?cursor=`));
  const page2 = await invoke({ path: page1.json.next.slice(BASE.length) });
  assert.deepEqual(page2.json.items.map((item) => item.id), ["c"]);
  assert.equal(page2.json.next, undefined);
  const bad = await invoke({ path: `/space/${SPACE}/docs/?cursor=%%%` });
  assert.equal(bad.status, 400);
});

test("DELETE removes a Resource permanently, with its metadata and policy", async () => {
  await invoke({ method: "PUT", path: `/space/${SPACE}/docs/one`, json: { v: 1 } });
  await invoke({ method: "PUT", path: `/space/${SPACE}/docs/one/meta`, json: { custom: { name: "n" } } });
  await invoke({ method: "PUT", path: `/space/${SPACE}/docs/one/policy`, json: { type: "PublicCanRead" } });
  const res = await invoke({ method: "DELETE", path: `/space/${SPACE}/docs/one` });
  assert.equal(res.status, 204);
  assert.deepEqual(objectKeys().filter((key) => key.includes("one")), []);
  const again = await invoke({ method: "DELETE", path: `/space/${SPACE}/docs/one` });
  assert.equal(again.status, 404);

  await invoke({ method: "PUT", path: `/space/${SPACE}/docs/two`, json: { v: 1 } });
  const guarded = await invoke({ method: "DELETE", path: `/space/${SPACE}/docs/two`, headers: { "if-match": '"nope"' } });
  assert.equal(guarded.status, 412);
});

test("percent-encoded resource ids verify and round-trip", async () => {
  const id = "Sushi-Chef%2C-Digital%20Credentials.json";
  const put = await invoke({ method: "PUT", path: `/space/${SPACE}/docs/${id}`, json: { ok: true } });
  assert.equal(put.status, 201, put.body);
  assert.equal(put.headers.location, `${SPACE_URL}docs/${id}`);
  assert.ok(objectKeys().includes("collections/docs/Sushi-Chef,-Digital Credentials.json"));
  const read = await invoke({ path: `/space/${SPACE}/docs/${id}` });
  assert.deepEqual(read.json, { ok: true });
});

// --- resource metadata -----------------------------------------------------------

test("Resource Metadata derives from the content and takes a custom annotation", async () => {
  await invoke({ method: "PUT", path: `/space/${SPACE}/docs/one`, json: { v: 1 }, headers: { "key-epoch": "e1", "writer-id": "me" } });
  const derived = await invoke({ path: `/space/${SPACE}/docs/one/meta` });
  assert.equal(derived.status, 200);
  assert.equal(derived.json.contentType, "application/json");
  assert.equal(derived.json.size, 7);
  assert.equal(derived.json.epoch, "e1");
  assert.equal(derived.json.writerId, "me");
  assert.equal(derived.json.createdBy, controllerKey.controller);
  assert.ok(derived.json.createdAt && derived.json.updatedAt);
  assert.equal(derived.headers.etag, undefined);

  const created = await invoke({
    method: "PUT",
    path: `/space/${SPACE}/docs/one/meta`,
    json: { custom: { name: "A note", tags: { k: "v" } } },
    headers: { "if-none-match": "*" },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.ok(created.headers.etag);
  assert.deepEqual(created.json.custom, { name: "A note", tags: { k: "v" } });
  assert.equal(created.json.contentType, "application/json");

  const read = await invoke({ path: `/space/${SPACE}/docs/one/meta` });
  assert.equal(read.headers.etag, created.headers.etag);
  const replaced = await invoke({
    method: "PUT",
    path: `/space/${SPACE}/docs/one/meta`,
    json: { custom: { name: "B" } },
    headers: { "if-match": created.headers.etag },
  });
  assert.equal(replaced.status, 200);
  const missing = await invoke({ path: `/space/${SPACE}/docs/absent/meta` });
  assert.equal(missing.status, 404);
});

// --- policies and public reads ---------------------------------------------------

test("policies are versioned and PublicCanRead opens unsigned reads at the covered scope", async () => {
  await invoke({ method: "PUT", path: `/space/${SPACE}/docs/one`, json: { v: 1 } });
  const hidden = await invoke({ path: `/space/${SPACE}/docs/one`, signer: null });
  assert.equal(hidden.status, 404);

  const set = await invoke({ method: "PUT", path: `/space/${SPACE}/docs/one/policy`, json: { type: "PublicCanRead" } });
  assert.equal(set.status, 201);
  assert.ok(set.headers.etag);
  const get = await invoke({ path: `/space/${SPACE}/docs/one/policy` });
  assert.deepEqual(get.json, { type: "PublicCanRead" });
  assert.equal(get.headers.etag, set.headers.etag);

  const open = await invoke({ path: `/space/${SPACE}/docs/one`, signer: null });
  assert.equal(open.status, 200);
  assert.deepEqual(open.json, { v: 1 });
  // The policy covers the resource, not its siblings or the listing.
  await invoke({ method: "PUT", path: `/space/${SPACE}/docs/two`, json: { v: 2 } });
  assert.equal((await invoke({ path: `/space/${SPACE}/docs/two`, signer: null })).status, 404);
  const listing = await invoke({ path: `/space/${SPACE}/docs/`, signer: null });
  assert.equal(listing.status, 200);
  assert.deepEqual(listing.json.items, []);
  // Never the policy itself, never a write.
  assert.equal((await invoke({ path: `/space/${SPACE}/docs/one/policy`, signer: null })).status, 404);
  assert.equal((await invoke({ method: "PUT", path: `/space/${SPACE}/docs/one`, json: { v: 9 }, signer: null })).status, 401);

  const cleared = await invoke({ method: "DELETE", path: `/space/${SPACE}/docs/one/policy` });
  assert.equal(cleared.status, 204);
  assert.equal((await invoke({ path: `/space/${SPACE}/docs/one`, signer: null })).status, 404);

  // A collection-scoped policy covers the listing and every member.
  await invoke({ method: "PUT", path: `/space/${SPACE}/docs/policy`, json: { type: "PublicCanRead" } });
  assert.equal((await invoke({ path: `/space/${SPACE}/docs/two`, signer: null })).status, 200);
  const publicList = await invoke({ path: `/space/${SPACE}/docs/`, signer: null });
  assert.equal(publicList.json.items.length, 2);
});

// --- authorization ---------------------------------------------------------------

test("requests to an unregistered Space, by a stranger, or with a tampered signature are 404", async () => {
  const unregistered = await invoke({ path: `/space/dcc-was-00000000-0000-4000-8000-000000000009/meta` });
  assert.equal(unregistered.status, 404);
  const stranger = await invoke({ path: `/space/${SPACE}/meta`, signer: strangerKey });
  assert.equal(stranger.status, 404);
  const tampered = await invoke({ path: `/space/${SPACE}/meta`, tamper: true });
  assert.equal(tampered.status, 404);
  const strangerWrite = await invoke({ method: "PUT", path: `/space/${SPACE}/docs/one`, json: { v: 1 }, signer: strangerKey });
  assert.equal(strangerWrite.status, 404);
  // A listing answers empty rather than 404.
  const listing = await invoke({ path: `/space/${SPACE}/`, signer: strangerKey });
  assert.equal(listing.status, 200);
  assert.deepEqual(listing.json.items, []);
});

test("DELETE /space/{s}/ removes the bucket and the registry row", async () => {
  await invoke({ method: "PUT", path: `/space/${SPACE}/docs/one`, json: { v: 1 } });
  const res = await invoke({ method: "DELETE", path: `/space/${SPACE}/` });
  assert.equal(res.status, 204);
  assert.equal(fakes.s3.buckets.has(SPACE), false);
  assert.equal(fakes.dynamo.tables["was-spaces"].has(`${BASE}/space/${SPACE}`), false);
  const after = await invoke({ path: `/space/${SPACE}/meta` });
  assert.equal(after.status, 404);
});

// --- did:webvh controllers ---------------------------------------------------

const ACCOUNT = "dcc-was-0000aaaa-0000-4000-8000-0000000000ab";

test("a did:webvh-controlled Space authorizes the keys its current document lists", async () => {
  const account = await mintWebvh({ path: ACCOUNT });
  await seedSpace(fakes, { spaceId: ACCOUNT, controller: account.did });
  await seedWebvhLog(fakes, ACCOUNT, account.jsonl);

  // The key, signing as its verification method in the document
  const ok = await invoke({ path: `/space/${ACCOUNT}/meta`, signer: asWebvh(controllerKey, account.did) });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.controller, account.did);

  // The same key under its did:key name is not the controller
  const asKey = await invoke({ path: `/space/${ACCOUNT}/meta`, signer: controllerKey });
  assert.equal(asKey.status, 404);

  // A key the document does not list, signing under the account's name
  const stranger = await invoke({ path: `/space/${ACCOUNT}/meta`, signer: asWebvh(strangerKey, account.did) });
  assert.equal(stranger.status, 404);

  // Writes work the same way
  const put = await invoke({
    method: "PUT",
    path: `/space/${ACCOUNT}/notes/one`,
    json: { v: 1 },
    signer: asWebvh(controllerKey, account.did),
  });
  assert.equal(put.status, 201);
});

test("a key added to the document is accepted before the cache expires", async () => {
  const account = await mintWebvh({ path: ACCOUNT });
  await seedSpace(fakes, { spaceId: ACCOUNT, controller: account.did });
  await seedWebvhLog(fakes, ACCOUNT, account.jsonl);
  // The first request caches the one-key document
  const first = await invoke({ path: `/space/${ACCOUNT}/meta`, signer: asWebvh(controllerKey, account.did) });
  assert.equal(first.status, 200);
  // A second key joins the same log (a new credential); the cache still
  // holds the old document, and the new key is accepted at once
  const added = strangerKey.fingerprint();
  const members = [controllerKey.fingerprint(), added];
  const grown = await updateDID({
    log: account.log,
    signer: signerFromDidKeySigner(controllerKey.signer()),
    updateKeys: [`did:key:${controllerKey.fingerprint()}`],
    verificationMethods: members.map((publicKeyMultibase) => ({ type: "Multikey", publicKeyMultibase })),
    vmIdFragment: "multibase",
    authentication: members.map((m) => `#${m}`),
    assertionMethod: members.map((m) => `#${m}`),
    capabilityInvocation: members.map((m) => `#${m}`),
    capabilityDelegation: members.map((m) => `#${m}`),
  });
  await seedObject(fakes, bucketOf(ACCOUNT), "collections/id/did.jsonl", logToJsonlString(grown.log), "text/jsonl");
  const asNew = await invoke({ path: `/space/${ACCOUNT}/meta`, signer: asWebvh(strangerKey, account.did) });
  assert.equal(asNew.status, 200, JSON.stringify(asNew.json));
});

test("a did:webvh whose log is hosted elsewhere is fetched over HTTPS", async () => {
  const account = await mintWebvh({ domain: "elsewhere.test", path: "alice" });
  await seedSpace(fakes, { spaceId: ACCOUNT, controller: account.did });
  const requested = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    return new Response(account.jsonl, { status: 200, headers: { "content-type": "text/jsonl" } });
  };
  try {
    const res = await invoke({ path: `/space/${ACCOUNT}/meta`, signer: asWebvh(controllerKey, account.did) });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.deepEqual(requested, ["https://elsewhere.test/alice/did.jsonl"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a Space whose did:webvh log is missing refuses every signed request", async () => {
  const account = await mintWebvh({ path: ACCOUNT });
  await seedSpace(fakes, { spaceId: ACCOUNT, controller: account.did });
  const res = await invoke({ path: `/space/${ACCOUNT}/meta`, signer: asWebvh(controllerKey, account.did) });
  assert.equal(res.status, 404);
});

test("PUT /space/{s}/meta promotes a did:key controller to a did:webvh that lists the key", async () => {
  const account = await mintWebvh({ path: SPACE });
  await seedWebvhLog(fakes, SPACE, account.jsonl);
  const current = await invoke({ path: `/space/${SPACE}/meta` });

  const promoted = await invoke({
    method: "PUT",
    path: `/space/${SPACE}/meta`,
    json: { name: "Test Space", controller: account.did },
    headers: { "if-match": current.headers.etag },
  });
  assert.equal(promoted.status, 200, JSON.stringify(promoted.json));
  assert.equal(promoted.json.controller, account.did);
  assert.equal(promoted.json.createdBy, controllerKey.controller);
  assert.equal(fakes.dynamo.tables["was-spaces"].get(`${BASE}/space/${SPACE}`).did.S, account.did);

  // From now on the did:key form no longer invokes; the document's key does
  const asKey = await invoke({ path: `/space/${SPACE}/meta` });
  assert.equal(asKey.status, 404);
  const asAccount = await invoke({ path: `/space/${SPACE}/meta`, signer: asWebvh(controllerKey, account.did) });
  assert.equal(asAccount.status, 200);

  // And the controller cannot move again
  const again = await invoke({
    method: "PUT",
    path: `/space/${SPACE}/meta`,
    json: { name: "Test Space", controller: controllerKey.controller },
    headers: { "if-match": asAccount.headers.etag },
    signer: asWebvh(controllerKey, account.did),
  });
  assert.equal(again.status, 400);
  assert.equal(again.json.type, "https://w3id.org/pws#controller-mismatch");
});

test("PUT /space/{s}/meta refuses a promotion to a did:webvh that does not list the invoking key", async () => {
  const account = await mintWebvh({ key: strangerKey, path: SPACE });
  await seedWebvhLog(fakes, SPACE, account.jsonl);
  const current = await invoke({ path: `/space/${SPACE}/meta` });
  const res = await invoke({
    method: "PUT",
    path: `/space/${SPACE}/meta`,
    json: { name: "Test Space", controller: account.did },
    headers: { "if-match": current.headers.etag },
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.type, "https://w3id.org/pws#controller-mismatch");
  assert.equal(fakes.dynamo.tables["was-spaces"].get(`${BASE}/space/${SPACE}`).did.S, controllerKey.controller);
});

test("PUT /space/{s}/meta provisions an unlock Space whose id is derived from the signing DID", async () => {
  const id = deriveSpaceId(controllerKey.controller);
  const body = { name: "Unlock", controller: controllerKey.controller, type: ["AuxiliarySpace", "Space", "UnlockSpace"] };
  const created = await invoke({ method: "PUT", path: `/space/${id}/meta`, json: body, headers: { "if-none-match": "*" } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.id, id);
  assert.equal(created.json.controller, controllerKey.controller);
  assert.deepEqual(created.json.type, body.type);
  assert.ok(created.headers.etag);
  assert.ok(fakes.s3.buckets.has(bucketOf(id)));
  assert.notEqual(bucketOf(id), id);
  assert.match(bucketOf(id), /^dcc-was-[0-9a-f]{40}$/);
  const row = fakes.dynamo.tables["was-spaces"].get(`${BASE}/space/${id}`);
  assert.equal(row.did.S, controllerKey.controller);
  assert.deepEqual(row.type.L.map((entry) => entry.S), body.type);

  // It is an ordinary Space from here: readable, writable, re-configurable
  const read = await invoke({ path: `/space/${id}/meta` });
  assert.equal(read.status, 200);
  const record = await invoke({ method: "PUT", path: `/space/${id}/keyring/keyring.json`, json: { wrapped: "..." } });
  assert.equal(record.status, 201);
  assert.ok(fakes.s3.buckets.get(bucketOf(id)).has("collections/keyring/keyring.json"));
  const renamed = await invoke({
    method: "PUT",
    path: `/space/${id}/meta`,
    json: { ...body, name: "Passphrase" },
    headers: { "if-match": read.headers.etag },
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.json.name, "Passphrase");

  // And deletable, bucket and registry row alike
  const deleted = await invoke({ method: "DELETE", path: `/space/${id}/` });
  assert.equal(deleted.status, 204);
  assert.ok(!fakes.s3.buckets.has(bucketOf(id)));
  assert.ok(!fakes.dynamo.tables["was-spaces"].has(`${BASE}/space/${id}`));
});

test("self-provisioning is refused for any id not derived from the signer, and for a non-unlock type", async () => {
  const mine = deriveSpaceId(controllerKey.controller);
  const theirs = deriveSpaceId(strangerKey.controller);
  const unlock = ["AuxiliarySpace", "Space", "UnlockSpace"];

  // Someone else's unlock id
  const stolen = await invoke({
    method: "PUT",
    path: `/space/${theirs}/meta`,
    json: { name: "Unlock", controller: strangerKey.controller, type: unlock },
    headers: { "if-none-match": "*" },
  });
  assert.equal(stolen.status, 404);

  // A server-assigned-looking id nobody registered
  const unknown = await invoke({
    method: "PUT",
    path: `/space/dcc-was-00000000-0000-4000-8000-0000000000ff/meta`,
    json: { name: "Unlock", controller: controllerKey.controller, type: unlock },
    headers: { "if-none-match": "*" },
  });
  assert.equal(unknown.status, 404);

  // The derived id, but not an unlock Space
  const plain = await invoke({
    method: "PUT",
    path: `/space/${mine}/meta`,
    json: { name: "Mine", controller: controllerKey.controller },
    headers: { "if-none-match": "*" },
  });
  assert.equal(plain.status, 400);
  assert.ok(!fakes.s3.buckets.has(bucketOf(mine)));

  // Unsigned
  const unsigned = await invoke({
    method: "PUT",
    path: `/space/${mine}/meta`,
    json: { name: "Unlock", controller: controllerKey.controller, type: unlock },
    headers: { "if-none-match": "*" },
    signer: null,
  });
  assert.equal(unsigned.status, 404);
});

// --- delegated capabilities ----------------------------------------------------

// The controller delegates a capability on the whole Space to the stranger,
// under `SuiteClass`, allowing the actions given.
async function delegateSpace(SuiteClass, allowedActions = ["GET", "PUT", "DELETE"]) {
  const client = new ZcapClient({ SuiteClass, delegationSigner: controllerKey.signer() });
  return client.delegate({
    capability: rootCapabilityId(SPACE_URL),
    controller: strangerKey.controller,
    invocationTarget: SPACE_URL,
    allowedActions,
    expires: new Date(Date.now() + 24 * 3600 * 1000),
  });
}

test("a delegated capability authorizes Resource operations under either proof suite, and container operations stay root-only", async () => {
  for (const SuiteClass of [EddsaJcs2022, Ed25519Signature2020]) {
    const capability = await delegateSpace(SuiteClass);
    const path = `/space/${SPACE}/keyring/${SuiteClass.name}`;

    const created = await invoke({ method: "PUT", path, json: { v: 1 }, signer: strangerKey, capability });
    assert.equal(created.status, 201, `${SuiteClass.name}: ${created.body}`);
    const read = await invoke({ path, signer: strangerKey, capability });
    assert.equal(read.status, 200, `${SuiteClass.name}: ${read.body}`);
    assert.deepEqual(read.json, { v: 1 });
    const removed = await invoke({ method: "DELETE", path, signer: strangerKey, capability });
    assert.equal(removed.status, 204, `${SuiteClass.name}: ${removed.body}`);

    // The Space itself, its metadata and a Collection are container
    // operations: a delegated capability is refused with a 404
    const spaceGone = await invoke({ method: "DELETE", path: `/space/${SPACE}/`, signer: strangerKey, capability });
    assert.equal(spaceGone.status, 404);
    assert.ok(fakes.s3.buckets.has(bucketOf(SPACE)));
    const collectionGone = await invoke({ method: "DELETE", path: `/space/${SPACE}/keyring/`, signer: strangerKey, capability });
    assert.equal(collectionGone.status, 404);
  }
});

test("a delegated capability is refused for an action it does not allow, and without it the stranger is refused", async () => {
  const readOnly = await delegateSpace(EddsaJcs2022, ["GET"]);
  const write = await invoke({ method: "PUT", path: `/space/${SPACE}/keyring/record`, json: { v: 1 }, signer: strangerKey, capability: readOnly });
  assert.equal(write.status, 404);
  const bare = await invoke({ method: "PUT", path: `/space/${SPACE}/keyring/record`, json: { v: 1 }, signer: strangerKey });
  assert.equal(bare.status, 404);
  assert.ok(!objectKeys().some((key) => key.startsWith("keyring/")));
});

// --- export and import ---------------------------------------------------------

import { readSpaceArchive } from "@interop/space-archive";

const SPACE_B = "dcc-was-0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";

// A Space with two collections (one with metadata and a policy, one implicit),
// three resources (JSON and binary, one with an annotation and a policy) and
// a Space policy.
async function seedExportable(spaceId) {
  await seedObject(fakes, spaceId, "meta/notes.json", {
    id: "notes", type: ["Collection"], name: "Notes", createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
  });
  await seedObject(fakes, spaceId, "policies/notes.json", { type: "PublicCanRead" });
  await seedObject(fakes, spaceId, "collections/notes/one", { v: 1 }, "application/json", { "created-at": "2026-01-03T00:00:00.000Z", "key-epoch": "e1" });
  await seedObject(fakes, spaceId, "meta/notes/one.json", { custom: { name: "First" }, createdAt: "2026-01-03T00:00:00.000Z", updatedAt: "2026-01-03T00:00:00.000Z" });
  await seedObject(fakes, spaceId, "policies/notes/one.json", { type: "PublicCanRead" });
  await seedObject(fakes, spaceId, "collections/notes/two.json", { v: 2 }, "application/json");
  await seedObject(fakes, spaceId, "collections/pics/a.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]), "image/png");
  await seedObject(fakes, spaceId, "policies/space.json", { type: "PublicCanRead" });
}

async function archiveEntries(bytes) {
  const archive = await readSpaceArchive(new Uint8Array(bytes));
  const entries = new Map();
  for await (const entry of archive.entries) {
    entries.set(entry.name, entry.type === "file" ? Buffer.from(await entry.bytes()) : null);
  }
  await archive.close();
  return { archive, entries };
}

test("POST /space/{s}/export answers the Space as a Space archive", async () => {
  await seedExportable(SPACE);
  const res = await invoke({ method: "POST", path: `/space/${SPACE}/export` });
  assert.equal(res.status, 200, res.body);
  assert.equal(res.headers["content-type"], "application/x-tar");
  assert.ok(res.isBase64Encoded);
  const bytes = Buffer.from(res.body, "base64");
  const { archive, entries } = await archiveEntries(bytes);
  assert.equal(archive.spaceId, SPACE);
  assert.equal(archive.service.url, `${BASE}/service`);
  assert.ok(archive.service.specs["https://w3id.org/pws"][0].features.includes("export"));
  const names = [...entries.keys()];
  const dir = `space/${SPACE}/`;
  assert.ok(names.includes(`${dir}.space.meta.${SPACE}.json`));
  assert.ok(names.includes(`${dir}.space.policy.json`));
  assert.ok(names.includes(`${dir}notes/.collection.meta.notes.json`));
  assert.ok(names.includes(`${dir}notes/.collection.policy.json`));
  assert.ok(names.includes(`${dir}notes/r.one.application%2Fjson.json`));
  assert.ok(names.includes(`${dir}notes/.meta.one.json`));
  assert.ok(names.includes(`${dir}notes/.r.one.policy.json`));
  assert.ok(names.includes(`${dir}notes/r.two%2Ejson.application%2Fjson.json`));
  // The implicit collection is exported with a synthesized metadata object
  assert.ok(names.includes(`${dir}pics/.collection.meta.pics.json`));
  assert.ok(names.includes(`${dir}pics/r.a%2Epng.image%2Fpng.png`));
  assert.deepEqual(JSON.parse(entries.get(`${dir}notes/r.one.application%2Fjson.json`).toString()), { v: 1 });
  assert.deepEqual([...entries.get(`${dir}pics/r.a%2Epng.image%2Fpng.png`)], [0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
  const meta = JSON.parse(entries.get(`${dir}.space.meta.${SPACE}.json`).toString());
  assert.equal(meta.id, SPACE);
  assert.equal(meta.name, "Test Space");
  assert.equal(meta.url, undefined);
  const sidecar = JSON.parse(entries.get(`${dir}notes/.meta.one.json`).toString());
  assert.equal(sidecar.contentType, "application/json");
  assert.equal(sidecar.epoch, "e1");
  assert.deepEqual(sidecar.custom, { name: "First" });
  // An unchanged Space exports byte-identical archives
  const again = await invoke({ method: "POST", path: `/space/${SPACE}/export` });
  assert.equal(again.body, res.body);
});

test("export needs a capability: unsigned and strangers get 404, a delegated POST is allowed", async () => {
  await seedExportable(SPACE);
  assert.equal((await invoke({ method: "POST", path: `/space/${SPACE}/export`, signer: null })).status, 404);
  assert.equal((await invoke({ method: "POST", path: `/space/${SPACE}/export`, signer: strangerKey })).status, 404);
  const capability = await delegateSpace(EddsaJcs2022, ["POST"]);
  const delegated = await invoke({ method: "POST", path: `/space/${SPACE}/export`, signer: strangerKey, capability });
  assert.equal(delegated.status, 200, delegated.body);
});

test("POST /space/{s}/import merges an archive, skips what is held, and reports counts", async () => {
  await seedExportable(SPACE);
  const exported = await invoke({ method: "POST", path: `/space/${SPACE}/export` });
  const archive = Buffer.from(exported.body, "base64");

  await seedSpace(fakes, { spaceId: SPACE_B, name: "Other" });
  const imported = await invoke({ method: "POST", path: `/space/${SPACE_B}/import`, body: archive, contentType: "application/x-tar" });
  assert.equal(imported.status, 200, imported.body);
  assert.deepEqual(imported.json, {
    collectionsCreated: 2,
    collectionsSkipped: 0,
    resourcesCreated: 3,
    resourcesSkipped: 0,
    policiesCreated: 3,
    policiesSkipped: 0,
    logsCreated: 0,
    logsSkipped: 0,
    spaceMetadata: "restored",
    provenance: { verified: 0, unattested: 6, proofInvalid: 0, contentMismatch: 0, unknownSigner: 0 },
  });
  // The data landed and reads back through the API
  const one = await invoke({ path: `/space/${SPACE_B}/notes/one` });
  assert.deepEqual(one.json, { v: 1 });
  const oneMeta = await invoke({ path: `/space/${SPACE_B}/notes/one/meta` });
  assert.deepEqual(oneMeta.json.custom, { name: "First" });
  assert.equal(oneMeta.json.epoch, "e1");
  assert.equal(oneMeta.json.createdBy, undefined);
  const pic = await invoke({ path: `/space/${SPACE_B}/pics/a.png` });
  assert.equal(pic.status, 200);
  assert.ok(fakes.s3.keys(SPACE_B).includes("policies/notes/one.json"));
  // The name was restored and mirrored
  assert.equal((await invoke({ path: `/space/${SPACE_B}/meta` })).json.name, "Test Space");
  assert.equal(fakes.dynamo.tables["was-spaces"].get(`${BASE}/space/${SPACE_B}`).name.S, "Test Space");

  // A second import changes nothing
  const again = await invoke({ method: "POST", path: `/space/${SPACE_B}/import`, body: archive, contentType: "application/x-tar" });
  assert.equal(again.status, 200);
  assert.equal(again.json.collectionsCreated, 0);
  assert.equal(again.json.collectionsSkipped, 2);
  assert.equal(again.json.resourcesCreated, 0);
  assert.equal(again.json.resourcesSkipped, 3);
  assert.equal(again.json.policiesCreated, 0);
  assert.equal(again.json.policiesSkipped, 3);
});

test("import under a delegated capability leaves the Space Metadata alone; a type mismatch is refused", async () => {
  await seedExportable(SPACE);
  const archive = Buffer.from((await invoke({ method: "POST", path: `/space/${SPACE}/export` })).body, "base64");

  await seedSpace(fakes, { spaceId: SPACE_B, name: "Other" });
  // Delegated by the controller of B, which is the same key in these tests
  const client = new ZcapClient({ SuiteClass: EddsaJcs2022, delegationSigner: controllerKey.signer() });
  const capability = await client.delegate({
    capability: rootCapabilityId(`${BASE}/space/${SPACE_B}/`),
    controller: strangerKey.controller,
    invocationTarget: `${BASE}/space/${SPACE_B}/`,
    allowedActions: ["POST"],
    expires: new Date(Date.now() + 3600 * 1000),
  });
  const delegated = await invoke({ method: "POST", path: `/space/${SPACE_B}/import`, body: archive, contentType: "application/x-tar", signer: strangerKey, capability });
  assert.equal(delegated.status, 200, delegated.body);
  assert.equal(delegated.json.spaceMetadata, "skipped");
  assert.equal((await invoke({ path: `/space/${SPACE_B}/meta` })).json.name, "Other");

  const batch = "dcc-was-0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c";
  await seedSpace(fakes, { spaceId: batch, type: ["BatchSpace", "Space"] });
  const refused = await invoke({ method: "POST", path: `/space/${batch}/import`, body: archive, contentType: "application/x-tar" });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.type, "https://w3id.org/pws#invalid-import");
  assert.ok(!fakes.s3.keys(batch).some((key) => key.startsWith("collections/")));

  // A body that is not an archive, and a missing body
  const junk = await invoke({ method: "POST", path: `/space/${SPACE_B}/import`, body: Buffer.from("not a tar"), contentType: "application/x-tar" });
  assert.equal(junk.status, 400);
  const empty = await invoke({ method: "POST", path: `/space/${SPACE_B}/import` });
  assert.equal(empty.status, 400);
});

// --- governing history logs ----------------------------------------------------

const LOG_TYPE = "text/jsonl";
const logPath = (c) => `/space/${SPACE}/${c}/meta/log`;
const recipient = { header: { kid: "did:key:z6MkReader#z6LSReader", alg: "ECDH-ES+A256KW" }, encrypted_key: "AAAA" };
const descriptor = (ids, current, extra = {}) => ({
  type: "WasEpochConfiguration",
  scheme: "edv",
  epochs: ids.map((id) => ({ id, recipients: [recipient] })),
  currentEpoch: current,
  ...extra,
});
const entryLine = (n, state, parameters = {}) =>
  JSON.stringify({ versionId: `${n}-Qm${n}`, versionTime: "2026-11-11T00:00:00Z", parameters, state, proof: [] });
const genesisLine = (state) => entryLine(1, state, { method: "resource-log:0.1", scid: "QmScid" });
const putLog = (c, body, headers, signer) =>
  invoke({ method: "PUT", path: logPath(c), body, contentType: LOG_TYPE, headers, ...(signer !== undefined && { signer }) });

async function governedCollection(c = "gov") {
  await invoke({ method: "POST", path: `/space/${SPACE}/`, json: { id: c } });
  const created = await putLog(c, genesisLine(descriptor(["e1"], "e1")) + "\n", { "if-none-match": "*" });
  assert.equal(created.status, 204, created.body);
  return created.headers.etag;
}

test("PUT meta/log with If-None-Match: * declares the Collection governed and the descriptor is derived from the head", async () => {
  const etag = await governedCollection();
  assert.ok(etag);
  const meta = await invoke({ path: `/space/${SPACE}/gov/meta` });
  assert.equal(meta.status, 200);
  assert.deepEqual(meta.json.encryption, {
    ...descriptor(["e1"], "e1"),
    history: { method: "resource-log:0.1", resource: `${SPACE_URL}gov/meta/log` },
  });
  assert.equal(meta.json.revisions, undefined);
  // The stored object holds no copy of the derived member
  assert.equal(JSON.parse(fakes.s3.buckets.get(SPACE).get("meta/gov.json").body).encryption, undefined);
  // The log reads back verbatim, as JSON Lines with its own validator
  const log = await invoke({ path: logPath("gov") });
  assert.equal(log.status, 200);
  assert.equal(log.headers["content-type"], LOG_TYPE);
  assert.equal(log.headers.etag, etag);
  assert.equal(log.body, genesisLine(descriptor(["e1"], "e1")) + "\n");
  const cached = await invoke({ path: logPath("gov"), headers: { "if-none-match": etag } });
  assert.equal(cached.status, 304);
  // The listing carries the derived descriptor too
  const listing = await invoke({ path: `/space/${SPACE}/` });
  assert.equal(listing.json.items.find((item) => item.id === "gov").encryption.currentEpoch, "e1");
  // A second declaring create is refused: the log exists
  const again = await putLog("gov", genesisLine(descriptor(["e1"], "e1")), { "if-none-match": "*" });
  assert.equal(again.status, 412);
  assert.ok(await invoke({ path: "/service", signer: null }).then((res) => res.json.specs["https://w3id.org/pws/encrypted-collections"][0].features.includes("governed-history-logs")));
});

test("a log write needs the Collection, a precondition and a body that keeps the line contract", async () => {
  const missing = await putLog("nothing", genesisLine(descriptor(["e1"], "e1")), { "if-none-match": "*" });
  assert.equal(missing.status, 404);
  await invoke({ method: "POST", path: `/space/${SPACE}/`, json: { id: "gov" } });
  const bare = await putLog("gov", genesisLine(descriptor(["e1"], "e1")), {});
  assert.equal(bare.status, 400);
  const empty = await invoke({ method: "PUT", path: logPath("gov"), headers: { "if-none-match": "*" } });
  assert.equal(empty.status, 400);
  const notObject = await putLog("gov", "[1,2]\n", { "if-none-match": "*" });
  assert.equal(notObject.status, 400);
  assert.equal(notObject.json.type, "https://w3id.org/pws#invalid-request-body");
  const noState = await putLog("gov", JSON.stringify({ versionId: "1-x", parameters: {}, proof: [] }), { "if-none-match": "*" });
  assert.equal(noState.status, 400);
  const blank = await putLog("gov", genesisLine(descriptor(["e1"], "e1")) + "\n\n" + entryLine(2, descriptor(["e1"], "e1")), { "if-none-match": "*" });
  assert.equal(blank.status, 400);
  const badShape = await putLog("gov", genesisLine({ type: "WasEpochConfiguration", scheme: "edv", epochs: [] }), { "if-none-match": "*" });
  assert.equal(badShape.status, 400);
  // Nothing was written
  assert.equal((await invoke({ path: logPath("gov") })).status, 404);
});

test("an append carries the stored log verbatim plus exactly one line, under If-Match, keeping the epoch invariants", async () => {
  const etag = await governedCollection();
  const metaBefore = await invoke({ path: `/space/${SPACE}/gov/meta` });
  const first = genesisLine(descriptor(["e1"], "e1"));
  const rotated = entryLine(2, descriptor(["e1", "e2"], "e2"));

  const stale = await putLog("gov", `${first}\n${rotated}\n`, { "if-match": '"not-it"' });
  assert.equal(stale.status, 412);
  const rewritten = await putLog("gov", `${entryLine(1, descriptor(["e9"], "e9"), { method: "resource-log:0.1", scid: "Qm" })}\n${rotated}\n`, { "if-match": etag });
  assert.equal(rewritten.status, 412);
  const nothingNew = await putLog("gov", `${entryLine(1, descriptor(["e1"], "e1"), { method: "resource-log:0.1", scid: "QmOther" })}\n`, { "if-match": etag });
  assert.equal(nothingNew.status, 412, "a rewritten genesis is not an extension");
  const twoNew = await putLog("gov", `${first}\n${rotated}\n${entryLine(3, descriptor(["e1", "e2"], "e2"))}\n`, { "if-match": etag });
  assert.equal(twoNew.status, 400);
  const dropped = await putLog("gov", `${first}\n${entryLine(2, descriptor(["e2"], "e2"))}\n`, { "if-match": etag });
  assert.equal(dropped.status, 400, "a dropped epoch is a malformed write, as the reference server answers it");
  assert.equal(dropped.json.type, "https://w3id.org/pws#invalid-request-body");
  const unchanged = await putLog("gov", `${first}\n`, { "if-match": etag });
  assert.equal(unchanged.status, 204, "a byte-identical re-put is a no-op");
  assert.equal(unchanged.headers.etag, etag);
  const reserved = await putLog("gov", `${first}\n${entryLine(2, { ...descriptor(["e1", "e2"], "e2"), history: {} })}\n`, { "if-match": etag });
  assert.equal(reserved.status, 400, "history is reserved in a state");
  const backwards = await putLog("gov", `${first}\n${entryLine(2, descriptor(["e1", "e2"], "e1"))}\n`, { "if-match": etag });
  assert.equal(backwards.status, 204, "a new epoch that is not current is still an append");
  const etag2 = backwards.headers.etag;
  const reverted = await putLog("gov", `${first}\n${entryLine(2, descriptor(["e1", "e2"], "e1"))}\n${entryLine(3, descriptor(["e1", "e2", "e3"], "e3"))}\n${entryLine(4, descriptor(["e1", "e2", "e3"], "e1"))}\n`, { "if-match": etag2 });
  assert.equal(reverted.status, 400, "two lines at once");
  const forward = await putLog("gov", `${first}\n${entryLine(2, descriptor(["e1", "e2"], "e1"))}\n${entryLine(3, descriptor(["e1", "e2", "e3"], "e3"))}\n`, { "if-match": etag2 });
  assert.equal(forward.status, 204);
  const etag3 = forward.headers.etag;
  const moved = await putLog("gov", `${first}\n${entryLine(2, descriptor(["e1", "e2"], "e1"))}\n${entryLine(3, descriptor(["e1", "e2", "e3"], "e3"))}\n${entryLine(4, descriptor(["e1", "e2", "e3"], "e1"))}\n`, { "if-match": etag3 });
  assert.equal(moved.status, 400, "currentEpoch never moves backwards");
  const scheme = await putLog("gov", `${first}\n${entryLine(2, descriptor(["e1", "e2"], "e1"))}\n${entryLine(3, descriptor(["e1", "e2", "e3"], "e3"))}\n${entryLine(4, { ...descriptor(["e1", "e2", "e3"], "e3"), scheme: "other" })}\n`, { "if-match": etag3 });
  assert.equal(scheme.status, 409);

  const meta = await invoke({ path: `/space/${SPACE}/gov/meta` });
  assert.equal(meta.json.encryption.currentEpoch, "e3");
  assert.notEqual(meta.headers.etag, metaBefore.headers.etag, "a log write advances the metadata validator");
  const log = await invoke({ path: logPath("gov") });
  assert.equal(log.body.split("\n").filter(Boolean).length, 3);
});

test("on a governed Collection the descriptor is read-only on the metadata path", async () => {
  await governedCollection();
  const meta = await invoke({ path: `/space/${SPACE}/gov/meta` });
  const changed = await invoke({
    method: "PUT",
    path: `/space/${SPACE}/gov/meta`,
    json: { ...meta.json, encryption: descriptor(["e1", "e2"], "e2") },
    headers: { "if-match": meta.headers.etag },
  });
  assert.equal(changed.status, 409);
  assert.equal(changed.json.type, "https://w3id.org/pws#encryption-history-log-governed");
  // A read-modify-write that restates the served value passes, and the
  // stored object still holds no descriptor
  const restated = await invoke({
    method: "PUT",
    path: `/space/${SPACE}/gov/meta`,
    json: { ...meta.json, name: "Governed" },
    headers: { "if-match": meta.headers.etag },
  });
  assert.equal(restated.status, 200, restated.body);
  assert.equal(restated.json.name, "Governed");
  assert.equal(restated.json.encryption.currentEpoch, "e1");
  assert.equal(JSON.parse(fakes.s3.buckets.get(SPACE).get("meta/gov.json").body).encryption, undefined);
  const after = await invoke({ path: `/space/${SPACE}/gov/meta` });
  assert.equal(after.json.name, "Governed");
  assert.deepEqual(after.json.encryption, meta.json.encryption);
});

test("governance is refused where a client-written descriptor already stands, and a written descriptor keeps the epoch invariants", async () => {
  const created = await invoke({ method: "POST", path: `/space/${SPACE}/`, json: { id: "edv", encryption: { scheme: "edv" } } });
  assert.equal(created.status, 201);
  const declared = await putLog("edv", genesisLine(descriptor(["e1"], "e1")), { "if-none-match": "*" });
  assert.equal(declared.status, 409);
  assert.equal(declared.json.type, "https://w3id.org/pws#encryption-immutable");

  const bad = await invoke({ method: "PUT", path: `/space/${SPACE}/edv/meta`, json: { encryption: { scheme: "edv", epochs: [{ id: "e1", recipients: [recipient] }] } } });
  assert.equal(bad.status, 400, "epochs without currentEpoch");
  const installed = await invoke({ method: "PUT", path: `/space/${SPACE}/edv/meta`, json: { encryption: descriptor(["e1"], "e1") } });
  assert.equal(installed.status, 200, installed.body);
  const dropped = await invoke({ method: "PUT", path: `/space/${SPACE}/edv/meta`, json: { encryption: descriptor(["e2"], "e2") } });
  assert.equal(dropped.status, 400);
  assert.equal(dropped.json.type, "https://w3id.org/pws#invalid-request-body");
  const cleared = await invoke({ method: "PUT", path: `/space/${SPACE}/edv/meta`, json: { name: "plain" } });
  assert.equal(cleared.status, 409);
  const rotated = await invoke({ method: "PUT", path: `/space/${SPACE}/edv/meta`, json: { encryption: descriptor(["e1", "e2"], "e2") } });
  assert.equal(rotated.status, 200, rotated.body);
});

test("the log is served under a public policy, hidden otherwise, and goes with its Collection", async () => {
  await governedCollection();
  const hidden = await invoke({ path: logPath("gov"), signer: null });
  assert.equal(hidden.status, 404);
  const stranger = await invoke({ path: logPath("gov"), signer: strangerKey });
  assert.equal(stranger.status, 404);
  await invoke({ method: "PUT", path: `/space/${SPACE}/gov/policy`, json: { type: "PublicCanRead" } });
  const open = await invoke({ path: logPath("gov"), signer: null });
  assert.equal(open.status, 200);
  const unsignedWrite = await putLog("gov", "{}", { "if-match": open.headers.etag }, null);
  assert.equal(unsignedWrite.status, 401);
  const deleted = await invoke({ method: "DELETE", path: `/space/${SPACE}/gov/` });
  assert.equal(deleted.status, 204);
  assert.ok(!fakes.s3.buckets.get(SPACE).has("meta/gov.log"));
});

test("a Space archive carries a governing log, and an import restores it", async () => {
  await governedCollection();
  const exported = await invoke({ method: "POST", path: `/space/${SPACE}/export` });
  assert.equal(exported.status, 200);
  const { entries } = await archiveEntries(Buffer.from(exported.body, "base64"));
  const dir = `space/${SPACE}/gov/`;
  assert.ok(entries.has(`${dir}.collectionlog.gov.json`));
  const logRecord = JSON.parse(entries.get(`${dir}.collectionlog.gov.json`).toString("utf8"));
  assert.equal(logRecord.body, genesisLine(descriptor(["e1"], "e1")) + "\n");
  assert.equal(logRecord.originId, "dcc-was-sandbox");
  assert.ok(logRecord.generation && logRecord.updatedAt);
  assert.equal(JSON.parse(entries.get(`${dir}.collection.meta.gov.json`).toString("utf8")).encryption, undefined);

  await seedSpace(fakes, { spaceId: SPACE_B });
  const imported = await invoke({
    method: "POST",
    path: `/space/${SPACE_B}/import`,
    body: Buffer.from(exported.body, "base64"),
    contentType: "application/x-tar",
  });
  assert.equal(imported.status, 200, imported.body);
  assert.equal(imported.json.logsCreated, 1);
  const meta = await invoke({ path: `/space/${SPACE_B}/gov/meta` });
  assert.equal(meta.json.encryption.currentEpoch, "e1");
  assert.equal(meta.json.encryption.history.resource, `${BASE}/space/${SPACE_B}/gov/meta/log`);
  const again = await invoke({ method: "POST", path: `/space/${SPACE_B}/import`, body: Buffer.from(exported.body, "base64"), contentType: "application/x-tar" });
  assert.equal(again.json.logsSkipped, 1);
});

// --- the changes feed ------------------------------------------------------------

let sequence = 0;
// One object event as the bucket publishes it, applied as the consumer
// applies it; the sequencer orders the events of one key.
async function objectEvent(key, { deleted = false, bucket = SPACE } = {}) {
  const object = deleted ? null : fakes.s3.buckets.get(bucket).get(key);
  sequence += 1;
  return applyObjectEvent({
    bucket,
    key,
    deleted,
    etag: object?.etag?.replace(/"/g, ""),
    sequencer: sequence.toString(16).padStart(16, "0"),
    time: new Date(Date.UTC(2026, 10, 11, 0, 0, sequence)).toISOString(),
  });
}

// Every object of the bucket, as events in key order (what the sweep and
// the pipeline together establish for a bucket that predates the feed)
async function feedEverything(bucket = SPACE) {
  for (const key of fakes.s3.keys(bucket)) {
    if (classifyKey(key) !== null) {
      await objectEvent(key, { bucket });
    }
  }
}

const query = (c, body, extra = {}) => invoke({ method: "POST", path: `/space/${SPACE}/${c}/query`, json: body, ...extra });

test("the consumer positions each record at its latest write, ignores stale events, tombstones deletes and drops a deleted Collection's feed", async () => {
  await seedObject(fakes, SPACE, "collections/notes/one", { v: 1 });
  await seedObject(fakes, SPACE, "collections/notes/two", { v: 2 });
  const first = await objectEvent("collections/notes/one");
  const second = await objectEvent("collections/notes/two");
  assert.equal(first.outcome, "positioned");
  assert.equal(first.position, 1);
  assert.equal(second.position, 2);
  const generation = first.generation;
  assert.ok(generation);
  await seedObject(fakes, SPACE, "collections/notes/one", { v: 11 });
  const moved = await objectEvent("collections/notes/one");
  assert.equal(moved.position, 3, "a rewritten record moves to the next position");
  const stale = await applyObjectEvent({ bucket: SPACE, key: "collections/notes/one", deleted: false, etag: "x", sequencer: "0000000000000001" });
  assert.equal(stale.outcome, "stale");
  fakes.s3.buckets.get(SPACE).delete("collections/notes/two");
  const gone = await objectEvent("collections/notes/two", { deleted: true });
  assert.equal(gone.position, 4);
  await seedObject(fakes, SPACE, "meta/notes/one.json", { custom: { name: "one" } });
  const annotated = await objectEvent("meta/notes/one.json");
  assert.equal(annotated.position, 5, "a metadata-only edit re-surfaces the Resource");
  await seedObject(fakes, SPACE, "meta/notes.json", { id: "notes", type: ["Collection"] });
  assert.equal((await objectEvent("meta/notes.json")).position, 6);
  await seedObject(fakes, SPACE, "policies/notes.json", { type: "PublicCanRead" });
  assert.equal((await objectEvent("policies/notes.json")).position, 7);
  assert.equal((await objectEvent("meta/space.json")).outcome, "ignored");
  assert.deepEqual(await readCounter(SPACE, "notes"), { next: 7, generation });
  // The Collection's metadata object going away drops its whole feed
  fakes.s3.buckets.get(SPACE).delete("meta/notes.json");
  assert.equal((await objectEvent("meta/notes.json", { deleted: true })).outcome, "purged");
  assert.equal(await readCounter(SPACE, "notes"), null);
  assert.equal([...fakes.dynamo.tables["was-feed"].keys()].filter((k) => k.includes("|notes#")).length, 0);
});

test("POST /space/{s}/{c}/query with the changes profile serves the feed in order, resumable by checkpoint, ending in null", async () => {
  await invoke({ method: "POST", path: `/space/${SPACE}/`, json: { id: "notes", name: "Notes" } });
  await invoke({ method: "PUT", path: `/space/${SPACE}/notes/one`, json: { v: 1 }, headers: { "key-epoch": "e1", "writer-id": "w1" } });
  await invoke({ method: "PUT", path: `/space/${SPACE}/notes/two`, json: { v: 2 } });
  await invoke({ method: "PUT", path: `/space/${SPACE}/notes/one/meta`, json: { custom: { name: "One" } } });
  await invoke({ method: "PUT", path: `/space/${SPACE}/notes/policy`, json: { type: "PublicCanRead" } });
  await invoke({ method: "PUT", path: `/space/${SPACE}/notes/blob`, body: Buffer.from([1, 2, 3]), contentType: "application/octet-stream" });
  await feedEverything();

  const empty = await query("other", { profile: "changes" });
  assert.equal(empty.status, 404, "a Collection that does not exist");
  const page1 = await query("notes", { profile: "changes", limit: 2 });
  assert.equal(page1.status, 200, page1.body);
  assert.equal(page1.json.documents.length, 2);
  assert.equal(typeof page1.json.checkpoint, "string");
  assert.equal(page1.json.checkpoint, page1.json.documents[1].checkpoint);
  const page2 = await query("notes", { profile: "changes", checkpoint: page1.json.checkpoint, limit: 100 });
  assert.equal(page2.status, 200, page2.body);
  const all = [...page1.json.documents, ...page2.json.documents];
  assert.deepEqual(all.map((d) => `${d.kind}:${d.id.replace(SPACE_URL, "")}`).sort(), [
    "collection-metadata:notes/meta",
    "policy:notes/policy",
    "resource:blob",
    "resource:one",
    "resource:two",
  ]);
  assert.deepEqual(
    all.map((d) => d.updatedAtCounter),
    [...all.map((d) => d.updatedAtCounter)].sort((a, b) => a - b),
    "entries come in position order"
  );
  const one = all.find((d) => d.kind === "resource" && d.id === "one");
  const read = await invoke({ path: `/space/${SPACE}/notes/one` });
  const readMeta = await invoke({ path: `/space/${SPACE}/notes/one/meta` });
  assert.deepEqual(one.data, { v: 1 });
  assert.equal(one.contentType, "application/json");
  assert.equal(one.deleted, false);
  assert.equal(one.etag, read.headers.etag, "the entry's etag is the one a read answers");
  assert.equal(one.metaEtag, readMeta.headers.etag);
  assert.deepEqual(one.custom, { name: "One" });
  assert.equal(one.epoch, "e1");
  assert.equal(one.writerId, "w1");
  assert.equal(one.createdBy, controllerKey.controller);
  assert.equal(one.originId, "dcc-was-sandbox");
  assert.ok(one.updatedAt && one.generation && one.checkpoint);
  const blob = all.find((d) => d.id === "blob");
  assert.equal(blob.contentType, "application/octet-stream");
  assert.equal(blob.data, undefined, "a binary Resource carries no data");
  const meta = all.find((d) => d.kind === "collection-metadata");
  assert.equal(meta.etag, (await invoke({ path: `/space/${SPACE}/notes/meta` })).headers.etag);
  assert.equal(meta.deleted, false);
  // The end of the feed: nothing new answers null, never the checkpoint sent
  const end = await query("notes", { profile: "changes", checkpoint: page2.json.checkpoint });
  assert.deepEqual(end.json, { documents: [], checkpoint: null });
  // The GET form, for a read-only capability, answers the same page
  const get = await invoke({ path: `/space/${SPACE}/notes/query?profile=changes&limit=2` });
  assert.equal(get.status, 200, get.body);
  assert.deepEqual(get.json, page1.json);
  // A checkpoint this server did not issue for this Collection
  const foreign = await query("notes", { profile: "changes", checkpoint: Buffer.from(JSON.stringify({ feed: `${SPACE_URL}other/`, generation: "x", position: 1 })).toString("base64url") });
  assert.equal(foreign.status, 400);
  assert.equal(foreign.json.type, "https://w3id.org/pws#invalid-request-body");
  assert.equal(foreign.json.errors[0].pointer, "#/checkpoint");
  const garbled = await query("notes", { profile: "changes", checkpoint: "not-a-checkpoint" });
  assert.equal(garbled.status, 400);
  assert.equal(garbled.json.errors[0].pointer, "#/checkpoint");
  // Profiles
  const noProfile = await query("notes", { limit: 1 });
  assert.equal(noProfile.status, 400);
  assert.equal(noProfile.json.errors[0].pointer, "#/profile");
  const other = await query("notes", { profile: "blinded-index", index: "x", equals: [] });
  assert.equal(other.status, 501);
  assert.equal(other.json.type, "https://w3id.org/pws#unsupported-operation");
  // A delete surfaces as a tombstone at a new position
  await invoke({ method: "DELETE", path: `/space/${SPACE}/notes/two` });
  await objectEvent("collections/notes/two", { deleted: true });
  const afterDelete = await query("notes", { profile: "changes", checkpoint: page2.json.checkpoint });
  assert.equal(afterDelete.json.documents.length, 1);
  const tomb = afterDelete.json.documents[0];
  assert.equal(tomb.id, "two");
  assert.equal(tomb.deleted, true);
  assert.equal(tomb.data, undefined);
  assert.equal(tomb.contentType, "application/json");
  assert.match(tomb.etag, /^"deleted\.\d+"$/);
  assert.equal(afterDelete.json.checkpoint, tomb.checkpoint);
});

test("a query needs read authorization: a capability, or a PublicCanRead policy", async () => {
  await invoke({ method: "POST", path: `/space/${SPACE}/`, json: { id: "open" } });
  await invoke({ method: "POST", path: `/space/${SPACE}/`, json: { id: "closed" } });
  await invoke({ method: "PUT", path: `/space/${SPACE}/open/policy`, json: { type: "PublicCanRead" } });
  await feedEverything();
  const hidden = await query("closed", { profile: "changes" }, { signer: null });
  assert.equal(hidden.status, 404);
  const stranger = await query("closed", { profile: "changes" }, { signer: strangerKey });
  assert.equal(stranger.status, 404);
  const open = await query("open", { profile: "changes" }, { signer: null });
  assert.equal(open.status, 200, open.body);
  assert.equal(open.json.documents.some((d) => d.kind === "policy"), true);
});

test("the feed carries a governed Collection's log and its service description advertises the profile", async () => {
  await governedCollection();
  await feedEverything();
  const page = await query("gov", { profile: "changes" });
  assert.equal(page.status, 200, page.body);
  const log = page.json.documents.find((d) => d.kind === "log");
  assert.equal(log.id, `${SPACE_URL}gov/meta/log`);
  assert.equal(log.etag, (await invoke({ path: logPath("gov") })).headers.etag);
  assert.equal(log.deleted, false);
  const service = await invoke({ path: "/service", signer: null });
  const core = service.json.specs["https://w3id.org/pws"][0];
  assert.ok(core.features.includes("changes-query"));
  assert.ok(core.features.includes("created-by"));
  assert.equal(core.originId, "dcc-was-sandbox");
});

test("the consumer applies a queue batch and reports the records that failed", async () => {
  await seedObject(fakes, SPACE, "collections/notes/one", { v: 1 });
  const message = (detail, type = "Object Created") => ({
    messageId: `m-${Math.random()}`,
    body: JSON.stringify({ "detail-type": type, time: "2026-11-11T00:00:00Z", detail }),
  });
  const out = await feedConsumer({
    Records: [
      message({ bucket: { name: SPACE }, object: { key: "collections/notes/one", etag: "abc", sequencer: "0000000000000001" } }),
      message({ bucket: { name: SPACE }, object: { key: "meta/space.json", etag: "abc", sequencer: "0000000000000002" } }),
      { messageId: "broken", body: "not json" },
    ],
  });
  assert.deepEqual(out.batchItemFailures, [{ itemIdentifier: "broken" }]);
  assert.equal((await readCounter(SPACE, "notes")).next, 1);
});

test("the sweep queues an event for every record the feed lacks or has wrong", async () => {
  await seedObject(fakes, SPACE, "collections/notes/one", { v: 1 });
  await seedObject(fakes, SPACE, "collections/notes/two", { v: 2 });
  await seedObject(fakes, SPACE, "meta/notes.json", { id: "notes", type: ["Collection"] });
  await objectEvent("collections/notes/one");
  await seedObject(fakes, SPACE, "collections/notes/one", { v: 11 }); // rewritten after its event
  await seedObject(fakes, SPACE, "collections/notes/three", { v: 3 });
  await objectEvent("collections/notes/three");
  fakes.s3.buckets.get(SPACE).delete("collections/notes/three"); // gone without a delete event
  const events = await sweepBucket(SPACE);
  const summary = events.map((e) => `${e["detail-type"]}:${e.detail.object.key}`).sort();
  assert.deepEqual(summary, [
    "Object Created:collections/notes/one",
    "Object Created:collections/notes/two",
    "Object Created:meta/notes.json",
    "Object Deleted:collections/notes/three",
  ]);
  const report = await sweep({ buckets: [SPACE] });
  assert.deepEqual(report, { [SPACE]: { queued: 4 } });
  assert.equal(fakes.sqs.messages.length, 4);
  assert.equal(fakes.sqs.messages[0].MessageGroupId, "feed");
  // Applied in order, the queued events settle the feed
  for (const { body } of fakes.sqs.messages) {
    await applyObjectEvent({ bucket: SPACE, key: body.detail.object.key, deleted: body["detail-type"] === "Object Deleted", etag: body.detail.object.etag, time: body.time });
  }
  assert.deepEqual(await sweepBucket(SPACE), []);
});
