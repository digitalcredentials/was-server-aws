// Signs a fresh invocation for every route and runs it through the real
// authorizer, in process. No files, no Docker.
//
//   cd events && npm test

import { lambdaHandler } from "../src/authorizer/app.mjs";
import { controller, signedAuthorizerEvent } from "./sign.mjs";
import { routes } from "./routes.mjs";

let failures = 0;

function report(name, ok, detail) {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failures++;
}

for (const name of Object.keys(routes)) {
  const event = await signedAuthorizerEvent(name);
  try {
    const res = await lambdaHandler(event, {});
    const statement = res.policyDocument.Statement[0];
    const ok =
      statement.Effect === "Allow" &&
      statement.Resource === event.methodArn &&
      res.context.controller === controller &&
      res.context.capability.startsWith("urn:zcap:root:");
    report(name, ok, `Effect=${statement.Effect} capability=${res.context.capability ? "set" : "EMPTY"}`);
  } catch (err) {
    report(name, false, `threw "${err.message}"`);
  }
}

// A tampered signature must produce a 401, which API Gateway keys off this
// exact message - not an Allow, and not a different error.
const bad = await signedAuthorizerEvent("space-description-get", { invalid: true });
try {
  await lambdaHandler(bad, {});
  report("tampered signature rejected", false, "returned a policy instead of throwing");
} catch (err) {
  report("tampered signature rejected", err.message === "Unauthorized", `threw "${err.message}"`);
}

// The static proxy fixtures embed the controller; make sure it still matches
// the key sign.mjs derives, so a seed change cannot leave them quietly stale.
const { default: proxy } = await import("./space-description-get.json", {
  with: { type: "json" },
});
report(
  "proxy fixture controller matches signing key",
  proxy.requestContext.authorizer.controller === controller,
  proxy.requestContext.authorizer.controller
);

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
