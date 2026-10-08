import { handler } from "was-lib/handler.mjs";
import { putPolicy } from "was-lib/ops/policy.mjs";

// PUT /space/{s}/{c}/{r}/policy.
export const lambdaHandler = handler(putPolicy, { scope: "resource-policy", readable: false });
