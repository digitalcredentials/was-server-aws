import { actionsExactly } from "./chain.mjs";
import { spaceOperationOf } from "./annex.mjs";

// The container rule's one exception on the Space (spec: the Delete Space
// operation, "the container rule"): a delegated chain may delete a Space
// when its tail, the invoked capability, targets exactly the Space's
// canonical URL and allows exactly DELETE. A single-verb DELETE grant is
// not a data grant, which is what the container rule keeps away from the
// container: a grant on the Space's subtree, whatever verbs it carries, is
// refused here, so a holder has to be handed (or mint, from a grant that
// carries DELETE) an explicit deletion capability. This is how a wallet
// deletes a retired credential's unlock Space: a DELETE-only child of the
// management capability the unlock identity delegated to the account.
//
// The rule reads the tail alone and nothing about who signed any link; the
// client-annex clause's two invocation-time bounds (annex.mjs) read the
// ladder-signed and transient-annex-signed links above it, so a password
// session's generation delegation, the whole-subtree grant it holds, never
// ends the account Space or its annex. Update Space Metadata and Delete
// Collection stay root-only in their handlers (`rootOnly`), as the spec
// keeps them.

export function containerRuleInspector({ serverUrl, invocation }) {
  return async ({ capabilityChain }) => {
    // A root invocation's chain is the synthesized root alone
    if (invocation === undefined || !Array.isArray(capabilityChain) || capabilityChain.length <= 1) {
      return { valid: true };
    }
    if (spaceOperationOf(invocation, serverUrl) !== "delete-space") {
      return { valid: true };
    }
    const tail = capabilityChain[capabilityChain.length - 1];
    if (tail?.invocationTarget === invocation.target && actionsExactly(tail, "DELETE")) {
      return { valid: true };
    }
    return {
      valid: false,
      error: new Error(
        "The container rule: a delegated capability deletes a Space only when it targets exactly that Space's URL and allows exactly DELETE."
      ),
    };
  };
}
