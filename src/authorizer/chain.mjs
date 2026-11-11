// Helpers over a dereferenced capability chain, shared by the chain
// inspectors (revocations.mjs, annex.mjs) and the revocation endpoint.
//
// After it has verified every delegation proof, the zcap library hands an
// `inspectCapabilityChain` hook `{ capabilityChain, capabilityChainMeta }`:
// the chain root-first (the root synthesized, the rest dereferenced from
// the invocation) and, for each link, the jsonld-signatures verify result
// of its delegation proof (`null` for the root). The hook answers
// `{ valid }` or `{ valid: false, error }`, and a refusal fails the
// verification like a bad signature would.

export const CAPABILITY_REVOKED_ERROR_NAME = "CapabilityRevokedError";

export const asList = (value) => (value === undefined || value === null ? [] : Array.isArray(value) ? value : [value]);

// A capability's controller(s) as DID strings (`controller` may be a
// string, an array, or an object with an id).
export const capabilityControllers = (capability) =>
  asList(capability?.controller)
    .map((entry) => (typeof entry === "string" ? entry : entry?.id))
    .filter((id) => typeof id === "string");

// Whether `allowedAction` is present, non-empty and within `allowed`.
export function actionsWithin(capability, allowed) {
  if (capability?.allowedAction === undefined) {
    return false;
  }
  const actions = asList(capability.allowedAction);
  return actions.length > 0 && actions.every((action) => allowed.includes(action));
}

// Whether `allowedAction` is exactly the one action.
export function actionsExactly(capability, action) {
  const actions = asList(capability?.allowedAction);
  return actions.length === 1 && actions[0] === action;
}

// The DID a verification method id belongs to (`did:...#fragment`, with any
// `?versionId` query the did:webvh method may carry).
export const didOfMethodId = (id) => (typeof id === "string" ? id.split("#")[0].split("?")[0] : "");

// The verification method a link's delegation proof was verified with: the
// one the verifier recorded, else the one the capability's own
// capabilityDelegation proof names.
export function delegationVerificationMethod(capability, meta) {
  const verified = meta?.verifyResult?.results?.[0]?.verificationMethod?.id;
  if (typeof verified === "string") {
    return verified;
  }
  for (const proof of asList(capability?.proof)) {
    if (proof?.proofPurpose === "capabilityDelegation" && typeof proof.verificationMethod === "string") {
      return proof.verificationMethod;
    }
  }
  return undefined;
}

// The delegator a verify result recorded: the controller of the delegation
// proof (a DID string, or the controller document it resolved to).
export function delegatorOf(verifyResult) {
  const raw = verifyResult?.results?.[0]?.purposeResult?.delegator;
  return typeof raw === "string" ? raw : raw?.id;
}

// The chain's (capability id, delegator) pairs, one per delegated link:
// what a revocation record is keyed by. The delegator is the one the
// verifier recorded, else the DID of the method the proof names.
export function capabilitySummaries({ capabilityChain, capabilityChainMeta }) {
  const summaries = [];
  capabilityChain.forEach((capability, index) => {
    if (index === 0 || typeof capability?.id !== "string") {
      return;
    }
    const meta = capabilityChainMeta[index];
    const delegator = delegatorOf(meta?.verifyResult) ?? didOfMethodId(delegationVerificationMethod(capability, meta));
    if (delegator) {
      summaries.push({ capabilityId: capability.id, delegator });
    }
  });
  return summaries;
}

// Runs inspectors in order; the first refusal is the verdict.
export function composeChainInspectors(inspectors) {
  return async (details) => {
    for (const inspect of inspectors) {
      const result = await inspect(details);
      if (!result.valid) {
        return result;
      }
    }
    return { valid: true };
  };
}
