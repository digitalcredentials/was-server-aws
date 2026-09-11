import { verifyZcap } from "./zcap.mjs";
import { isPublicRead } from "./publicRead.mjs";

// HTTP API Lambda authorizer (payload v2, simple responses) for zcap-signed
// invocations. verifyZcap reads rawPath / requestContext.http.method /
// headers, which the v2 REQUEST event carries.
//
// A denial is { isAuthorized: false } (API Gateway answers 403); handlers
// read the context off event.requestContext.authorizer.lambda.

export const lambdaHandler = async (event, context) => {
  // An unsigned request is allowed only as a public read: a GET covered by a
  // PublicCanRead policy at the resource, collection, or space scope.
  const hasAuthorization = Object.keys(event.headers ?? {}).some(
    (name) => name.toLowerCase() === "authorization"
  );
  if (!hasAuthorization) {
    if (await isPublicRead(event)) {
      return {
        isAuthorized: true,
        context: { controller: "public", capability: "", capabilityAction: "GET" },
      };
    }
    return { isAuthorized: false };
  }

  let result;
  try {
    result = await verifyZcap(event);
  } catch (err) {
    console.error("zcap verification failed:", err);
    return { isAuthorized: false };
  }

  const controller = String(result?.controller ?? "");

  // Context values have to be scalars - no nested objects or arrays.
  return {
    isAuthorized: true,
    context: {
      controller,
      // A root zcap comes back as its urn string; a delegated one as an object.
      capability: String(result?.capability?.id ?? result?.capability ?? ""),
      capabilityAction: String(result?.capabilityAction ?? ""),
    },
  };
};
