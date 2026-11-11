import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { handler } from "was-lib/handler.mjs";
import { json, NO_STORE } from "was-lib/http.mjs";
import { KEYS, getJson, headObject, putJson, putObject } from "was-lib/store.mjs";
import { readSpaceMeta, writeSpaceMeta, hasContent, now, CONTENT_META } from "was-lib/meta.mjs";
import { isReserved } from "was-lib/ids.mjs";
import { parseLog, checkHeadState, writeCollectionLog } from "was-lib/history.mjs";
import { invalidImport, missingContentType, notFound, unsupportedBackend } from "was-lib/problems.mjs";
import {
  readSpaceArchive,
  parseArchivePath,
  classifyCollectionFile,
  spaceMetadataFromFile,
  collectionMetadataFromFile,
  policyFromFile,
  BundleInvalidError,
} from "@interop/space-archive";

// POST /space/{s}/import -- merges a Space archive into this existing Space:
// adds what the Space lacks, skips what it holds, overwrites nothing, so
// importing the same archive twice changes nothing the second time and an
// interrupted import converges when run again. The archive is checked
// whole before anything is written; a refusal leaves the Space untouched.
//
// The merge, per kind of entry (the spec's rules, reduced to what this
// server stores):
//   - Space Metadata: under the Space's root capability the `name` is
//     restored (and mirrored to the registry, as Update Space does); under a
//     delegated capability it is skipped, and the report says which. `type`
//     is immutable, so an archive whose type differs is refused.
//   - Space, Collection and Resource policies: written only where the
//     destination has none.
//   - Collections: created from the archived metadata when absent, else
//     skipped with their metadata, policy and log left alone; archived
//     Resources the destination lacks are imported either way.
//   - Resources: created from the archived content and sidecar when absent
//     (the sidecar's `custom`, creation time, key epoch and writer label are
//     kept; `createdBy` is not, since no provenance statement attests it),
//     else skipped with their policy.
//   - Tombstones, chunks, governing logs and revocation records: this server
//     keeps none, so they are not written; an archived Resource tombstone
//     counts as skipped.
//
// Every object the archive attests is reported `unattested`: this server
// verifies no provenance yet.

const SPACES_TABLE = process.env.SPACES_TABLE_NAME ?? "was-spaces";
const dynamo = new DynamoDBClient({});

async function mirrorName(registryUrl, name) {
  await dynamo.send(
    new UpdateItemCommand({
      TableName: SPACES_TABLE,
      Key: { spaceURL: { S: registryUrl } },
      ...(name === undefined
        ? { UpdateExpression: "REMOVE #name" }
        : { UpdateExpression: "SET #name = :name", ExpressionAttributeValues: { ":name": { S: name } } }),
      ExpressionAttributeNames: { "#name": "name" },
    })
  );
}

const sameType = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

// Reads the archive into what the merge needs: the Space's metadata and
// policy, and per Collection its metadata, policy and Resources.
async function readArchive(body) {
  let archive;
  try {
    archive = await readSpaceArchive(new Uint8Array(body));
  } catch (err) {
    if (err instanceof BundleInvalidError) {
      throw invalidImport(err.message);
    }
    throw err;
  }
  const space = { meta: undefined, policy: undefined };
  const collections = new Map();
  const collection = (id) => {
    if (!collections.has(id)) {
      collections.set(id, { meta: undefined, policy: undefined, log: undefined, resources: new Map() });
    }
    return collections.get(id);
  };
  const resource = (collectionId, resourceId) => {
    const c = collection(collectionId);
    if (!c.resources.has(resourceId)) {
      c.resources.set(resourceId, { content: undefined, contentType: undefined, sidecar: undefined, policy: undefined });
    }
    return c.resources.get(resourceId);
  };
  try {
    for await (const entry of archive.entries) {
      if (entry.type !== "file") {
        continue;
      }
      const position = parseArchivePath(entry.name);
      if (position.area === "space") {
        if (position.fileName === ".space.policy.json") {
          space.policy = policyFromFile({ bytes: await entry.bytes() });
        } else if (position.fileName.startsWith(".space.meta.")) {
          space.meta = spaceMetadataFromFile({ bytes: await entry.bytes() });
        }
        continue;
      }
      if (position.area !== "collection") {
        // Tombstones, chunks and revocation records: nothing this server stores
        continue;
      }
      const kind = classifyCollectionFile(position.fileName);
      switch (kind.kind) {
        case "collectionMetadata":
          collection(position.collectionId).meta = collectionMetadataFromFile({ bytes: await entry.bytes() });
          break;
        case "collectionLog":
          // The archive's log entry is a JSON object whose `body` is the
          // log's JSON Lines text; a bare JSON Lines file is taken as well
          collection(position.collectionId).log = archivedLogBody(Buffer.from(await entry.bytes()));
          break;
        case "policy":
          collection(position.collectionId).policy = policyFromFile({ bytes: await entry.bytes() });
          break;
        case "representation": {
          const r = resource(position.collectionId, kind.resourceId);
          r.content = Buffer.from(await entry.bytes());
          r.contentType = kind.contentType;
          break;
        }
        case "metaSidecar":
          resource(position.collectionId, kind.resourceId).sidecar = JSON.parse(Buffer.from(await entry.bytes()).toString("utf8"));
          break;
        case "resourcePolicy":
          resource(position.collectionId, kind.resourceId).policy = policyFromFile({ bytes: await entry.bytes() });
          break;
        default:
          break;
      }
    }
  } catch (err) {
    if (err instanceof BundleInvalidError || err instanceof SyntaxError) {
      throw invalidImport(err.message);
    }
    throw err;
  } finally {
    await archive.close().catch(() => undefined);
  }
  return { spaceId: archive.spaceId, space, collections };
}

// The JSON Lines text of an archived log entry: the `body` of the archive
// format's JSON object, or the bytes themselves when they are not one.
function archivedLogBody(bytes) {
  const text = bytes.toString("utf8");
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.body === "string") {
      return Buffer.from(parsed.body, "utf8");
    }
  } catch {
    // JSON Lines with more than one line is not one JSON text
  }
  return bytes;
}

// The stored Collection Metadata for an archived one: the archive's own
// members, less what belongs to the exporting server or the archive.
function collectionDocFrom(collectionId, archived) {
  const { url: _url, _generation, updatedAtCounter, originId, deleted, ...rest } = archived ?? {};
  const stamp = now();
  return {
    ...rest,
    id: collectionId,
    type: Array.isArray(rest.type) ? rest.type : ["Collection"],
    createdAt: typeof rest.createdAt === "string" ? rest.createdAt : stamp,
    updatedAt: typeof rest.updatedAt === "string" ? rest.updatedAt : stamp,
  };
}

// Writes a JSON object only where none exists; false when one did.
async function putIfAbsent(spaceId, key, doc) {
  if ((await headObject(spaceId, key)) !== null) {
    return false;
  }
  try {
    await putJson(spaceId, key, doc, { ifNoneMatch: "*" });
    return true;
  } catch (err) {
    if (err?.status === 412) {
      return false;
    }
    throw err;
  }
}

export const lambdaHandler = handler(
  async (req, { spaceId, registryUrl }) => {
    if (req.body === null || !req.contentType) {
      throw missingContentType();
    }
    const destination = await readSpaceMeta(req, spaceId);
    if (destination === null) {
      throw notFound();
    }
    const { space, collections } = await readArchive(req.body);

    // Checks, before any write
    if (!space.meta) {
      throw invalidImport("The archive carries no Space Metadata entry.");
    }
    const archivedType = Array.isArray(space.meta.type) ? space.meta.type : ["Space"];
    if (!sameType(archivedType, destination.doc.type ?? ["Space"])) {
      throw invalidImport(`The archived Space type (${archivedType.join(", ")}) differs from this Space's (${(destination.doc.type ?? ["Space"]).join(", ")}).`);
    }
    for (const [collectionId, entry] of collections) {
      if (isReserved("collection", collectionId)) {
        throw invalidImport(`"${collectionId}" is a reserved segment and cannot be a Collection id.`);
      }
      if (entry.meta?.backend !== undefined) {
        throw unsupportedBackend(`The archived Collection "${collectionId}" names a backend; this server has none.`);
      }
      if (entry.log !== undefined) {
        try {
          checkHeadState(parseLog(entry.log).entries, null);
        } catch (err) {
          throw invalidImport(`The archived history log of "${collectionId}" is not a valid log: ${err.message}`);
        }
      }
      for (const [resourceId, r] of entry.resources) {
        if (isReserved("resource", resourceId)) {
          throw invalidImport(`"${resourceId}" is a reserved segment and cannot be a Resource id.`);
        }
        if (r.content !== undefined && r.content.length === 0) {
          throw invalidImport(`The archived Resource "${collectionId}/${resourceId}" has no content.`);
        }
      }
    }

    const report = {
      collectionsCreated: 0,
      collectionsSkipped: 0,
      resourcesCreated: 0,
      resourcesSkipped: 0,
      policiesCreated: 0,
      policiesSkipped: 0,
      logsCreated: 0,
      logsSkipped: 0,
      spaceMetadata: "skipped",
      provenance: { verified: 0, unattested: 0, proofInvalid: 0, contentMismatch: 0, unknownSigner: 0 },
    };
    report.provenance.unattested += 1;

    // Space Metadata: the user-writable member, under the root capability only
    if (req.auth.delegated !== "true") {
      const name = typeof space.meta.name === "string" ? space.meta.name : undefined;
      const { url: _url, id: _id, ...current } = destination.doc;
      const doc = { ...current, ...(name !== undefined ? { name } : {}), updatedAt: now() };
      if (name === undefined) {
        delete doc.name;
      }
      await writeSpaceMeta(req, spaceId, doc, {});
      await mirrorName(registryUrl, name);
      report.spaceMetadata = "restored";
    }

    if (space.policy) {
      if (await putIfAbsent(spaceId, KEYS.spacePolicy(), space.policy)) {
        report.policiesCreated++;
      } else {
        report.policiesSkipped++;
      }
    }

    for (const [collectionId, entry] of [...collections].sort(([a], [b]) => a.localeCompare(b))) {
      report.provenance.unattested += 1;
      const exists =
        (await headObject(spaceId, KEYS.collectionMeta(collectionId))) !== null || (await hasContent(spaceId, collectionId));
      if (exists) {
        report.collectionsSkipped++;
        if (entry.policy) {
          report.policiesSkipped++;
        }
        if (entry.log !== undefined) {
          report.logsSkipped++;
        }
      } else {
        await putIfAbsent(spaceId, KEYS.collectionMeta(collectionId), collectionDocFrom(collectionId, entry.meta));
        report.collectionsCreated++;
        // The governing history log, declaring the new Collection governed,
        // when the archive carries one and the metadata holds no
        // client-written descriptor (a Collection is provisioned in one
        // form or the other); its lines are checked as a write is checked
        if (entry.log !== undefined) {
          if (entry.meta?.encryption === undefined && (await headObject(spaceId, KEYS.collectionLog(collectionId))) === null) {
            const { lines, entries } = parseLog(entry.log);
            checkHeadState(entries, null);
            await writeCollectionLog(spaceId, collectionId, lines, { ifNoneMatch: "*" });
            report.logsCreated++;
          } else {
            report.logsSkipped++;
          }
        }
        if (entry.policy) {
          if (await putIfAbsent(spaceId, KEYS.collectionPolicy(collectionId), entry.policy)) {
            report.policiesCreated++;
          } else {
            report.policiesSkipped++;
          }
        }
      }

      for (const [resourceId, r] of [...entry.resources].sort(([a], [b]) => a.localeCompare(b))) {
        if (r.content !== undefined) {
          report.provenance.unattested += 1;
        }
        const key = KEYS.resource(collectionId, resourceId);
        if (r.content === undefined || (await headObject(spaceId, key)) !== null) {
          // Held already, or an archived tombstone this server does not keep
          report.resourcesSkipped++;
          if (r.policy) {
            report.policiesSkipped++;
          }
          continue;
        }
        const sidecar = r.sidecar ?? {};
        const metadata = {
          [CONTENT_META.createdAt]: typeof sidecar.createdAt === "string" ? sidecar.createdAt : now(),
          ...(typeof sidecar.epoch === "string" && { [CONTENT_META.epoch]: sidecar.epoch }),
          ...(typeof sidecar.writerId === "string" && { [CONTENT_META.writerId]: sidecar.writerId }),
        };
        try {
          await putObject(spaceId, key, { body: r.content, contentType: r.contentType, metadata, ifNoneMatch: "*" });
        } catch (err) {
          if (err?.status === 412) {
            report.resourcesSkipped++;
            if (r.policy) {
              report.policiesSkipped++;
            }
            continue;
          }
          throw err;
        }
        report.resourcesCreated++;
        if (sidecar.custom !== undefined && sidecar.custom !== null && typeof sidecar.custom === "object") {
          const stamp = now();
          await putJson(spaceId, KEYS.resourceMeta(collectionId, resourceId), {
            custom: sidecar.custom,
            createdAt: metadata[CONTENT_META.createdAt],
            updatedAt: stamp,
          });
        }
        if (r.policy) {
          if (await putIfAbsent(spaceId, KEYS.resourcePolicy(collectionId, resourceId), r.policy)) {
            report.policiesCreated++;
          } else {
            report.policiesSkipped++;
          }
        }
      }
    }
    return json(req, 200, report, NO_STORE);
  },
  { scope: "space-import" }
);
