import { handler } from "was-lib/handler.mjs";
import { respond } from "was-lib/http.mjs";
import { KEYS, getJson, getObject, listObjects, listAllKeys, listAllPrefixes } from "was-lib/store.mjs";
import { readCollectionMeta, resourceMetaDoc } from "was-lib/meta.mjs";
import { serviceDescription, originId } from "was-lib/service.mjs";
import { notFound, payloadTooLarge } from "was-lib/problems.mjs";
import {
  packSpaceArchive,
  collectBytes,
  spaceMetadataFileName,
  collectionMetadataFileName,
  collectionLogFileName,
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
// (deletes are permanent here), no chunks, no revocation records, and no
// provenance (this instance has no signing identity). A Collection's
// governing history log travels as its own file beside the metadata. Backend registrations and quotas are server state, not Space
// data, and are left out as the spec requires.
//
// The archive is built in memory and answered as one response body. API
// Gateway carries at most 6 MB of response after base64 encoding, so an
// archive beyond ARCHIVE_LIMIT is refused with 413 rather than cut off:
// every file is counted as it is gathered (content, metadata, policies and
// the governing logs, which grow with a Space's key rotations and can
// outweigh its content), and the packed archive is checked once more, tar
// headers included. Nothing is written: the operation is safe, carried
// over POST because it is capability-invoked.

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
  // The stored metadata object: on a governed Collection the derived
  // members stay out, and the governing log travels as its own file
  const { encryption: _encryption, revisions: _revisions, ...metadata } = stored(meta.doc);
  // Every file counts against the budget, the governing log included: a
  // Space's logs grow with its key rotations and can outweigh its content
  const files = [];
  const add = (name, bytes) => {
    budget.spend(bytes.length);
    files.push({ name, bytes });
  };
  add(collectionMetadataFileName(collectionId), bytesOf(meta.governed ? metadata : stored(meta.doc)));
  // The archive format's log entry: a JSON object whose `body` is the log's
  // JSON Lines text, beside the record's write stamp and generation (this
  // server's stamp is the object's last-modified time; its generation the
  // validator's digest)
  const log = await getObject(spaceId, KEYS.collectionLog(collectionId));
  if (log !== null) {
    const record = {
      body: log.body.toString("utf8"),
      generation: String(log.etag ?? "").replace(/"/g, ""),
      updatedAt: log.lastModified?.toISOString?.() ?? new Date(0).toISOString(),
      updatedAtCounter: 0,
      originId: originId(),
    };
    add(collectionLogFileName(collectionId), bytesOf(record));
  }
  const policy = await getJson(spaceId, KEYS.collectionPolicy(collectionId));
  if (policy) {
    add(COLLECTION_POLICY_FILE_NAME, bytesOf(policy.doc));
  }
  const prefix = KEYS.collectionPrefix(collectionId);
  const keys = (await listAllKeys(spaceId, prefix)).filter((key) => key.length > prefix.length).sort();
  for (const key of keys) {
    const resourceId = key.slice(prefix.length);
    const object = await getObject(spaceId, key);
    if (object === null) {
      continue;
    }
    const contentType = object.contentType ?? "application/octet-stream";
    add(fileNameFor({ resourceId, contentType }), object.body);
    const annotation = await getJson(spaceId, KEYS.resourceMeta(collectionId, resourceId));
    add(metaSidecarFileName(resourceId), bytesOf(resourceMetaDoc({ head: object, stored: annotation })));
    const resourcePolicy = await getJson(spaceId, KEYS.resourcePolicy(collectionId, resourceId));
    if (resourcePolicy) {
      add(resourcePolicyFileName(resourceId), bytesOf(resourcePolicy.doc));
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
    const tooLarge = () => payloadTooLarge(`This Space's archive exceeds the ${ARCHIVE_LIMIT} bytes one export response can carry.`);
    let total = 0;
    const budget = {
      spend(bytes) {
        total += bytes;
        if (total > ARCHIVE_LIMIT) {
          throw tooLarge();
        }
      },
    };
    const spaceMeta = bytesOf({ ...space.doc, id: spaceId });
    budget.spend(spaceMeta.length);
    const entries = [{ name: spaceMetadataFileName(spaceId), bytes: spaceMeta }];
    const policy = await getJson(spaceId, KEYS.spacePolicy());
    if (policy) {
      const policyBytes = bytesOf(policy.doc);
      budget.spend(policyBytes.length);
      entries.push({ name: SPACE_POLICY_FILE_NAME, bytes: policyBytes });
    }
    for (const collectionId of await collectionIds(spaceId)) {
      const entry = await collectionEntry(req, spaceId, collectionId, budget);
      if (entry) {
        entries.push(entry);
      }
    }
    const pack = await packSpaceArchive({ spaceId, entries, service: serviceDescription(req) });
    const archive = Buffer.from(await collectBytes(pack));
    if (archive.length > ARCHIVE_LIMIT) {
      throw tooLarge();
    }
    return respond(req, { status: 200, body: archive, contentType: "application/x-tar" });
  },
  { scope: "space-export", safe: true }
);
