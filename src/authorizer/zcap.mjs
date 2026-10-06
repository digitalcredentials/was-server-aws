import {
  securityLoader
} from '@interop/security-document-loader'
import {
  verifyCapabilityInvocation
} from '@interop/http-signature-zcap-verify'

import * as didKey from '@interop/did-method-key'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import { Ed25519Signature2020 } from '@interop/ed25519-signature'
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb'

const didKeyDriver = didKey.driver()
didKeyDriver.use({
  multibaseMultikeyHeader: 'z6Mk',
  fromMultibase: Ed25519VerificationKey.from
})

const baseDocumentLoader = securityLoader()

const dynamoClient = new DynamoDBClient()
const SPACES_TABLE_NAME = process.env.SPACES_TABLE_NAME ?? 'wallet-spaces'

// The space URL is everything in the request URL up to and including the
// {space_id} segment, matching the spaceURL registered for the account.
function getSpaceUrl(url) {
  const match = url.match(/^(.*?\/space\/[^/?#]+)/)
  return match?.[1]
}

// Looks up the DID registered for the space in the wallet-spaces registry
// (owned by the lcw-back-end stack), which is keyed by the space URL and is
// the authority on spaces: every space is registered there at creation. A
// space with no row is simply not a space anyone controls.
async function getSpaceControllerDid(spaceUrl) {
  const { Item: item } = await dynamoClient.send(new GetItemCommand({
    TableName: SPACES_TABLE_NAME,
    Key: { spaceURL: { S: spaceUrl } }
  }))
  // Registered DIDs may carry a key fragment (did:key:z6Mk...#z6Mk...)
  return item?.did?.S?.split('#')[0]
}

function rootCapabilityLoader(spaceController) {
  const loader = baseDocumentLoader.clone()

  loader.setProtocolHandler({
    protocol: 'urn',
    handler: {
      get: async ({ id, url }) => {
        const resolvedUrl = url || id
        const rootZcapTarget = decodeURIComponent(
          resolvedUrl.split('urn:zcap:root:')[1]
        )
        return {
          '@context': 'https://w3id.org/zcap/v1',
          id: resolvedUrl,
          invocationTarget: rootZcapTarget,
          controller: spaceController,
        }
      }
    }
  })
  return loader.build()
}

async function getVerifier({ keyId }) {
    const didDocument = await didKeyDriver.get({ url: keyId })
    const key = await Ed25519VerificationKey.from(didDocument)
    const verifier = key.verifier()
    return {
      verifier,
      verificationMethod: didDocument
    }
  }

  // API Gateway passes headers through with whatever casing the client sent, so
  // anything we read out of them has to be looked up case-insensitively.
  function getHeader(headers, name) {
    const match = Object.keys(headers).find(
      key => key.toLowerCase() === name.toLowerCase()
    )
    return match === undefined ? undefined : headers[match]
  }

  export const verifyZcap = async (event) => {
    const { headers = {} } = event

    // HTTP API authorizer payload v2: the method lives under
    // requestContext.http and the path is rawPath. The $default stage serves
    // at the root, so rawPath is exactly the path the client signed.
    const httpMethod = event.requestContext?.http?.method ?? event.httpMethod
    const path = event.rawPath ?? event.requestContext?.path ?? event.path

    const host = getHeader(headers, 'Host')
    const proto = getHeader(headers, 'X-Forwarded-Proto') ?? 'https'

    // The invoked capability's target should match the resource actually being requested.
    const url = proto + '://' + host + path

    // The root capability for the space is controlled by the DID registered
    // for it in the accounts table, so verification rejects invocations
    // signed by any other key.
    const spaceUrl = getSpaceUrl(url)
    if (!spaceUrl) {
      throw new Error(`No space URL in request URL: ${url}`)
    }
    const spaceController = await getSpaceControllerDid(spaceUrl)
    if (!spaceController) {
      throw new Error(`No account registered for space: ${spaceUrl}`)
    }

    let result
    try {
      result = await verifyCapabilityInvocation({
        url,
        method: httpMethod,
        // The signature is computed over the lowercase header name.
        headers: { ...headers, authorization: getHeader(headers, 'Authorization') },
        suite: new Ed25519Signature2020(),
        getVerifier,
        documentLoader: rootCapabilityLoader(spaceController),
        expectedHost: host,
        expectedAction: httpMethod,
        expectedTarget: url,
        expectedRootCapability: 'urn:zcap:root:' + encodeURIComponent(url)
      })
    } catch (err) {
      // A signature that fails to verify throws before any result is
      // returned. Log the inputs the server reconstructed the signed string
      // from (method, URL, and each signed header's received value), so a
      // mismatch with what the client signed can be pinpointed. The
      // signature value itself is omitted.
      const authorization = getHeader(headers, 'Authorization') ?? ''
      const signedNames = authorization.match(/headers="([^"]+)"/)?.[1]?.split(' ') ?? []
      const signedValues = Object.fromEntries(
        signedNames
          .filter(name => !name.startsWith('('))
          .map(name => [name, getHeader(headers, name)])
      )
      console.error('signature verification inputs:', JSON.stringify({
        method: httpMethod,
        url,
        keyId: authorization.match(/keyId="([^"]+)"/)?.[1],
        created: authorization.match(/created="([^"]+)"/)?.[1],
        expires: authorization.match(/expires="([^"]+)"/)?.[1],
        signedNames,
        signedValues
      }))
      throw err
    }

    if (!result.verified) {
      console.log("in the verifyZcap function - Verification failed:", JSON.stringify(result, null, 2));
      // `result.error` describes why verification failed (bad signature,
      // unexpected host, expired capability, unauthorized key, etc.)
      console.log(JSON.stringify(result, null, 2));
      throw result.error
    }

    // On success, `result` also includes the invoked `capability`,
    // `capabilityAction`, the `controller`/`invoker`, the `verificationMethod`,
    // and the `dereferencedChain`.
   // console.log('invoked by', result.controller)
   // console.log('result', JSON.stringify(result, null, 2));
    return result
  }
