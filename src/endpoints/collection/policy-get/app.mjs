import { handler } from "was-lib/handler.mjs";
import { getPolicy } from "was-lib/ops/policy.mjs";

// GET /space/{s}/{c}/policy.
export const lambdaHandler = handler(getPolicy, { scope: "collection-policy", readable: false });
