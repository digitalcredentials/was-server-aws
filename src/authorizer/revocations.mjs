import { createHash } from "node:crypto";
import { getJson, putJson, KEYS } from "was-lib/store.mjs";
import { capabilitySummaries, CAPABILITY_REVOKED_ERROR_NAME } from "./chain.mjs";

// Space-scoped zcap revocations, as the reference server keeps them: one
// record per revoked delegated capability, keyed by the digest of its
// delegator and its id, stored in the Space's bucket under revocations/.
// A record outlives the capability by a day, after which it is ignored (an
// expired capability cannot be invoked anyway); it is deleted with the
// Space. The authorizer's chain inspector looks every delegated link of an
// invocation up here, so a chain holding a revoked capability -- at any
// depth -- no longer verifies.

export { CAPABILITY_REVOKED_ERROR_NAME };

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export const revocationDigest = ({ delegator, capabilityId }) =>
  createHash("sha256").update(`${delegator}\n${capabilityId}`).digest("hex");

export const revocationKey = (pair) => KEYS.revocation(revocationDigest(pair));

export function revocationRecord({ capability, delegator, rootTarget, now = Date.now }) {
  const expiresMs = typeof capability.expires === "string" ? Date.parse(capability.expires) : NaN;
  return {
    capability,
    meta: {
      delegator,
      rootTarget,
      created: new Date(now()).toISOString(),
      ...(Number.isFinite(expiresMs) && { expires: new Date(expiresMs + ONE_DAY_MS).toISOString() }),
    },
  };
}

// The stored record for one (delegator, capability id) pair, or null when
// there is none or it has lapsed.
export async function readRevocation(spaceId, pair, now = Date.now) {
  const stored = await getJson(spaceId, revocationKey(pair));
  if (stored === null) {
    return null;
  }
  const expires = stored.doc?.meta?.expires;
  if (typeof expires === "string" && Date.parse(expires) <= now()) {
    return null;
  }
  return stored.doc;
}

export async function isRevoked(spaceId, capabilities, now = Date.now) {
  const records = await Promise.all(capabilities.map((pair) => readRevocation(spaceId, pair, now)));
  return records.some((record) => record !== null);
}

// Creates the record; a record already there fails the If-None-Match
// precondition (the store's 412), which the endpoint reports as a conflict.
export async function storeRevocation(spaceId, record) {
  const pair = { delegator: record.meta.delegator, capabilityId: record.capability.id };
  await putJson(spaceId, revocationKey(pair), record, { ifNoneMatch: "*" });
}

// The chain inspector: refuses a chain holding any revoked capability, with
// an error named so the authorizer can tell the holder it was revoked.
export function revocationChainInspector(spaceId) {
  return async (details) => {
    const capabilities = capabilitySummaries(details);
    if (capabilities.length === 0) {
      return { valid: true };
    }
    if (await isRevoked(spaceId, capabilities)) {
      const error = new Error("One or more capabilities in the chain have been revoked.");
      error.name = CAPABILITY_REVOKED_ERROR_NAME;
      return { valid: false, error };
    }
    return { valid: true };
  };
}
