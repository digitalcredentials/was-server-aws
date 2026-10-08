import { handler } from "was-lib/handler.mjs";
import { respond, noContent, preconditions, NO_STORE } from "was-lib/http.mjs";
import { resourceUrl } from "was-lib/meta.mjs";
import { writeResourceContent } from "was-lib/ops/content.mjs";

// PUT /space/{s}/{c}/{r} -- create (201 with Location) or replace (204) a
// Resource, under If-Match / If-None-Match: *, always answering the new
// ETag.
export const lambdaHandler = handler(
  async (req, { spaceId, collectionId, resourceId, invoker }) => {
    const written = await writeResourceContent(req, {
      spaceId,
      collectionId,
      resourceId,
      invoker,
      preconditions: preconditions(req),
    });
    if (written.created) {
      return respond(req, {
        status: 201,
        headers: {
          ...NO_STORE,
          Location: resourceUrl(req, spaceId, collectionId, resourceId),
          ETag: written.etag,
        },
      });
    }
    return noContent(req, { ...NO_STORE, ETag: written.etag });
  },
  { scope: "resource" }
);
