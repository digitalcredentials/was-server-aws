import { randomUUID } from "node:crypto";
import { handler } from "was-lib/handler.mjs";
import { json, NO_STORE } from "was-lib/http.mjs";
import { resourceUrl } from "was-lib/meta.mjs";
import { methodNotAllowed } from "was-lib/problems.mjs";
import { writeResourceContent } from "was-lib/ops/content.mjs";

// POST /space/{s}/{c}/ -- create a Resource with a server-assigned id
// (create-if-absent, so the id cannot collide). POST on a Resource URL
// (a non-empty resource_id) is not an operation.
export const lambdaHandler = handler(
  async (req, { spaceId, collectionId, resourceId, invoker }) => {
    if (resourceId) {
      throw methodNotAllowed();
    }
    const id = randomUUID();
    const written = await writeResourceContent(req, {
      spaceId,
      collectionId,
      resourceId: id,
      invoker,
      preconditions: { ifNoneMatch: "*" },
    });
    const url = resourceUrl(req, spaceId, collectionId, id);
    return json(req, 201, { id, url }, { ...NO_STORE, Location: url, ETag: written.etag });
  },
  { scope: "collection" }
);
