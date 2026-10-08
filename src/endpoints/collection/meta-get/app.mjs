import { handler } from "was-lib/handler.mjs";
import { json } from "was-lib/http.mjs";
import { readCollectionMeta } from "was-lib/meta.mjs";
import { notFound } from "was-lib/problems.mjs";

// GET, HEAD /space/{s}/{c}/meta -- the Collection Metadata object with its
// ETag; an implicit Collection (content, no metadata) gets a synthesized,
// unversioned one.
export const lambdaHandler = handler(
  async (req, { spaceId, collectionId }) => {
    const meta = await readCollectionMeta(req, spaceId, collectionId);
    if (meta === null) {
      throw notFound();
    }
    return json(req, 200, meta.doc, meta.etag ? { ETag: meta.etag } : {});
  },
  { scope: "collection-meta" }
);
