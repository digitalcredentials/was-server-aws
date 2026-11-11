import { plainHandler } from "was-lib/handler.mjs";
import { json } from "was-lib/http.mjs";
import { serviceDescription } from "was-lib/service.mjs";

// GET, HEAD /service and / -- the service description (PWS v0.5 discovery):
// what this server speaks and where its Spaces Repository is. Every
// response's `Link: <...>; rel="service"` header points at /service, which
// is also where a client built on a base server URL (pws-client, FreeWallet)
// reads it without following the link; / answers the same document. No
// authorization; the gateway's CORS configuration adds
// Access-Control-Allow-Origin: *.
export const lambdaHandler = plainHandler(async (req) =>
  json(req, 200, serviceDescription(req), { "Cache-Control": "public, max-age=300" })
);
