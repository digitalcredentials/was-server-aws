import { plainHandler } from "was-lib/handler.mjs";
import { json } from "was-lib/http.mjs";

// GET, HEAD / -- the service description (WAS v0.5 discovery): what this
// server speaks and where its Spaces Repository is. Every response's
// `Link: <...>; rel="service"` header points here. No authorization; the
// gateway's CORS configuration adds Access-Control-Allow-Origin: *.

const SPEC_ID = "https://w3id.org/pws";
const SPEC_VERSION = "0.5";

// Open token list; a client ignores tokens it does not know.
const FEATURES = [
  "spaces-repository",
  "listing",
  "collection-management",
  "space-management",
  "resource-metadata",
  "conditional-writes",
  "policies",
];

export const lambdaHandler = plainHandler(async (req) =>
  json(
    req,
    200,
    {
      url: `${req.base}/`,
      specs: {
        [SPEC_ID]: [
          {
            version: SPEC_VERSION,
            url: "https://w3c-ccg.github.io/wallet-attached-storage-spec/",
            spaces: `${req.base}/spaces/`,
            features: FEATURES,
          },
        ],
      },
      instance: {
        name: "was-server-aws",
        version: process.env.INSTANCE_VERSION ?? "0.0.0",
        source: "https://github.com/digitalcredentials/was-server-aws",
      },
    },
    { "Cache-Control": "public, max-age=300" }
  )
);
