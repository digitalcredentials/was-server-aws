import { handler } from "was-lib/handler.mjs";
import { deletePolicy } from "was-lib/ops/policy.mjs";

// DELETE /space/{s}/{c}/policy.
export const lambdaHandler = handler(deletePolicy, { scope: "collection-policy", readable: false });
