import { securityLoader, createDefaultDidResolver } from "@interop/security-document-loader";
import { verifyCapabilityInvocation, decodeEmbeddedCapability } from "@interop/http-signature-zcap-verify";
import jsigs from "@interop/jsonld-signatures";
import { CapabilityDelegation } from "@interop/zcap";
import * as didKey from "@interop/did-method-key";
import { Ed25519VerificationKey } from "@interop/ed25519-verification-key";
import { Ed25519Signature2020 } from "@interop/ed25519-signature";
import { createVerifyCryptosuite } from "@interop/ed25519-signature/eddsa-jcs-2022";
import { DataIntegrityProof } from "@interop/data-integrity-proof";
import * as webvhDriver from "@interop/did-method-webvh";
import { isWebvhDid, resolveWebvhDocument, verificationMethodFor } from "was-lib/webvh.mjs";
import { capabilityControllers, CAPABILITY_REVOKED_ERROR_NAME } from "./chain.mjs";

// Capability-invocation verification. A request is authorized by a zcap
// invocation signed by `controller`: every urn:zcap:root:{url} resolves to
// a root capability controlled by that DID, so verification itself rejects
// anything signed by another key, and a delegation chain must start from
// the invoked URL's root or one of the container roots passed in.
//
// Two kinds of signing key. A did:key names its own key. A did:webvh key id
// (<did>#<fragment>) names a verification method in the account document
// the DID's log resolves to right now; the key must be listed there under
// capabilityInvocation (or capabilityDelegation, for a delegation's proof),
// and the method's controller is the did:webvh, which is what the root
// capability's controller is compared against.
//
// After the signatures, a chain inspector (chain.mjs) may still refuse a
// delegated chain: the revocation store and the client-annex clause.

const didKeyDriver = didKey.driver();
didKeyDriver.use({
  multibaseMultikeyHeader: "z6Mk",
  fromMultibase: Ed25519VerificationKey.from,
});

const RELATIONS = ["authentication", "assertionMethod", "keyAgreement", "capabilityInvocation", "capabilityDelegation"];

// A did:webvh document writes relationship entries as `#fragment`, relative
// to its own id; the zcap library compares them to the absolute id of the
// signing key, so they are absolutized here.
function absoluteIds(doc) {
  const absolute = (id) => (typeof id === "string" && id.startsWith("#") ? `${doc.id}${id}` : id);
  const out = { ...doc };
  for (const relation of RELATIONS) {
    if (Array.isArray(doc[relation])) {
      out[relation] = doc[relation].map((entry) =>
        typeof entry === "string" ? absolute(entry) : { ...entry, id: absolute(entry?.id) }
      );
    }
  }
  if (Array.isArray(doc.verificationMethod)) {
    out.verificationMethod = doc.verificationMethod.map((method) => ({ ...method, id: absolute(method?.id) }));
  }
  return out;
}

const capabilityMethod = (doc, id) =>
  verificationMethodFor(doc, id, "capabilityInvocation") ?? verificationMethodFor(doc, id, "capabilityDelegation");

// The did:webvh document, or the one verification method a key URL names.
// A key the cached document does not list is looked up once more against
// a fresh resolution: a credential added a moment ago must work at once,
// while a removed key keeps working only until the cache expires.
async function resolveWebvh(id) {
  const [did, fragment] = id.split("#");
  let doc = await resolveWebvhDocument(did, { driver: webvhDriver });
  if (!doc) {
    throw new Error(`No DID log found for ${did}.`);
  }
  if (fragment === undefined) {
    return absoluteIds(doc);
  }
  let method = capabilityMethod(doc, id);
  if (!method) {
    doc = await resolveWebvhDocument(did, { driver: webvhDriver, fresh: true });
    method = doc ? capabilityMethod(doc, id) : null;
  }
  if (!method || !method.publicKeyMultibase) {
    throw new Error(`${id} is not a capability key of ${did}.`);
  }
  return {
    "@context": "https://w3id.org/security/multikey/v1",
    ...method,
    id,
    type: "Multikey",
    controller: method.controller ?? did,
  };
}

// The document loader resolves the controller DID behind a capability as
// well as the signing key, so did:webvh joins did:key and did:web there.
const didResolver = createDefaultDidResolver();
// The resolver memoizes by DID for a few seconds; did:webvh documents are
// cached (and refreshed on a missing key) by was-lib/webvh.mjs, so the
// resolver's own memo would only serve the controller document stale.
didResolver._cache = { memoize: ({ fn }) => fn() };
didResolver.use({ method: "webvh", get: ({ did, url }) => resolveWebvh(did ?? url) });
const baseDocumentLoader = securityLoader({ didResolver });

async function webvhVerifier(keyId) {
  const verificationMethod = await resolveWebvh(keyId);
  const key = await Ed25519VerificationKey.from(verificationMethod);
  return { verifier: key.verifier(), verificationMethod };
}

export async function getVerifier({ keyId }) {
  if (isWebvhDid(keyId)) {
    return webvhVerifier(keyId);
  }
  const didDocument = await didKeyDriver.get({ url: keyId });
  const key = await Ed25519VerificationKey.from(didDocument);
  return { verifier: key.verifier(), verificationMethod: didDocument };
}

export const ROOT_PREFIX = "urn:zcap:root:";

export const rootCapabilityId = (url) => `${ROOT_PREFIX}${encodeURIComponent(url)}`;

// The target a root capability id names, or undefined for any other id.
export const rootTargetOf = (id) =>
  typeof id === "string" && id.startsWith(ROOT_PREFIX) ? decodeURIComponent(id.slice(ROOT_PREFIX.length)) : undefined;

// A document loader whose `urn` handler synthesizes urn:zcap:root:{target}
// capabilities on demand, controlled by what `controllerFor(target)`
// answers (one DID, or several: the revocation URL's root is controlled by
// every party in the chain being revoked). The zcap library only
// dereferences a root it expects, so `controllerFor` sees expected targets
// only; it may still throw to refuse one.
export function rootCapabilityLoader(controllerFor) {
  const loader = baseDocumentLoader.clone();
  loader.setProtocolHandler({
    protocol: "urn",
    handler: {
      get: async ({ id, url }) => {
        const resolvedUrl = url || id;
        const target = rootTargetOf(resolvedUrl);
        return {
          "@context": "https://w3id.org/zcap/v1",
          id: resolvedUrl,
          invocationTarget: target,
          controller: controllerFor(target),
        };
      },
    },
  });
  return loader.build();
}

// The proof suites a delegated capability's proof may carry: the zcap
// library verifies each link of a delegation chain with whichever of these
// matches the proof's type. Ed25519Signature2020 is what ezcap's default
// signs; eddsa-jcs-2022 is what @interop/pws-client and wallet-core clients
// sign every delegation with. (The invocation itself is an HTTP signature,
// verified through `getVerifier`, and carries no suite.)
export const delegationSuites = () => [new Ed25519Signature2020(), new DataIntegrityProof({ cryptosuite: createVerifyCryptosuite() })];

// The zcap library's own wording for a lapsed link.
const EXPIRED_MESSAGE = "A capability in the delegation chain has expired.";

// The embedded capability of a delegated invocation (the `capability`
// parameter of the Capability-Invocation header), or undefined for a root
// invocation, which carries the capability id alone.
function embeddedCapability(headers) {
  const header = headers["capability-invocation"] ?? headers["Capability-Invocation"];
  const encoded = header?.match(/capability="([^"]+)"/)?.[1];
  if (!encoded) {
    return undefined;
  }
  try {
    return decodeEmbeddedCapability({ encoded });
  } catch {
    return undefined;
  }
}

// Whether the request's signer is a controller of the capability it invokes:
// the holder of the grant, who may be told that the grant was revoked or
// has expired where anyone else learns nothing.
export function invokerIsController(headers) {
  const capability = embeddedCapability(headers);
  const signer = signerDid(headers.authorization ?? headers.Authorization);
  return capability !== undefined && signer !== undefined && capabilityControllers(capability).includes(signer);
}

// The named reason a verification failed, when there is one the invoker
// may be given: "capability-revoked" or "capability-expired".
export function denialOf(error, headers) {
  const seen = new Set();
  const causes = [error];
  let named;
  while (causes.length && named === undefined) {
    const cause = causes.shift();
    if (!cause || typeof cause !== "object" || seen.has(cause)) {
      continue;
    }
    seen.add(cause);
    if (cause.name === CAPABILITY_REVOKED_ERROR_NAME) {
      named = "capability-revoked";
    } else if (cause.message === EXPIRED_MESSAGE) {
      named = "capability-expired";
    }
    causes.push(...(Array.isArray(cause.errors) ? cause.errors : []), cause.cause);
  }
  return named !== undefined && invokerIsController(headers) ? named : undefined;
}

// Verifies that the request carries an invocation of one of `urls` (the
// delivered URL and, when ids were percent-encoded, the re-encoded URL the
// client signed). The roots are controlled by `controller`, or by what
// `controllerFor(target)` answers per root target; `roots` adds container
// roots a delegation chain may start from, `targets` further targets an
// attenuated chain may name, and `inspectCapabilityChain` runs over a
// verified chain. Resolves to { verified: true, controller, delegated } or
// { verified: false, denial? }, with the reason logged.
export async function verifyInvocation(
  { method, host, headers },
  { controller, controllerFor = () => controller, urls, roots = [], targets = [], inspectCapabilityChain }
) {
  const documentLoader = rootCapabilityLoader(controllerFor);
  let error;
  for (const url of urls) {
    try {
      const result = await verifyCapabilityInvocation({
        url,
        method,
        // The signature is computed over the lowercase header name.
        headers,
        suite: delegationSuites(),
        getVerifier,
        documentLoader,
        expectedHost: host,
        expectedAction: method,
        expectedTarget: targets.length ? [...targets, url] : url,
        expectedRootCapability: [rootCapabilityId(url), ...roots],
        allowTargetAttenuation: true,
        inspectCapabilityChain,
      });
      if (result.verified) {
        const capability = result.capability;
        return {
          verified: true,
          controller: result.controller ?? controller,
          delegated: typeof capability === "object" && capability !== null && "parentCapability" in capability,
        };
      }
      error = result.error;
    } catch (err) {
      error = err;
    }
  }
  console.error("Invocation rejected:", error?.message ?? error);
  return { verified: false, denial: denialOf(error, headers) };
}

// Verifies the delegation chain of a capability on its own (no invocation):
// its proof under the CapabilityDelegation purpose, over the embedded chain
// up to one of `expectedRootCapability`, whose roots `controllerFor`
// controls. Resolves to the jsonld-signatures result ({ verified, error?,
// results }); throws only for a document the library cannot process.
export async function verifyDelegationChain({ capability, expectedRootCapability, controllerFor, inspectCapabilityChain, allowTargetAttenuation = true }) {
  const suite = delegationSuites();
  return jsigs.verify(capability, {
    documentLoader: rootCapabilityLoader(controllerFor),
    suite,
    purpose: new CapabilityDelegation({ suite, expectedRootCapability, allowTargetAttenuation, inspectCapabilityChain }),
  });
}

// The signer's DID from the HTTP signature's keyId: did:key:z6Mk...#z6Mk...
// or did:webvh:...#fragment.
export function signerDid(authorization) {
  const keyId = authorization?.match(/keyId="([^"]+)"/)?.[1];
  if (!keyId) {
    return undefined;
  }
  return keyId.startsWith("did:key:") || isWebvhDid(keyId) ? keyId.split("#")[0] : undefined;
}
