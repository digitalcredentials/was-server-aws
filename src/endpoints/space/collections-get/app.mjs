import { handler } from "was-lib/handler.mjs";
import { json } from "was-lib/http.mjs";
import { KEYS, getJson, listAllPrefixes, listAllKeys } from "was-lib/store.mjs";
import { collectionUrl, spaceUrl } from "was-lib/meta.mjs";
import { pageLimit, nextLink, offsetCursor, readOffsetCursor } from "was-lib/ops/listing.mjs";

// GET, HEAD /space/{s}/ -- the Collections in the Space: every one with a
// metadata object, plus any implicit one (content under collections/ with
// no metadata). Both are small sets, so they are read whole and paged in
// memory. The gateway delivers the trailing-slash URL to the
// {collection_id} route with an empty id; a non-empty id (the bare
// Collection URL) is answered with a 308 by the handler wrapper.
export const lambdaHandler = handler(
  async (req, { spaceId, authorized }) => {
    const url = spaceUrl(req, spaceId);
    if (!authorized) {
      return json(req, 200, { url, totalItems: 0, items: [] });
    }
    const limit = pageLimit(req);
    const offset = readOffsetCursor(req.query.cursor);

    const [metaKeys, contentPrefixes] = await Promise.all([
      listAllKeys(spaceId, "meta/"),
      listAllPrefixes(spaceId, "collections/"),
    ]);
    const ids = new Set();
    for (const key of metaKeys) {
      const match = /^meta\/([^/]+)\.json$/.exec(key);
      if (match && match[1] !== "space") {
        ids.add(match[1]);
      }
    }
    for (const prefix of contentPrefixes) {
      ids.add(prefix.slice("collections/".length, -1));
    }
    const sorted = [...ids].sort();
    const page = sorted.slice(offset, offset + limit);
    const items = await Promise.all(
      page.map(async (collectionId) => {
        const stored = await getJson(spaceId, KEYS.collectionMeta(collectionId));
        const doc = stored?.doc ?? {};
        return {
          id: collectionId,
          url: collectionUrl(req, spaceId, collectionId),
          name: typeof doc.name === "string" ? doc.name : collectionId,
          type: Array.isArray(doc.type) ? doc.type : ["Collection"],
          ...(doc.encryption && { encryption: doc.encryption }),
        };
      })
    );
    const nextOffset = offset + page.length;
    return json(req, 200, {
      url,
      totalItems: items.length,
      items,
      ...(nextOffset < sorted.length && { next: nextLink(url, offsetCursor(nextOffset), limit) }),
    });
  },
  { scope: "space", listing: true }
);
