import { plainHandler } from "was-lib/handler.mjs";
import { json } from "was-lib/http.mjs";
import { serviceDescription } from "was-lib/service.mjs";

// GET, HEAD / -- the service description (WAS v0.5 discovery): what this
// server speaks and where its Spaces Repository is. Every response's
// `Link: <...>; rel="service"` header points here. No authorization; the
// gateway's CORS configuration adds Access-Control-Allow-Origin: *.
export const lambdaHandler = plainHandler(async (req) =>
  json(req, 200, serviceDescription(req), { "Cache-Control": "public, max-age=300" })
);
