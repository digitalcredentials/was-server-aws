import { handler } from "was-lib/handler.mjs";
import { noContent, preconditions, NO_STORE } from "was-lib/http.mjs";
import { KEYS, headObject, deleteObject, deletePrefix } from "was-lib/store.mjs";
import { readCollectionMeta } from "was-lib/meta.mjs";
import { notFound } from "was-lib/problems.mjs";

// DELETE /space/{s}/{c}/{r} -- a Resource, permanently, with its metadata
// and policy (If-Match honored); or, with an empty resource_id (the
// gateway's reading of /space/{s}/{c}/), the whole Collection with
// everything it holds, which only the root capability may do.

async function deleteResource(req, { spaceId, collectionId, resourceId }) {
  const key = KEYS.resource(collectionId, resourceId);
  if ((await headObject(spaceId, key)) === null) {
    throw notFound();
  }
  await deleteObject(spaceId, key, preconditions(req));
  await deleteObject(spaceId, KEYS.resourceMeta(collectionId, resourceId));
  await deleteObject(spaceId, KEYS.resourcePolicy(collectionId, resourceId));
  return noContent(req, NO_STORE);
}

async function deleteCollection(req, { spaceId, collectionId }) {
  if ((await readCollectionMeta(req, spaceId, collectionId)) === null) {
    throw notFound();
  }
  await deletePrefix(spaceId, KEYS.collectionPrefix(collectionId));
  await deletePrefix(spaceId, KEYS.collectionMetaPrefix(collectionId));
  await deletePrefix(spaceId, KEYS.collectionPolicyPrefix(collectionId));
  await deleteObject(spaceId, KEYS.collectionMeta(collectionId));
  await deleteObject(spaceId, KEYS.collectionPolicy(collectionId));
  return noContent(req, NO_STORE);
}

export const lambdaHandler = handler(
  (req, route) => (route.resourceId ? deleteResource(req, route) : deleteCollection(req, route)),
  { scope: "collection", rootOnly: (route) => !route.resourceId }
);
