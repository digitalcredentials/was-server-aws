// In-process tests of the API function against the WAS v0.5 behaviour the
// @interop/was-client (0.93+) relies on. S3 and DynamoDB are faked; every
// request is signed the way the client signs it.
//
//   cd test && npm test

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { installFakes } from "./fakes.mjs";
import { invoke, seedSpace, seedObject, controllerKey, strangerKey, BASE } from "./harness.mjs";

const SPACE = "dcc-was-01011f5b-59ea-4e62-880e-d6ad666e361c";
const SPACE_URL = `${BASE}/space/${SPACE}/`;
const PROBLEM = "application/problem+json";

let fakes;
beforeEach(async () => {
  fakes = installFakes();
  await seedSpace(fakes, { spaceId: SPACE });
  fakes.dynamo.tables["was-coupons"].set("open-sesame", { coupon: { S: "open-sesame" } });
  fakes.dynamo.tables["was-coupons"].set("one-shot", { coupon: { S: "one-shot" }, usesRemaining: { N: "1" } });
});

const objectKeys = () => fakes.s3.keys(SPACE);

// --- discovery ---------------------------------------------------------------

test("GET / serves the service description with the service link", async () => {
  const res = await invoke({ path: "/", signer: null });
  assert.equal(res.status, 200);
  assert.equal(res.headers.link, `<${BASE}/>; rel="service"`);
  assert.equal(res.json.url, `${BASE}/`);
  const entry = res.json.specs["https://w3id.org/pws"][0];
  assert.equal(entry.version, "0.5");
  assert.equal(entry.spaces, `${BASE}/spaces/`);
  assert.ok(entry.features.includes("listing"));
});

test("HEAD / carries the link and no body", async () => {
  const res = await invoke({ method: "HEAD", path: "/", signer: null });
  assert.equal(res.status, 200);
  assert.equal(res.headers.link, `<${BASE}/>; rel="service"`);
  assert.equal(res.body, "");
});

test("an unknown path is a problem+json 404 that still carries the link", async () => {
  const res = await invoke({ path: "/nothing/here", signer: null });
  assert.equal(res.status, 404);
  assert.equal(res.headers["content-type"], PROBLEM);
  assert.equal(res.json.type, "https://w3id.org/pws#not-found");
  assert.ok(res.headers.link);
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
  const row = fakes.dynamo.tables["wallet-spaces"].get(`${BASE}/space/${id}`);
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
  assert.equal(fakes.dynamo.tables["wallet-spaces"].get(`${BASE}/space/${SPACE}`).name.S, "Renamed");

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
  for (const path of [`/space/${SPACE}/linkset`, `/space/${SPACE}/quotas`, `/space/${SPACE}/c/meta/log`, `/space/${SPACE}/c/r/chunks/0`]) {
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
    json: { id: "vault", name: "Vault 2", custom: { name: "My vault" }, encryption: { scheme: "edv", currentEpoch: "e1", epochs: [] } },
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

  const cached = await invoke({ path: `/space/${SPACE}/docs/one`, headers: { "if-none-match": updated.headers.etag } });
  assert.equal(cached.status, 304);
  assert.equal(cached.body, "");

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
  assert.equal(fakes.dynamo.tables["wallet-spaces"].has(`${BASE}/space/${SPACE}`), false);
  const after = await invoke({ path: `/space/${SPACE}/meta` });
  assert.equal(after.status, 404);
});
