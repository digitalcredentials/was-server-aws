import { randomUUID } from "node:crypto";
import { handler } from "was-lib/handler.mjs";
import { json, parseJsonBody, NO_STORE } from "was-lib/http.mjs";
import { KEYS, headObject } from "was-lib/store.mjs";
import { assertId } from "was-lib/ids.mjs";
import { composeCollectionMeta, writeCollectionMeta, hasContent, collectionUrl } from "was-lib/meta.mjs";
import { idConflict, invalidRequestBody } from "was-lib/problems.mjs";

// POST /space/{s}/ -- create a Collection (create-only: an existing id is a
// 409). Without an id in the body the server assigns one. The Collection
// is its metadata object; the write is create-if-absent so a race cannot
// replace another writer's.
export const lambdaHandler = handler(
  async (req, { spaceId, invoker }) => {
    const body = parseJsonBody(req, { required: false, problem: invalidRequestBody });
    const { id: requestedId } = body;
    if (requestedId !== undefined) {
      assertId("collection", requestedId);
    }
    const collectionId = requestedId ?? randomUUID();
    if (
      (await headObject(spaceId, KEYS.collectionMeta(collectionId))) !== null ||
      (await hasContent(spaceId, collectionId))
    ) {
      throw idConflict(`A collection with id "${collectionId}" already exists.`);
    }
    const doc = composeCollectionMeta({ collectionId, body, stored: null, invoker });
    let written;
    try {
      written = await writeCollectionMeta(req, spaceId, collectionId, doc, { ifNoneMatch: "*" });
    } catch (err) {
      if (err?.status === 412) {
        throw idConflict(`A collection with id "${collectionId}" already exists.`);
      }
      throw err;
    }
    return json(req, 201, written.doc, {
      ...NO_STORE,
      Location: collectionUrl(req, spaceId, collectionId),
      ETag: written.etag,
    });
  },
  { scope: "space" }
);
