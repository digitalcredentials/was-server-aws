import { handler } from "was-lib/handler.mjs";
import { json, parseJsonBody, NO_STORE } from "was-lib/http.mjs";
import { readCollectionMeta } from "was-lib/meta.mjs";
import { changesPage } from "was-lib/feed.mjs";
import { invalidRequestBody, notFound, unsupportedOperation } from "was-lib/problems.mjs";

// POST /space/{s}/{c}/query -- the Collection query endpoint (PWS v0.5,
// Query Profile Registry), serving the `changes` profile: an ordered,
// resumable feed of the Collection's changes for a replicating client. The
// parameters travel in the signed JSON body, or in the query string of the
// GET form a read-only capability uses. Any other profile is 501. A query
// needs read authorization: a capability covering the Collection, or a
// PublicCanRead policy.
export const lambdaHandler = handler(
  async (req, { spaceId, collectionId }) => {
    if ((await readCollectionMeta(req, spaceId, collectionId)) === null) {
      throw notFound();
    }
    const params = req.method === "GET" ? req.query : parseJsonBody(req, { problem: invalidRequestBody });
    if (typeof params.profile !== "string" || params.profile.length === 0) {
      throw invalidRequestBody('The query carries no "profile".', {
        errors: [{ detail: 'The query carries no "profile".', pointer: "#/profile" }],
      });
    }
    if (params.profile !== "changes") {
      throw unsupportedOperation(`The "${params.profile}" query profile is not served.`);
    }
    const page = await changesPage(req, {
      spaceId,
      collectionId,
      checkpoint: params.checkpoint === undefined || params.checkpoint === null ? undefined : params.checkpoint,
      limit: params.limit,
    });
    return json(req, 200, page, NO_STORE);
  },
  { scope: "collection-query", policyRead: true }
);
