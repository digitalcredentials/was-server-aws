import { test } from "node:test";
import assert from "node:assert/strict";
import "./env.mjs";
import { installFakes } from "./fakes.mjs";
import { seedObject, seedSpace, seedWebvhLog, bucketOf } from "./harness.mjs";
import { resolveWebvhDocument, clearWebvhCache } from "was-lib/webvh.mjs";

// The resolver's cache: a document past its lifetime is validated against
// the log's ETag with a conditional read and kept when the log is
// unchanged, so the log is downloaded and walked again only when it
// changed. Both sources: a log read from the bucket (an account on this
// server) and one fetched over HTTPS.

const CACHE_MS = 30_000;

// A did:webvh driver that counts the walks it is asked for and answers the
// DID the log text names
function countingDriver() {
  const driver = {
    walks: 0,
    readLogFromString: (text) => text,
    resolveDIDFromLog: async (text) => {
      driver.walks += 1;
      const { did, version } = JSON.parse(text);
      return { did, doc: { id: did, version }, meta: {} };
    },
  };
  return driver;
}

test("a log read from the bucket is walked again only when it changed", async () => {
  const fakes = installFakes();
  // A server-assigned id, which is its bucket's name as it is
  const spaceId = "dcc-pws-0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";
  const did = `did:webvh:scid:id.test:${spaceId}`;
  await seedSpace(fakes, { spaceId });
  // (clears the resolver's cache too)
  await seedWebvhLog(fakes, spaceId, JSON.stringify({ did, version: 1 }));
  const driver = countingDriver();
  let clock = 1_000_000;
  const now = () => clock;

  assert.deepEqual(await resolveWebvhDocument(did, { driver, now }), { id: did, version: 1 });
  assert.equal(driver.walks, 1);
  // Within the lifetime: the cached document, no read
  clock += CACHE_MS / 2;
  assert.deepEqual(await resolveWebvhDocument(did, { driver, now }), { id: did, version: 1 });
  assert.equal(driver.walks, 1);
  // Past the lifetime, the log unchanged: validated, not walked again
  clock += CACHE_MS;
  assert.deepEqual(await resolveWebvhDocument(did, { driver, now }), { id: did, version: 1 });
  assert.equal(driver.walks, 1);
  // A fresh resolution for a key the document does not list: the same
  // validation, since an unchanged log lists no new key either
  assert.deepEqual(await resolveWebvhDocument(did, { driver, now, fresh: true }), { id: did, version: 1 });
  assert.equal(driver.walks, 1);
  // The log changed (written without clearing the cache: the validation
  // must notice on its own): the next validation reads and walks it
  await seedObject(fakes, bucketOf(spaceId), "collections/id/did.jsonl", JSON.stringify({ did, version: 2 }), "text/jsonl");
  assert.deepEqual(await resolveWebvhDocument(did, { driver, now, fresh: true }), { id: did, version: 2 });
  assert.equal(driver.walks, 2);
  // And the changed document is what the cache now serves
  clock += CACHE_MS / 2;
  assert.deepEqual(await resolveWebvhDocument(did, { driver, now }), { id: did, version: 2 });
  assert.equal(driver.walks, 2);
});

test("a log fetched over HTTPS is validated with If-None-Match", async () => {
  clearWebvhCache();
  const did = "did:webvh:scid:example.org:accounts:alice";
  let version = 1;
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, ifNoneMatch: init?.headers?.["if-none-match"] });
    const etag = `"v${version}"`;
    if (init?.headers?.["if-none-match"] === etag) {
      return { status: 304, ok: false, headers: { get: () => null }, text: async () => "" };
    }
    const text = JSON.stringify({ did, version });
    return {
      status: 200,
      ok: true,
      headers: { get: (name) => (name === "etag" ? etag : name === "content-length" ? String(text.length) : null) },
      text: async () => text,
    };
  };
  const driver = countingDriver();
  let clock = 2_000_000;
  const now = () => clock;

  assert.deepEqual(await resolveWebvhDocument(did, { driver, fetch: fetchImpl, now }), { id: did, version: 1 });
  assert.equal(requests[0].url, "https://example.org/accounts/alice/did.jsonl");
  assert.equal(requests[0].ifNoneMatch, undefined);
  clock += CACHE_MS + 1;
  assert.deepEqual(await resolveWebvhDocument(did, { driver, fetch: fetchImpl, now }), { id: did, version: 1 });
  assert.equal(requests[1].ifNoneMatch, '"v1"');
  assert.equal(driver.walks, 1);
  version = 2;
  clock += CACHE_MS + 1;
  assert.deepEqual(await resolveWebvhDocument(did, { driver, fetch: fetchImpl, now }), { id: did, version: 2 });
  assert.equal(requests[2].ifNoneMatch, '"v1"');
  assert.equal(driver.walks, 2);
  // A log that is gone drops the cached document
  const gone = async () => ({ status: 404, ok: false, headers: { get: () => null }, text: async () => "" });
  clock += CACHE_MS + 1;
  assert.equal(await resolveWebvhDocument(did, { driver, fetch: gone, now }), null);
  assert.deepEqual(await resolveWebvhDocument(did, { driver, fetch: fetchImpl, now }), { id: did, version: 2 });
  assert.equal(requests.at(-1).ifNoneMatch, undefined);
});
