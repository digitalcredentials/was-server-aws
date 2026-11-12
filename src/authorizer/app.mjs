// Must be evaluated before @interop/jsonld (CJS) is pulled in by the
// verification stack, which require()s this ESM package mid-graph and hits a
// TDZ error otherwise.
import "@interop/http-client";

import { deriveSpaceId } from "was-lib/webvh.mjs";
import { verifyInvocation, signerDid, rootCapabilityId } from "./zcap.mjs";
import { getSpace } from "./registry.mjs";
import { composeChainInspectors } from "./chain.mjs";
import { revocationChainInspector } from "./revocations.mjs";
import { clientAnnexChainInspector } from "./annex.mjs";
import { containerRuleInspector } from "./container.mjs";

// The HTTP API's REQUEST authorizer (payload v2, simple responses): it
// verifies a signed request's capability invocation and reports the result
// in the request context. It never denies -- a gateway denial is always a
// 403, and the spec's answers to an unauthorized request (404, an empty
// listing, 401 for an unsigned write) are shaped by the endpoint functions
// from this context. Context values must be strings.
//
//   signed           "true" when an Authorization header was present
//   verified         "true" when the invocation verified
//   controller       the verified signer's DID (the invoker)
//   delegated        "true" when a delegated capability was invoked
//   denial           when the invocation did not verify and the invoker
//                    holds the grant that failed: "capability-revoked" or
//                    "capability-expired" (the named 404s); else ""
//   space            "missing" when the URL names a Space the registry
//                    does not hold; "unregistered" when it does not hold
//                    it but the id is derived from the signing DID (an
//                    unlock Space about to be provisioned)
//   spaceController  the Space's registered controller DID
//   spaceType        the Space's type array, as JSON
//
// For a Space URL the invocation is verified against the Space's registered
// controller; for the Spaces Repository (no Space in the URL), and for an
// unregistered Space whose id the signer derived from its own DID, against
// the DID that signed it, which the handler then compares to the stated
// controller. The controller may be a did:key or a did:webvh (zcap.mjs).
//
// A delegated chain also passes the chain inspectors: the Space's
// revocation records (revocations.mjs) and the client-annex clause
// (annex.mjs), which reads the operation's target and method.

function header(headers, name) {
  const match = Object.keys(headers).find((key) => key.toLowerCase() === name);
  return match === undefined ? undefined : headers[match];
}

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// The inspectors for one operation: revocations where a registered Space
// scopes them, the clause everywhere.
const inspectorFor = ({ base, spaceId, target, method }) =>
  composeChainInspectors([
    ...(spaceId !== undefined ? [revocationChainInspector(spaceId)] : []),
    clientAnnexChainInspector({ serverUrl: base, invocation: { target, action: method } }),
    containerRuleInspector({ serverUrl: base, invocation: { target, action: method } }),
  ]);

function record(context, result) {
  if (result.verified) {
    context.verified = "true";
    context.controller = result.controller;
    context.delegated = String(result.delegated);
  } else if (result.denial) {
    context.denial = result.denial;
  }
}

export const lambdaHandler = async (event) => {
  const headers = event.headers ?? {};
  const method = event.requestContext?.http?.method ?? event.httpMethod;
  const rawPath = event.rawPath ?? event.requestContext?.path ?? event.path ?? "/";
  const proto = header(headers, "x-forwarded-proto") ?? "https";
  const host = header(headers, "host") ?? event.requestContext?.domainName;
  const search = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const base = `${proto}://${host}`;

  // The URL as delivered (API Gateway hands the path percent-decoded) and
  // the URL the client signed, re-encoded from the decoded segments.
  const trailingSlash = rawPath.length > 1 && rawPath.endsWith("/");
  const segments = rawPath === "/" ? [] : rawPath.split("/").slice(1).map(decodeSegment);
  const ids = trailingSlash ? segments.slice(0, -1) : segments;
  const encodedPath = "/" + ids.map(encodeURIComponent).join("/") + (trailingSlash ? "/" : "");
  const urls = [...new Set([`${base}${rawPath}${search}`, `${base}${encodedPath}${search}`])];
  // The operation's canonical target, for the clause's invocation-time bound
  const target = `${base}${encodedPath}`;

  const authorization = header(headers, "authorization");
  const context = {
    signed: String(Boolean(authorization)),
    verified: "false",
    controller: "",
    delegated: "false",
    denial: "",
    space: "",
    spaceController: "",
    spaceType: "",
  };

  const request = { method, host, headers: { ...headers, authorization } };

  if (ids[0] === "spaces") {
    const signer = authorization ? signerDid(authorization) : undefined;
    if (signer) {
      const inspectCapabilityChain = inspectorFor({ base, target, method });
      record(context, await verifyInvocation(request, { controller: signer, urls, inspectCapabilityChain }));
    }
  } else if (ids[0] === "space" && ids[1]) {
    const space = await getSpace(`${base}/space/${ids[1]}`);
    if (!space) {
      // A Space the registry does not hold may be about to be provisioned
      // by id: an unlock Space, whose id is derived from the signing DID; or,
      // with open provisioning, any Space a did:key creates with a `PUT` of
      // its metadata object (the reference client's create-by-id). Either
      // way the invocation is verified against the signer, and the handler
      // compares the stated controller to it.
      const signer = authorization ? signerDid(authorization) : undefined;
      const createByIdPut = method === "PUT" && ids.length === 3 && ids[2] === "meta";
      const open = process.env.OPEN_PROVISIONING === "true" && createByIdPut && signer?.startsWith("did:key:");
      if (signer && (ids[1] === deriveSpaceId(signer) || open)) {
        context.space = "unregistered";
        context.spaceController = signer;
        context.spaceType = JSON.stringify(["Space"]);
        const inspectCapabilityChain = inspectorFor({ base, target, method });
        record(context, await verifyInvocation(request, { controller: signer, urls, inspectCapabilityChain }));
      } else {
        context.space = "missing";
      }
    } else {
      context.spaceController = space.controller;
      context.spaceType = JSON.stringify(space.type);
      if (authorization) {
        const spaceUrl = `${base}/space/${encodeURIComponent(ids[1])}/`;
        const roots = [rootCapabilityId(spaceUrl)];
        if (ids[2] !== undefined) {
          roots.push(rootCapabilityId(`${spaceUrl}${encodeURIComponent(ids[2])}/`));
        }
        const inspectCapabilityChain = inspectorFor({ base, spaceId: ids[1], target, method });
        record(context, await verifyInvocation(request, { controller: space.controller, urls, roots, inspectCapabilityChain }));
      }
    }
  }

  return { isAuthorized: true, context };
};
