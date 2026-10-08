import { handler } from "was-lib/handler.mjs";
import { respond, json } from "was-lib/http.mjs";
import { KEYS, getObject, headObject, listObjects } from "was-lib/store.mjs";
import { readCollectionMeta, collectionUrl, resourceUrl, CONTENT_META } from "was-lib/meta.mjs";
import { notFound } from "was-lib/problems.mjs";
import { pageLimit, nextLink } from "was-lib/ops/listing.mjs";

// GET, HEAD /space/{s}/{c}/{r} -- a Resource's content, with its ETag and
// Last-Modified (If-None-Match answers 304); or, with an empty resource_id
// (the gateway's reading of /space/{s}/{c}/), the Collection's Resources,
// one S3 page at a time.

async function getResource(req, { spaceId, collectionId, resourceId }) {
  const object = await getObject(spaceId, KEYS.resource(collectionId, resourceId), {
    ifNoneMatch: req.headers["if-none-match"],
  });
  if (object === null) {
    throw notFound();
  }
  if (object.notModified) {
    return respond(req, { status: 304, headers: { ETag: req.headers["if-none-match"] } });
  }
  return respond(req, {
    status: 200,
    headers: {
      ETag: object.etag,
      ...(object.lastModified && { "Last-Modified": object.lastModified.toUTCString() }),
    },
    body: object.body,
    contentType: object.contentType ?? "application/octet-stream",
  });
}

async function listResources(req, { spaceId, collectionId, authorized }) {
  const url = collectionUrl(req, spaceId, collectionId);
  if (!authorized) {
    return json(req, 200, { id: collectionId, url, type: ["Collection"], totalItems: 0, items: [] });
  }
  const meta = await readCollectionMeta(req, spaceId, collectionId);
  if (meta === null) {
    throw notFound();
  }
  const limit = pageLimit(req);
  const prefix = KEYS.collectionPrefix(collectionId);
  const page = await listObjects(spaceId, { prefix, delimiter: "/", cursor: req.query.cursor, limit });
  const items = await Promise.all(
    page.objects
      .map((object) => ({ ...object, id: object.key.slice(prefix.length) }))
      .filter((object) => object.id !== "")
      .map(async (object) => {
        const head = await headObject(spaceId, object.key);
        const stamped = head?.metadata ?? {};
        return {
          id: object.id,
          url: resourceUrl(req, spaceId, collectionId, object.id),
          contentType: head?.contentType ?? "application/octet-stream",
          size: object.size,
          ...(object.lastModified && { updatedAt: object.lastModified.toISOString() }),
          ...(stamped[CONTENT_META.epoch] && { epoch: stamped[CONTENT_META.epoch] }),
          ...(stamped[CONTENT_META.writerId] && { writerId: stamped[CONTENT_META.writerId] }),
        };
      })
  );
  return json(req, 200, {
    id: collectionId,
    url,
    ...(typeof meta.doc.name === "string" && { name: meta.doc.name }),
    type: meta.doc.type ?? ["Collection"],
    totalItems: items.length,
    items,
    ...(page.next && { next: nextLink(url, page.next, limit) }),
  });
}

export const lambdaHandler = handler(
  (req, route) => (route.resourceId ? getResource(req, route) : listResources(req, route)),
  { scope: "collection", listing: (route) => !route.resourceId }
);
