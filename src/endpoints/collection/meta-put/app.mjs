import { handler } from "was-lib/handler.mjs";
import { json, parseJsonBody, preconditions, NO_STORE } from "was-lib/http.mjs";
import { KEYS, headObject } from "was-lib/store.mjs";
import { readCollectionMeta, composeCollectionMeta, writeCollectionMeta } from "was-lib/meta.mjs";
import { invalidRequestBody } from "was-lib/problems.mjs";

// PUT /space/{s}/{c}/meta -- a full replacement of the writable members
// (configuration and the custom/epoch annotation), under If-Match /
// If-None-Match; with If-None-Match: * it creates the Collection (201).
// Root capability only (the container rule).
export const lambdaHandler = handler(
  async (req, { spaceId, collectionId, invoker }) => {
    const body = parseJsonBody(req, { problem: invalidRequestBody });
    if (body.id !== undefined && body.id !== collectionId) {
      throw invalidRequestBody('"id" does not match the Collection addressed by the URL.');
    }
    const existed = (await headObject(spaceId, KEYS.collectionMeta(collectionId))) !== null;
    const stored = existed ? (await readCollectionMeta(req, spaceId, collectionId))?.doc : null;
    const doc = composeCollectionMeta({ collectionId, body, stored, invoker });
    const written = await writeCollectionMeta(req, spaceId, collectionId, doc, preconditions(req));
    return json(req, existed ? 200 : 201, written.doc, { ...NO_STORE, ETag: written.etag });
  },
  { scope: "collection-meta", rootOnly: true }
);
