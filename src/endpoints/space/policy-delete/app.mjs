import { handler } from "was-lib/handler.mjs";
import { deletePolicy } from "was-lib/ops/policy.mjs";

// DELETE /space/{s}/policy.
export const lambdaHandler = handler(deletePolicy, { scope: "space-policy", readable: false });
