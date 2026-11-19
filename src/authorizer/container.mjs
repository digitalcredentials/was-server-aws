import { encodeSegment } from "was-lib/ids.mjs";
import { actionsExactly } from "./chain.mjs";
import { spaceOperationOf } from "./annex.mjs";

// The container rule's exceptions on the Space: the two container
// operations a delegated chain may make, each only through a capability
// handed over for that one operation.
//
// Delete Space (spec: the Delete Space operation, "the container rule"): a
// delegated chain may delete a Space when its tail, the invoked capability,
// targets exactly the Space's canonical URL and allows exactly DELETE. A
// single-verb DELETE grant is not a data grant, which is what the container
// rule keeps away from the container: a grant on the Space's subtree,
// whatever verbs it carries, is refused here, so a holder has to be handed
// (or mint, from a grant that carries DELETE) an explicit deletion
// capability. This is how a wallet deletes a retired credential's unlock
// Space: a DELETE-only child of the management capability the unlock
// identity delegated to the account.
//
// Create a Space under an account (this server's POST /space/{s}/spaces):
// by the same reasoning, a delegated chain creates one only when its tail
// targets exactly that URL and allows exactly POST. A data grant on the
// Space's subtree that carries POST is refused; its holder mints the
// POST-only child for the key that will control the new Space, which is
// how a wallet creates the unlock Space of a sign-in method it adds.
//
// The rule reads the tail alone and nothing about who signed any link; the
// client-annex clause's two invocation-time bounds (annex.mjs) read the
// ladder-signed and transient-annex-signed links above it, so a password
// session's generation delegation, the whole-subtree grant it holds, never
// ends the account Space or its annex. Update Space Metadata and Delete
// Collection stay root-only in their handlers (`rootOnly`), as the spec
// keeps them.

// Whether an invocation is a POST on a Space's own Spaces URL, in its
// canonical form (same origin, no query, no fragment).
export function isCreateUnderAccount({ target, action }, serverUrl) {
  if (action !== "POST" || typeof target !== "string") {
    return false;
  }
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return false;
  }
  const segments = parsed.pathname.split("/");
  if (segments.length !== 4 || segments[1] !== "space" || segments[2] === "" || segments[3] !== "spaces") {
    return false;
  }
  let spaceId;
  try {
    spaceId = decodeURIComponent(segments[2]);
  } catch {
    return false;
  }
  return target === `${serverUrl}/space/${encodeSegment(spaceId)}/spaces`;
}

// The verb a delegated chain's tail must carry, alone and on exactly the
// invoked target, for the operation to pass; undefined for an operation
// the rule does not bound.
function tailVerbFor(invocation, serverUrl) {
  if (spaceOperationOf(invocation, serverUrl) === "delete-space") {
    return "DELETE";
  }
  if (isCreateUnderAccount(invocation, serverUrl)) {
    return "POST";
  }
  return undefined;
}

const REFUSALS = {
  DELETE: "The container rule: a delegated capability deletes a Space only when it targets exactly that Space's URL and allows exactly DELETE.",
  POST: "The container rule: a delegated capability creates a Space under an account Space only when it targets exactly that Space's Spaces URL and allows exactly POST.",
};

export function containerRuleInspector({ serverUrl, invocation }) {
  return async ({ capabilityChain }) => {
    // A root invocation's chain is the synthesized root alone
    if (invocation === undefined || !Array.isArray(capabilityChain) || capabilityChain.length <= 1) {
      return { valid: true };
    }
    const verb = tailVerbFor(invocation, serverUrl);
    if (verb === undefined) {
      return { valid: true };
    }
    const tail = capabilityChain[capabilityChain.length - 1];
    if (tail?.invocationTarget === invocation.target && actionsExactly(tail, verb)) {
      return { valid: true };
    }
    return { valid: false, error: new Error(REFUSALS[verb]) };
  };
}
