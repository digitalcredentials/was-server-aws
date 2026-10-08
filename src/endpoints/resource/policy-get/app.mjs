import { handler } from "was-lib/handler.mjs";
import { getPolicy } from "was-lib/ops/policy.mjs";

// GET /space/{s}/{c}/{r}/policy.
export const lambdaHandler = handler(getPolicy, { scope: "resource-policy", readable: false });
