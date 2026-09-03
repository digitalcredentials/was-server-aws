import { verifyZcap } from "./zcap.mjs";

// API Gateway REQUEST authorizer for zcap-signed invocations.
//
// A REQUEST authorizer event carries `headers`, `path` and `httpMethod` under
// the same names a proxy-integration event does, which is what verifyZcap
// reads, so the event goes straight through.

function policy(principalId, effect, resource, context) {
  return {
    principalId,
    policyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Action: "execute-api:Invoke",
          Effect: effect,
          Resource: resource,
        },
      ],
    },
    context,
  };
}

export const lambdaHandler = async (event, context) => {
  let result;
  try {
    result = await verifyZcap(event);
  } catch (err) {
    console.error("zcap verification failed:", err);
    // API Gateway maps an error with this exact message to a 401. Anything
    // else surfaces as a 500, so don't rethrow the underlying error.
    throw new Error("Unauthorized");
  }

  const controller = String(result?.controller ?? "");

  // Authorizer context values have to be scalars - no nested objects or arrays.
  // Handlers read these off event.requestContext.authorizer.
  return policy(controller || "zcap-invoker", "Allow", event.methodArn, {
    controller,
    // A root zcap comes back as its urn string; a delegated one as an object.
    capability: String(result?.capability?.id ?? result?.capability ?? ""),
    capabilityAction: String(result?.capabilityAction ?? ""),
  });
};
