import { securityLoader } from "@interop/security-document-loader";
import { verifyCapabilityInvocation } from "@interop/http-signature-zcap-verify";
import * as didKey from "@interop/did-method-key";
import { Ed25519VerificationKey } from "@interop/ed25519-verification-key";
import { Ed25519Signature2020 } from "@interop/ed25519-signature";

// Capability-invocation verification. A request is authorized by a zcap
// invocation signed by `controller`: every urn:zcap:root:{url} resolves to
// a root capability controlled by that DID, so verification itself rejects
// anything signed by another key, and a delegation chain must start from
// the invoked URL's root or one of the container roots passed in.

const didKeyDriver = didKey.driver();
didKeyDriver.use({
  multibaseMultikeyHeader: "z6Mk",
  fromMultibase: Ed25519VerificationKey.from,
});

const baseDocumentLoader = securityLoader();

async function getVerifier({ keyId }) {
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
        suite: new Ed25519Signature2020(),
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

// The signer's DID from the HTTP signature's keyId (did:key:z6Mk...#z6Mk...).
export function signerDid(authorization) {
  const keyId = authorization?.match(/keyId="([^"]+)"/)?.[1];
  return keyId?.startsWith("did:key:") ? keyId.split("#")[0] : undefined;
}
