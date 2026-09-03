// ---------------------------------------------------------------------------
// NOT IN USE - kept only as a worked example of how a Lambda layer can be used.
//
// This was the shared layer that exported `verifyZcap` to the route handlers.
// That function now lives in src/authorizer/zcap.mjs, bundled directly into
// WASZcapAuthorizerFn, and the `DCCSharedLayer` resource is commented out in
// template.yaml. Nothing imports /opt/nodejs/dcc-shared-layer-utils any more.
//
// The whole file is commented out so it cannot be mistaken for live code or
// drift into being a second, divergent copy of the verification logic. Treat
// src/authorizer/zcap.mjs as the real implementation.
//
// To bring a layer back:
//   1. uncomment the DCCSharedLayer resource in template.yaml, plus the
//      `Layers:` and `External:` entries on the functions that need it
//   2. uncomment the code below (or replace it with whatever is being shared)
//   3. import from '/opt/nodejs/dcc-shared-layer-utils/index.js' in a handler
//
// The build is driven by the Makefile in src/sharedLayer/ rather than esbuild,
// because SAM only supports BuildMethod: esbuild for functions, not layers.
// ---------------------------------------------------------------------------


// import {
//   createDefaultDidResolver,
//   securityLoader
// } from '@interop/security-document-loader'
// import {
//   verifyCapabilityInvocation
// } from '@interop/http-signature-zcap-verify'
//
// import * as didKey from '@interop/did-method-key'
// import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
// import { Ed25519Signature2020 } from '@interop/ed25519-signature'
//
// const didKeyDriver = didKey.driver()
// didKeyDriver.use({
//   multibaseMultikeyHeader: 'z6Mk',
//   fromMultibase: Ed25519VerificationKey.from
// })
//
// const baseDocumentLoader = securityLoader() 
//
// const testSeed = 'my-secret-seed-that-is-long-enou';
// const keyPair = await Ed25519VerificationKey.generate({
//     seed: new TextEncoder().encode(testSeed)
// })
//   //keyPair.controller = `did:key:${keyPair.fingerprint()}`
//   //keyPair.id = `${keyPair.controller}#${keyPair.fingerprint()}`
//
// const spaceController = `did:key:${keyPair.fingerprint()}`;
//
// function rootCapabilityLoader() {
//   const loader = baseDocumentLoader.clone()
//
//   loader.setProtocolHandler({
//     protocol: 'urn',
//     handler: {
//       get: async ({ id, url }) => {
//         const resolvedUrl = url || id
//         const rootZcapTarget = decodeURIComponent(
//           resolvedUrl.split('urn:zcap:root:')[1]
//         )
//         return {
//           '@context': 'https://w3id.org/zcap/v1',
//           id: resolvedUrl,
//           invocationTarget: rootZcapTarget,
//           controller: spaceController,
//         }
//       }
//     }
//   })
//   return loader.build()
// }
//
// async function getVerifier({ keyId }) {
//     const didDocument = await didKeyDriver.get({ url: keyId })
//     const key = await Ed25519VerificationKey.from(didDocument)
//     const verifier = key.verifier()
//     return {
//       verifier,
//       verificationMethod: didDocument
//     }
//   }
//
//   // API Gateway passes headers through with whatever casing the client sent, so
//   // anything we read out of them has to be looked up case-insensitively.
//   function getHeader(headers, name) {
//     const match = Object.keys(headers).find(
//       key => key.toLowerCase() === name.toLowerCase()
//     )
//     return match === undefined ? undefined : headers[match]
//   }
//
//   export const verifyZcap = async (event) => {
//     const { httpMethod, path, headers = {} } = event
//
//     const host = getHeader(headers, 'Host')
//     const proto = getHeader(headers, 'X-Forwarded-Proto') ?? 'https'
//
//     // The invoked capability's target should match the resource actually being requested.
//     const url = proto + '://' + host + path
//
//     const result = await verifyCapabilityInvocation({
//       url,
//       method: httpMethod,
//       // The signature is computed over the lowercase header name.
//       headers: { ...headers, authorization: getHeader(headers, 'Authorization') },
//       suite: new Ed25519Signature2020(),
//       getVerifier,
//       documentLoader: rootCapabilityLoader(),
//       expectedHost: host,
//       expectedAction: httpMethod,
//       expectedTarget: url,
//       expectedRootCapability: 'urn:zcap:root:' + encodeURIComponent(url)
//     })
//
//     if (!result.verified) {
//       console.log("in the verifyZcap function - Verification failed:", JSON.stringify(result, null, 2));
//       // `result.error` describes why verification failed (bad signature,
//       // unexpected host, expired capability, unauthorized key, etc.)
//       console.log(JSON.stringify(result, null, 2));
//       throw result.error
//     }
//
//     // On success, `result` also includes the invoked `capability`,
//     // `capabilityAction`, the `controller`/`invoker`, the `verificationMethod`,
//     // and the `dereferencedChain`.
//    // console.log('invoked by', result.controller)
//     console.log('result', JSON.stringify(result, null, 2));
//     return result
//   }
