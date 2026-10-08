import { handler } from "was-lib/handler.mjs";
import { json } from "was-lib/http.mjs";
import { readSpaceMeta } from "was-lib/meta.mjs";
import { notFound } from "was-lib/problems.mjs";

// GET, HEAD /space/{s}/meta -- the Space Metadata object, with its ETag.
export const lambdaHandler = handler(
  async (req, { spaceId }) => {
    const stored = await readSpaceMeta(req, spaceId);
    if (stored === null) {
      throw notFound();
    }
    return json(req, 200, stored.doc, { ETag: stored.etag });
  },
  { scope: "space-meta" }
);
