import { handler } from "was-lib/handler.mjs";
import { deletePolicy } from "was-lib/ops/policy.mjs";

// DELETE /space/{s}/{c}/{r}/policy.
export const lambdaHandler = handler(deletePolicy, { scope: "resource-policy", readable: false });
