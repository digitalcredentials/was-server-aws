import { handler } from "was-lib/handler.mjs";
import { putPolicy } from "was-lib/ops/policy.mjs";

// PUT /space/{s}/{c}/policy.
export const lambdaHandler = handler(putPolicy, { scope: "collection-policy", readable: false });
