import { plainHandler } from "was-lib/handler.mjs";
import { redirect } from "was-lib/http.mjs";
import { isReserved, isValidSpaceId, UNIMPLEMENTED_SEGMENTS } from "was-lib/ids.mjs";
import { spaceUrl } from "was-lib/meta.mjs";
import { methodNotAllowed, notFound, unsupportedOperation } from "was-lib/problems.mjs";

// The $default route: anything no endpoint route matched.
//   - the bare Space URL (/space/{s}, which has no route of its own) is a
//     308 to its canonical trailing-slash form;
//   - an optional operation this server does not implement (linksets,
//     quotas, backends, replicas, chunks, revocations) is the spec's
//     unsupported-operation (501), so a client learns the section is absent
//     rather than the method wrong;
//   - a method the spec does not define at a reserved endpoint (meta,
//     policy as a Resource id, say) is 405;
//   - everything else is 404.
// Nothing here reads anything, so the function runs without the
// authorizer and without permissions.

export const lambdaHandler = plainHandler(async (req) => {
  const [first, spaceId, collectionId, resourceId, sub] = req.ids;
  if (first === "space" && isValidSpaceId(spaceId)) {
    if (req.ids.length === 2 && !req.trailingSlash) {
      return redirect(req, spaceUrl(req, spaceId));
    }
    if (UNIMPLEMENTED_SEGMENTS.has(collectionId) || UNIMPLEMENTED_SEGMENTS.has(resourceId) || UNIMPLEMENTED_SEGMENTS.has(sub)) {
      throw unsupportedOperation("This server does not implement the optional section the URL names.");
    }
    if (isReserved("collection", collectionId) || isReserved("resource", resourceId) || ["meta", "policy"].includes(sub)) {
      throw methodNotAllowed();
    }
  }
  throw notFound();
});
