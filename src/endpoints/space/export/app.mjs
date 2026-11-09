import { handler } from "was-lib/handler.mjs";
import { respond } from "was-lib/http.mjs";
import { KEYS, getJson, getObject, listObjects, listAllKeys, listAllPrefixes } from "was-lib/store.mjs";
import { readCollectionMeta, resourceMetaDoc } from "was-lib/meta.mjs";
import { serviceDescription } from "was-lib/service.mjs";
import { notFound, payloadTooLarge } from "was-lib/problems.mjs";
import {
  packSpaceArchive,
  collectBytes,
  spaceMetadataFileName,
  collectionMetadataFileName,
  fileNameFor,
  metaSidecarFileName,
  resourcePolicyFileName,
  SPACE_POLICY_FILE_NAME,
  COLLECTION_POLICY_FILE_NAME,
} from "@interop/space-archive";

// POST /space/{s}/export -- the Space as a Space archive (the spec's Space
// Archive Format): manifest.yml, this server's service description, then
// the Space's metadata and policy, and each Collection's metadata, policy,
// Resources (content as stored, a metadata sidecar each) and Resource
// policies. The @interop/space-archive codec writes the layout, so the file
// names and the manifest are the reference implementation's.
//
// What this server does not keep is absent from the archive: no tombstones
// (deletes are permanent here), no chunks, no governing history logs, no
// revocation records, and no provenance (this instance has no signing
// identity). Backend registrations and quotas are server state, not Space
// data, and are left out as the spec requires.
//
// The archive is built in memory and answered as one response body. API
// Gateway carries at most 6 MB of response after base64 encoding, so an
// archive beyond ARCHIVE_LIMIT is refused with 413 rather than cut off.
// Nothing is written: the operation is safe, carried over POST because it
// is capability-invoked.

const ARCHIVE_LIMIT = 4 * 1024 * 1024;

const bytesOf = (doc) => Buffer.from(JSON.stringify(doc));

// Every Collection of the Space: those with content, and those with a
// metadata object but no content yet.
async function collectionIds(spaceId) {
  const ids = new Set();
  for (const prefix of await listAllPrefixes(spaceId, "collections/")) {
    ids.add(prefix.slice("collections/".length, -1));
  }
  let cursor;
  do {
    const page = await listObjects(spaceId, { prefix: "meta/", delimiter: "/", cursor });
    for (const { key } of page.objects) {
      const match = key.match(/^meta\/([^/]+)\.json$/);
      if (match && match[1] !== "space") {
        ids.add(match[1]);
      }
    }
    cursor = page.next;
  } while (cursor);
  return [...ids].sort();
}

// The stored form of a metadata object: what the Read operation returns,
// less the URL this server adds on the way out.
function stored(doc) {
  const { url: _url, ...rest } = doc;
  return rest;
}

async function collectionEntry(req, spaceId, collectionId, budget) {
  const meta = await readCollectionMeta(req, spaceId, collectionId);
  if (meta === null) {
    return null;
  }
  const files = [{ name: collectionMetadataFileName(collectionId), bytes: bytesOf(stored(meta.doc)) }];
  const policy = await getJson(spaceId, KEYS.collectionPolicy(collectionId));
  if (policy) {
    files.push({ name: COLLECTION_POLICY_FILE_NAME, bytes: bytesOf(policy.doc) });
  }
  const prefix = KEYS.collectionPrefix(collectionId);
  const keys = (await listAllKeys(spaceId, prefix)).filter((key) => key.length > prefix.length).sort();
  for (const key of keys) {
    const resourceId = key.slice(prefix.length);
    const object = await getObject(spaceId, key);
    if (object === null) {
      continue;
    }
    budget.spend(object.body.length);
    const contentType = object.contentType ?? "application/octet-stream";
    files.push({ name: fileNameFor({ resourceId, contentType }), bytes: object.body });
    const annotation = await getJson(spaceId, KEYS.resourceMeta(collectionId, resourceId));
    files.push({ name: metaSidecarFileName(resourceId), bytes: bytesOf(resourceMetaDoc({ head: object, stored: annotation })) });
    const resourcePolicy = await getJson(spaceId, KEYS.resourcePolicy(collectionId, resourceId));
    if (resourcePolicy) {
      files.push({ name: resourcePolicyFileName(resourceId), bytes: bytesOf(resourcePolicy.doc) });
    }
  }
  return { name: collectionId, files };
}

export const lambdaHandler = handler(
  async (req, { spaceId }) => {
    const space = await getJson(spaceId, KEYS.spaceMeta());
    if (space === null) {
      throw notFound();
    }
    let total = 0;
    const budget = {
      spend(bytes) {
        total += bytes;
        if (total > ARCHIVE_LIMIT) {
          throw payloadTooLarge(`This Space's archive exceeds the ${ARCHIVE_LIMIT} bytes one export response can carry.`);
        }
      },
    };
    const entries = [{ name: spaceMetadataFileName(spaceId), bytes: bytesOf({ ...space.doc, id: spaceId }) }];
    const policy = await getJson(spaceId, KEYS.spacePolicy());
    if (policy) {
      entries.push({ name: SPACE_POLICY_FILE_NAME, bytes: bytesOf(policy.doc) });
    }
    for (const collectionId of await collectionIds(spaceId)) {
      const entry = await collectionEntry(req, spaceId, collectionId, budget);
      if (entry) {
        entries.push(entry);
      }
    }
    const pack = await packSpaceArchive({ spaceId, entries, service: serviceDescription(req) });
    const archive = Buffer.from(await collectBytes(pack));
    return respond(req, { status: 200, body: archive, contentType: "application/x-tar" });
  },
  { scope: "space-export", safe: true }
);
