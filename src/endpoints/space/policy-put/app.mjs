import { handler } from "was-lib/handler.mjs";
import { putPolicy } from "was-lib/ops/policy.mjs";

// PUT /space/{s}/policy.
export const lambdaHandler = handler(putPolicy, { scope: "space-policy", readable: false });
