import { securityLoader, createDefaultDidResolver } from "@interop/security-document-loader";
import { verifyCapabilityInvocation } from "@interop/http-signature-zcap-verify";
import * as didKey from "@interop/did-method-key";
import { Ed25519VerificationKey } from "@interop/ed25519-verification-key";
import { Ed25519Signature2020 } from "@interop/ed25519-signature";
import { createVerifyCryptosuite } from "@interop/ed25519-signature/eddsa-jcs-2022";
import { DataIntegrityProof } from "@interop/data-integrity-proof";
import * as webvhDriver from "@interop/did-method-webvh";
import { isWebvhDid, resolveWebvhDocument, verificationMethodFor } from "was-lib/webvh.mjs";

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

async function getVerifier({ keyId }) {
  if (isWebvhDid(keyId)) {
    return webvhVerifier(keyId);
  }
  const didDocument = await didKeyDriver.get({ url: keyId });
  const key = await Ed25519VerificationKey.from(didDocument);
  return { verifier: key.verifier(), verificationMethod: didDocument };
}

function rootCapabilityLoader(controller) {
  const loader = baseDocumentLoader.clone();
  loader.setProtocolHandler({
    protocol: "urn",
    handler: {
      get: async ({ id, url }) => {
        const resolvedUrl = url || id;
        const target = decodeURIComponent(resolvedUrl.split("urn:zcap:root:")[1]);
        return {
          "@context": "https://w3id.org/zcap/v1",
          id: resolvedUrl,
          invocationTarget: target,
          controller,
        };
      },
    },
  });
  return loader.build();
}

export const rootCapabilityId = (url) => `urn:zcap:root:${encodeURIComponent(url)}`;

// The proof suites a delegated capability's proof may carry: the zcap
// library verifies each link of a delegation chain with whichever of these
// matches the proof's type. Ed25519Signature2020 is what ezcap's default
// signs; eddsa-jcs-2022 is what @interop/was-client and wallet-core clients
// sign every delegation with. (The invocation itself is an HTTP signature,
// verified through `getVerifier`, and carries no suite.)
const delegationSuites = () => [new Ed25519Signature2020(), new DataIntegrityProof({ cryptosuite: createVerifyCryptosuite() })];

// Verifies that the request carries an invocation of one of `urls` (the
// delivered URL and, when ids were percent-encoded, the re-encoded URL the
// client signed) authorized by `controller`. Resolves to
// { controller, delegated } or null, with the reason logged.
export async function verifyInvocation({ method, host, headers }, { controller, urls, roots = [] }) {
  const documentLoader = rootCapabilityLoader(controller);
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
        expectedTarget: url,
        expectedRootCapability: [rootCapabilityId(url), ...roots],
        allowTargetAttenuation: true,
      });
      if (result.verified) {
        const capability = result.capability;
        return {
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
  return null;
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
