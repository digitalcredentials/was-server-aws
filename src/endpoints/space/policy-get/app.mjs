import { handler } from "was-lib/handler.mjs";
import { getPolicy } from "was-lib/ops/policy.mjs";

// GET /space/{s}/policy.
export const lambdaHandler = handler(getPolicy, { scope: "space-policy", readable: false });
