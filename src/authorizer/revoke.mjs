// Must be evaluated before @interop/jsonld (CJS) is pulled in by the
// verification stack (see app.mjs).
import "@interop/http-client";

import { plainHandler } from "was-lib/handler.mjs";
import { parseJsonBody, noContent, NO_STORE } from "was-lib/http.mjs";
import { verifyDigest, denial } from "was-lib/auth.mjs";
import { isValidSpaceId, encodeSegment } from "was-lib/ids.mjs";
import { HttpProblem, capabilityAlreadyRevoked, idConflict, invalidRequestBody, missingAuthorization, notFound } from "was-lib/problems.mjs";
import { verifyInvocation, verifyDelegationChain, rootCapabilityId, rootTargetOf, ROOT_PREFIX } from "./zcap.mjs";
import { getSpace } from "./registry.mjs";
import { asList, capabilityControllers, capabilitySummaries, composeChainInspectors, delegationVerificationMethod, delegatorOf, didOfMethodId } from "./chain.mjs";
import { isRevoked, revocationChainInspector, revocationRecord, storeRevocation } from "./revocations.mjs";
import { clientAnnexChainInspector } from "./annex.mjs";

// POST /space/{s}/zcaps/revocations/{id} -- revoke a delegated capability
// rooted in the Space: the body is the capability itself, proof and chain
// included, and the URL names its id. The reference stack's Space-scoped
// revocation endpoint (the authorization profile has not specified one
// yet), as @interop/pws-client's `revoke()` submits it.
//
// Who may submit it is the dual-root rule. The invocation may root in the
// Space, whose controller may revoke anything delegated from it, or in the
// revocation URL itself, whose root capability is controlled by every
// controller in the submitted capability's chain -- so a delegee revokes
// its own grant without holding a separate capability. The chain is
// verified first (structurally and by its proofs) to learn those
// controllers; the invocation is verified against them; only then is a
// refusal of the body reported, so a submitter outside the chain learns
// nothing but the masked 404.
//
// This function lives beside the authorizer because it verifies a
// capability chain in a request body, which needs the same verification
// stack; the gateway authorizer does not run for the route.

const isUnderScope = (target, rootTarget) =>
  target === rootTarget || target.startsWith(rootTarget.endsWith("/") ? rootTarget : `${rootTarget}/`);

// The roots a submitted chain may start from: the Space's own, plus the
// chain's own root when it targets a URL under the Space (a grant delegated
// from a Collection's or a Resource's root, which an invocation accepts
// too). Read off the unverified body, which only names which root the
// verification then requires; `controllerFor` still refuses any target
// outside the Space.
function expectedRevocationRoots(capability, spaceUrl) {
  const scopeRoot = rootCapabilityId(spaceUrl);
  const chainRoot = asList(capability.proof).find((proof) => Array.isArray(proof?.capabilityChain))?.capabilityChain?.[0];
  let target;
  try {
    target = rootTargetOf(chainRoot);
  } catch {
    return [scopeRoot];
  }
  if (target === undefined || !isUnderScope(target, spaceUrl)) {
    return [scopeRoot];
  }
  return [...new Set([scopeRoot, rootCapabilityId(target)])];
}

// The body as a revocable capability: its id, its chain (verified), its
// delegator, every controller in the chain, and the chain's lookup pairs.
async function validateSubmission(req, { revocationId, spaceUrl, spaceController }) {
  const body = parseJsonBody(req, { problem: invalidRequestBody });
  if (typeof body.id !== "string") {
    throw invalidRequestBody('The revocation body must be a capability with a string "id".');
  }
  if (body.id.startsWith(ROOT_PREFIX)) {
    throw invalidRequestBody("A root capability cannot be revoked.");
  }
  if (body.id !== revocationId) {
    throw invalidRequestBody('The capability "id" does not match the revocation URL.');
  }
  const chainControllers = new Set();
  let capabilities = [];
  let result;
  try {
    result = await verifyDelegationChain({
      capability: body,
      expectedRootCapability: expectedRevocationRoots(body, spaceUrl),
      controllerFor: (target) => {
        if (typeof target !== "string" || !isUnderScope(target, spaceUrl)) {
          throw new Error(`The root capability of the chain must target ${spaceUrl} or a path under it.`);
        }
        return spaceController;
      },
      inspectCapabilityChain: async (details) => {
        for (const link of details.capabilityChain) {
          capabilityControllers(link).forEach((controller) => chainControllers.add(controller));
        }
        capabilities = capabilitySummaries(details);
        return { valid: true };
      },
    });
  } catch (err) {
    result = { verified: false, error: err };
  }
  if (!result.verified) {
    console.error("Revocation chain rejected:", result.error?.message ?? result.error);
    throw invalidRequestBody("The provided capability delegation is invalid.");
  }
  // The record's delegator is the one the chain's lookup pairs use, so an
  // invocation's lookup finds it
  const delegator =
    capabilities.find((pair) => pair.capabilityId === body.id)?.delegator ??
    delegatorOf(result) ??
    didOfMethodId(delegationVerificationMethod(body));
  if (!delegator) {
    throw invalidRequestBody("The capability delegation has no identifiable delegator.");
  }
  return { capability: body, delegator, chainControllers: [...chainControllers], capabilities };
}

export const lambdaHandler = plainHandler(async (req) => {
  const { space_id: spaceId, revocation_id: revocationId } = req.pathParameters;
  if (!isValidSpaceId(spaceId) || typeof revocationId !== "string" || revocationId === "") {
    throw notFound();
  }
  const space = await getSpace(`${req.base}/space/${spaceId}`);
  if (space === null) {
    throw notFound();
  }
  if (!req.headers.authorization) {
    throw missingAuthorization();
  }
  const spaceUrl = `${req.base}/space/${encodeSegment(spaceId)}/`;
  // The URL as delivered and as the client signed it (the id re-encoded)
  const revocationUrls = [...new Set([req.url, req.encodedUrl])];

  let validated;
  let validationError;
  try {
    validated = await validateSubmission(req, { revocationId, spaceUrl, spaceController: space.controller });
  } catch (err) {
    if (!(err instanceof HttpProblem && err.status === 400)) {
      throw err;
    }
    validationError = err;
  }

  // The revocation URL's root is controlled by every party to the chain. The
  // Space controller is one of them whenever the chain verified (the chain's
  // root is its capability), and is admitted here even when it did not, so
  // the controller's own submission of a malformed body is answered with
  // the reason rather than the masked 404 anyone else gets.
  const chainControllers = [...new Set([space.controller, ...(validated?.chainControllers ?? [])])];
  const result = await verifyInvocation(
    { method: req.method, host: req.host, headers: req.headers },
    {
      controllerFor: (target) => {
        if (target === spaceUrl) {
          return space.controller;
        }
        if (revocationUrls.includes(target)) {
          return chainControllers;
        }
        throw new Error(`Unexpected root capability target "${target}" on a revocation.`);
      },
      urls: revocationUrls,
      roots: [rootCapabilityId(spaceUrl)],
      targets: [spaceUrl],
      inspectCapabilityChain: composeChainInspectors([revocationChainInspector(spaceId), clientAnnexChainInspector({ serverUrl: req.base })]),
    }
  );
  if (!result.verified) {
    throw denial({ denial: result.denial });
  }
  verifyDigest(req);
  if (validationError !== undefined) {
    throw validationError;
  }

  const { capability, delegator, capabilities } = validated;
  if (await isRevoked(spaceId, capabilities)) {
    throw capabilityAlreadyRevoked();
  }
  try {
    await storeRevocation(spaceId, revocationRecord({ capability, delegator, rootTarget: spaceUrl }));
  } catch (err) {
    // Two submissions raced: the record is there
    if (err instanceof HttpProblem && err.status === 412) {
      throw idConflict("Duplicate revocation.");
    }
    throw err;
  }
  return noContent(req, NO_STORE);
});
