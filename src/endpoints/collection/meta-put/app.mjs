import { handler } from "was-lib/handler.mjs";
import { json, parseJsonBody, preconditions, NO_STORE } from "was-lib/http.mjs";
import { KEYS, headObject } from "was-lib/store.mjs";
import { readCollectionMeta, composeCollectionMeta, writeCollectionMeta } from "was-lib/meta.mjs";
import { assertDescriptorTransition } from "was-lib/epochs.mjs";
import { stripHistory } from "was-lib/history.mjs";
import { encryptionHistoryLogGoverned, encryptionImmutable, invalidRequestBody, preconditionFailed, revisionsImmutable } from "was-lib/problems.mjs";

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// PUT /space/{s}/{c}/meta -- a full replacement of the writable members
// (configuration and the custom/epoch annotation), under If-Match /
// If-None-Match; with If-None-Match: * it creates the Collection (201).
// Any chain that covers the URL may do it, as on the reference server: a
// delegated client holding a Space-subtree grant creates the Collections
// it writes (wallet-core's transient clients mint their annex generation
// this way, and create `dids` or `Trash` in the account Space). The
// container rule keeps the Space's own metadata and deletion root-only
// (space/meta-put, space/delete). An `encryption` descriptor is
// creation-only and version-monotonic across updates (epochs.mjs); on a
// Collection governed by its history log the member is read-only here (a
// restatement of the derived value passes, a change is refused), and the
// stored object never holds it.
export const lambdaHandler = handler(
  async (req, { spaceId, collectionId, invoker }) => {
    const body = parseJsonBody(req, { problem: invalidRequestBody });
    if (body.id !== undefined && body.id !== collectionId) {
      throw invalidRequestBody('"id" does not match the Collection addressed by the URL.');
    }
    const existed = (await headObject(spaceId, KEYS.collectionMeta(collectionId))) !== null;
    const current = existed ? await readCollectionMeta(req, spaceId, collectionId) : null;
    const stored = current?.doc ?? null;
    // A failed precondition answers before the body's rules do
    const { ifMatch, ifNoneMatch } = preconditions(req);
    if ((ifMatch !== undefined && ifMatch !== current?.etag) || (ifNoneMatch !== undefined && existed)) {
      throw preconditionFailed();
    }
    const doc = composeCollectionMeta({ collectionId, body, stored, invoker });
    if (current?.governed) {
      if (body.encryption !== undefined && !sameJson(stripHistory(body.encryption), stripHistory(stored.encryption))) {
        throw encryptionHistoryLogGoverned(
          "The encryption descriptor is derived from the Collection's history log; append to meta/log to change it."
        );
      }
      if (body.revisions !== undefined && !sameJson(body.revisions, stored.revisions ?? {})) {
        throw revisionsImmutable("The revisions descriptor is derived from the Collection's history log.");
      }
      delete doc.encryption;
      delete doc.revisions;
    } else if (stored?.encryption !== undefined) {
      if (doc.encryption === undefined) {
        throw encryptionImmutable("An encryption descriptor cannot be cleared from a Collection.");
      }
      assertDescriptorTransition(stored.encryption, doc.encryption);
    }
    const written = await writeCollectionMeta(req, spaceId, collectionId, doc, preconditions(req));
    const served = current?.governed ? { ...written.doc, encryption: stored.encryption, ...(stored.revisions && { revisions: stored.revisions }) } : written.doc;
    return json(req, existed ? 200 : 201, served, { ...NO_STORE, ETag: written.etag });
  },
  { scope: "collection-meta" }
);
