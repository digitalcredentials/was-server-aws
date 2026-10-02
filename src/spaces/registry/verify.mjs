// zCap invocation verification against a given DID: the invoked root
// capability is controlled by that DID, so verification itself rejects
// invocations signed by anyone else's key. Kept in this function's own
// directory because SAM's esbuild build only packages files under the
// function's CodeUri.
import { verifyCapabilityInvocation } from "@interop/http-signature-zcap-verify";
import { Ed25519Signature2020 } from "@interop/ed25519-signature";
import { securityLoader } from "@interop/security-document-loader";
import { Ed25519VerificationKey } from "@interop/ed25519-verification-key";
import { createRootCapability } from "@interop/zcap";

const documentLoader = securityLoader().build();

async function getVerifier({ keyId, documentLoader }) {
  const { document } = await documentLoader(keyId);
  const key = await Ed25519VerificationKey.fromKeyDocument({ document });
  return { verifier: key.verifier(), verificationMethod: document };
}

// Verifies that `event` carries a zcap invocation of its own URL, signed by
// `did`. The URL is rebuilt from the request's proto/host/path and includes
// the query string, so signed query parameters (email) cannot be tampered
// with. Returns true when the invocation verifies.
export async function verifyInvocation({ event, did }) {
  // API Gateway delivers headers lowercase, sam local preserves casing.
  const headers = Object.fromEntries(
    Object.entries(event.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value])
  );
  const proto = headers["x-forwarded-proto"] ?? "https";
  const host = headers.host ?? event.requestContext.domainName;
  const query = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const url = `${proto}://${host}${event.rawPath}${query}`;
  const method = event.requestContext.http.method;

  const rootCapability = createRootCapability({
    controller: did,
    invocationTarget: url
  });
  const wrappedLoader = async (documentUrl) => {
    if (documentUrl === rootCapability.id) {
      return { contextUrl: null, documentUrl, document: rootCapability };
    }
    return documentLoader(documentUrl);
  };

  try {
    const result = await verifyCapabilityInvocation({
      url,
      method,
      headers,
      suite: new Ed25519Signature2020(),
      getVerifier,
      documentLoader: wrappedLoader,
      expectedHost: host,
      expectedAction: method === "GET" ? "read" : "write",
      expectedTarget: url,
      expectedRootCapability: rootCapability.id
    });
    if (!result.verified) {
      console.error("Invocation rejected:", result.error);
      return false;
    }
    return true;
  } catch (error) {
    console.error("Invocation rejected:", error);
    return false;
  }
}
