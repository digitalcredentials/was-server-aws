// The gateway's route table, as template.yaml declares it: which function
// each (method, route key) reaches, and whether the authorizer runs. The
// harness matches requests the way API Gateway does -- a literal segment
// beats a variable, and a variable in the last position matches an empty
// segment (which is how /space/{s}/ reaches the {collection_id} route).

const S = "/space/{space_id}";
const C = `${S}/{collection_id}`;
const R = `${C}/{resource_id}`;
const ANY = ["GET", "HEAD", "PUT", "POST", "DELETE"];

export const routes = [
  { methods: ["GET", "HEAD"], path: "/", fn: "service/get", auth: false },
  { methods: ["POST"], path: "/spaces", fn: "spaces/post" },
  { methods: ["POST"], path: "/spaces/{p}", fn: "spaces/post" },
  { methods: ["GET", "HEAD"], path: "/spaces", fn: "spaces/get" },
  { methods: ["GET", "HEAD"], path: "/spaces/{p}", fn: "spaces/get" },

  { methods: ["GET", "HEAD"], path: C, fn: "space/collections-get" },
  { methods: ["POST"], path: C, fn: "space/collection-create" },
  { methods: ["DELETE"], path: C, fn: "space/delete" },
  { methods: ["GET", "HEAD"], path: `${S}/meta`, fn: "space/meta-get" },
  { methods: ["PUT"], path: `${S}/meta`, fn: "space/meta-put" },
  { methods: ["GET", "HEAD"], path: `${S}/policy`, fn: "space/policy-get" },
  { methods: ["PUT"], path: `${S}/policy`, fn: "space/policy-put" },
  { methods: ["DELETE"], path: `${S}/policy`, fn: "space/policy-delete" },

  { methods: ["GET", "HEAD"], path: R, fn: "resource/get" },
  { methods: ["POST"], path: R, fn: "resource/create" },
  { methods: ["PUT"], path: R, fn: "resource/put" },
  { methods: ["DELETE"], path: R, fn: "resource/delete" },
  { methods: ["GET", "HEAD"], path: `${C}/meta`, fn: "collection/meta-get" },
  { methods: ["PUT"], path: `${C}/meta`, fn: "collection/meta-put" },
  { methods: ["GET", "HEAD"], path: `${C}/policy`, fn: "collection/policy-get" },
  { methods: ["PUT"], path: `${C}/policy`, fn: "collection/policy-put" },
  { methods: ["DELETE"], path: `${C}/policy`, fn: "collection/policy-delete" },

  { methods: ["GET", "HEAD"], path: `${R}/meta`, fn: "resource/meta-get" },
  { methods: ["PUT"], path: `${R}/meta`, fn: "resource/meta-put" },
  { methods: ["GET", "HEAD"], path: `${R}/policy`, fn: "resource/policy-get" },
  { methods: ["PUT"], path: `${R}/policy`, fn: "resource/policy-put" },
  { methods: ["DELETE"], path: `${R}/policy`, fn: "resource/policy-delete" },

  // The paths no endpoint owns (explicit routes, not $default, so the
  // browser's OPTIONS preflight reaches the gateway's CORS handling).
  { methods: ANY, path: S, fn: "default", auth: false },
  { methods: ANY, path: `${R}/{proxy+}`, fn: "default", auth: false },
];

// A path no route matches gets the gateway's own 404, not a function.
export const GATEWAY_404 = {
  statusCode: 404,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ message: "Not Found" }),
};

// Matches a delivered path against the table; returns the route and the
// path parameters, or null when no route matches.
export function matchRoute(method, path) {
  const segments = path === "/" ? [""] : path.split("/").slice(1);
  let best = null;
  for (const route of routes) {
    if (!route.methods.includes(method)) continue;
    const pattern = route.path === "/" ? [""] : route.path.split("/").slice(1);
    // A greedy {proxy+} in the last position takes the rest of the path.
    const greedy = pattern[pattern.length - 1] === "{proxy+}";
    if (greedy ? segments.length < pattern.length : pattern.length !== segments.length) continue;
    const params = {};
    let literals = 0;
    let ok = true;
    for (let index = 0; index < pattern.length; index++) {
      const part = pattern[index];
      if (part === "{proxy+}") {
        params.proxy = segments.slice(index).join("/");
        break;
      }
      const variable = /^\{(.+)\}$/.exec(part);
      if (variable) {
        params[variable[1]] = segments[index];
      } else if (part === segments[index]) {
        literals++;
      } else {
        ok = false;
        break;
      }
    }
    if (ok && (best === null || literals > best.literals)) {
      best = { route, params, literals };
    }
  }
  // No match: the gateway answers its own 404.
  return best ? { route: best.route, params: best.params } : null;
}
