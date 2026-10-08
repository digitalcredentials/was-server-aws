import { handler } from "was-lib/handler.mjs";
import { json } from "was-lib/http.mjs";
import { readResourceMeta } from "was-lib/meta.mjs";
import { notFound } from "was-lib/problems.mjs";

// GET, HEAD /space/{s}/{c}/{r}/meta -- the Resource Metadata object:
// members derived from the content object's head (content type, size,
// creation and update times, key epoch, writer) plus the stored custom
// annotation, whose ETag is the object's validator once one has been
// written.
export const lambdaHandler = handler(
  async (req, { spaceId, collectionId, resourceId }) => {
    const current = await readResourceMeta(spaceId, collectionId, resourceId);
    if (current === null) {
      throw notFound();
    }
    return json(req, 200, current.doc, current.etag ? { ETag: current.etag } : {});
  },
  { scope: "resource-meta" }
);
