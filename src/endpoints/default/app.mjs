import { plainHandler } from "was-lib/handler.mjs";
import { redirect } from "was-lib/http.mjs";
import { isReserved, isValidSpaceId } from "was-lib/ids.mjs";
import { spaceUrl } from "was-lib/meta.mjs";
import { methodNotAllowed, notFound } from "was-lib/problems.mjs";

// The $default route: anything no endpoint route matched.
//   - the bare Space URL (/space/{s}, which has no route of its own) is a
//     308 to its canonical trailing-slash form;
//   - a reserved segment this server does not implement (linkset, quotas,
//     meta/log, chunks, ...) is the spec's 405;
//   - everything else is 404.
// Nothing here reads anything, so the function runs without the
// authorizer and without permissions.
export const lambdaHandler = plainHandler(async (req) => {
  const [first, spaceId, collectionId, resourceId, sub] = req.ids;
  if (first === "space" && isValidSpaceId(spaceId)) {
    if (req.ids.length === 2 && !req.trailingSlash) {
      return redirect(req, spaceUrl(req, spaceId));
    }
    if (
      isReserved("collection", collectionId) ||
      isReserved("resource", resourceId) ||
      ["meta", "policy", "chunks"].includes(sub)
    ) {
      throw methodNotAllowed();
    }
  }
  throw notFound();
});
