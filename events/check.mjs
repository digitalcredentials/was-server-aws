// Signs a fresh invocation for every route and runs it through the real
// authorizer, in process. No files, no Docker, no AWS: the accounts-table
// lookup is stubbed below, so this checks the verification logic rather than
// live table state.
//
//   cd events && npm test

import { createRequire } from "node:module";

import { lambdaHandler } from "../src/authorizer/app.mjs";
import { controller, signedAuthorizerEvent } from "./sign.mjs";
import { routes } from "./routes.mjs";

// The authorizer resolves the space's controller DID from DynamoDB
// (getSpaceControllerDid in src/authorizer/zcap.mjs). Stub the client it uses
// - resolved from the authorizer's own node_modules - to register the test
// signing key as every space's controller, complete with the key fragment the
// real table rows carry, so the fragment-stripping stays exercised.
const authorizerRequire = createRequire(
  new URL("../src/authorizer/app.mjs", import.meta.url)
);
const { DynamoDBClient } = authorizerRequire("@aws-sdk/client-dynamodb");
DynamoDBClient.prototype.send = async () => ({
  Items: [{ did: { S: `${controller}#${controller.slice("did:key:".length)}` } }],
});

let failures = 0;

function report(name, ok, detail) {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failures++;
}

for (const name of Object.keys(routes)) {
  const event = await signedAuthorizerEvent(name);
  try {
    // HTTP API simple response: { isAuthorized, context }
    const res = await lambdaHandler(event, {});
    const ok =
      res.isAuthorized === true &&
      res.context.controller === controller &&
      res.context.capability.startsWith("urn:zcap:root:");
    report(name, ok, `isAuthorized=${res.isAuthorized} capability=${res.context?.capability ? "set" : "EMPTY"}`);
  } catch (err) {
    report(name, false, `threw "${err.message}"`);
  }
}

// A tampered signature must produce a denial ({ isAuthorized: false }), which
// API Gateway answers with a 403 - never an allow, and never a thrown error
// (that would be a 500).
const bad = await signedAuthorizerEvent("space-description-get", { invalid: true });
try {
  const res = await lambdaHandler(bad, {});
  report("tampered signature rejected", res.isAuthorized === false, `isAuthorized=${res.isAuthorized}`);
} catch (err) {
  report("tampered signature rejected", false, `threw "${err.message}" instead of denying`);
}

// The static proxy fixtures embed the controller; make sure it still matches
// the key sign.mjs derives, so a seed change cannot leave them quietly stale.
const { default: proxy } = await import("./space-description-get.json", {
  with: { type: "json" },
});
report(
  "proxy fixture controller matches signing key",
  proxy.requestContext.authorizer.lambda.controller === controller,
  proxy.requestContext.authorizer.lambda.controller
);

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
