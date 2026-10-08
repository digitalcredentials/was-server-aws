import { handler } from "was-lib/handler.mjs";
import { json, parseJsonBody, preconditions, NO_STORE } from "was-lib/http.mjs";
import { KEYS, putJson } from "was-lib/store.mjs";
import { readResourceMeta, now } from "was-lib/meta.mjs";
import { invalidRequestBody, notFound } from "was-lib/problems.mjs";

// PUT /space/{s}/{c}/{r}/meta -- replaces the custom annotation (stored as
// its own document under meta/, versioned by its own ETag) under If-Match /
// If-None-Match: *, answering the merged metadata object and the
// annotation's new ETag (201 on the first write).
export const lambdaHandler = handler(
  async (req, { spaceId, collectionId, resourceId }) => {
    const current = await readResourceMeta(spaceId, collectionId, resourceId);
    if (current === null) {
      throw notFound();
    }
    const { custom } = parseJsonBody(req, { required: false, problem: invalidRequestBody });
    if (custom !== undefined && custom !== null && (typeof custom !== "object" || Array.isArray(custom))) {
      throw invalidRequestBody('"custom" must be an object.');
    }
    const stamp = now();
    const doc = {
      ...(custom !== undefined && custom !== null && { custom }),
      createdAt: current.stored?.doc?.createdAt ?? stamp,
      updatedAt: stamp,
    };
    const { etag } = await putJson(spaceId, KEYS.resourceMeta(collectionId, resourceId), doc, preconditions(req));
    const merged = (await readResourceMeta(spaceId, collectionId, resourceId))?.doc ?? doc;
    return json(req, current.stored ? 200 : 201, merged, { ...NO_STORE, ETag: etag });
  },
  { scope: "resource-meta" }
);
