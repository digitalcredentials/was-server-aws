// Rewrites the static proxy-integration fixtures in this directory.
//
//   cd events && npm run generate
//
// These are the events a route handler sees. They are deliberately unsigned:
// the authorizer has already run by the time a handler is invoked, and no
// handler reads the Authorization header, so a signature here would be
// decoration that goes stale. Authorizer events are signed on demand instead -
// see sign.mjs.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { proxyEvent, routes, targetUrl } from "./routes.mjs";

const OUT_DIR = dirname(fileURLToPath(import.meta.url));

// The controller the authorizer would have resolved, mirrored here so handler
// code that reads the invoker finds something realistic. Kept in sync with
// sign.mjs by events/check.mjs, which asserts the two agree.
const CONTROLLER =
  "did:key:z6MkuoW15WTT6ty3coLfS294WKdndim1fteTWK76dMGVUUxk";

for (const [name, route] of Object.entries(routes)) {
  const event = proxyEvent(route, {
    controller: CONTROLLER,
    capability: `urn:zcap:root:${encodeURIComponent(targetUrl(route))}`,
  });
  writeFileSync(
    join(OUT_DIR, `${name}.json`),
    JSON.stringify(event, null, 2) + "\n"
  );
  console.log(`wrote ${name}.json`);
}
