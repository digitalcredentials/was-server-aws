// Prints a freshly-signed API Gateway REQUEST authorizer event to stdout.
//
//   node events/sign.mjs <route> [--invalid]
//   node events/sign.mjs space-description-get | sam local invoke WASZcapAuthorizerFn -e -
//
// Signing on demand means the invocation carries the signer's natural 10 minute
// expiry rather than a pinned far-future one, and nothing signed is committed.
//
// Everything this prints on stdout is the event JSON; diagnostics go to stderr
// so the pipe above stays clean.

import { signCapabilityInvocation } from "@interop/http-signature-zcap-invoke";
import { Ed25519VerificationKey } from "@interop/ed25519-verification-key";

import { authorizerEvent, routeOrDie, routes, targetUrl } from "./routes.mjs";

// The authorizer looks up each space's controller DID in the accounts table
// (see src/authorizer/zcap.mjs). For a signature from this seed to verify, the
// key it derives must be that registered DID: check.mjs stubs the lookup to
// return exactly this key's controller; against a real deployment the account
// for SPACE_ID has to be registered with it.
const TEST_SEED = "my-secret-seed-that-is-long-enou";

const keyPair = await Ed25519VerificationKey.generate({
  seed: new TextEncoder().encode(TEST_SEED),
});
keyPair.controller = `did:key:${keyPair.fingerprint()}`;
keyPair.id = `${keyPair.controller}#${keyPair.fingerprint()}`;

export const controller = keyPair.controller;

const invocationSigner = keyPair.signer();

export async function signedHeaders(route) {
  const url = targetUrl(route);
  // `capability` defaults to `urn:zcap:root:<encoded url>`, which is exactly the
  // root capability the authorizer expects. The signature covers
  // `(request-target)` and `host`, so it is bound to this one route. Routes
  // with a body also get a digest header signed over the JSON payload.
  const signed = await signCapabilityInvocation({
    url,
    method: route.method,
    headers: { host: new URL(url).host, accept: "application/json" },
    ...(route.body != null && { json: JSON.parse(route.body) }),
    capabilityAction: route.method,
    invocationSigner,
  });
  return {
    ...signed,
    // API Gateway sets this, and the authorizer reads it to rebuild the URL.
    "X-Forwarded-Proto": new URL(url).protocol.replace(":", ""),
  };
}

// Corrupts the signature while leaving the header well-formed, so the request
// fails verification rather than parsing.
function tamper(headers) {
  return {
    ...headers,
    authorization: headers.authorization.replace(
      /signature="[^"]+"/,
      'signature="aW52YWxpZC1zaWduYXR1cmU="'
    ),
  };
}

export async function signedAuthorizerEvent(name, { invalid = false } = {}) {
  const route = routeOrDie(name);
  const headers = await signedHeaders(route);
  return authorizerEvent(route, invalid ? tamper(headers) : headers);
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const invalid = args.includes("--invalid");
  const name = args.find((a) => !a.startsWith("--"));

  if (!name) {
    console.error(
      `usage: node events/sign.mjs <route> [--invalid]\n\nroutes:\n  ${Object.keys(
        routes
      ).join("\n  ")}`
    );
    process.exit(1);
  }

  try {
    const event = await signedAuthorizerEvent(name, { invalid });
    console.error(`signed ${name}${invalid ? " (tampered)" : ""} as ${controller}`);
    process.stdout.write(JSON.stringify(event, null, 2) + "\n");
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
