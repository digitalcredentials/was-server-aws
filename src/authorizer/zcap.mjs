import {
  securityLoader
} from '@interop/security-document-loader'
import {
  verifyCapabilityInvocation
} from '@interop/http-signature-zcap-verify'

import * as didKey from '@interop/did-method-key'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import { Ed25519Signature2020 } from '@interop/ed25519-signature'
import { DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb'

const didKeyDriver = didKey.driver()
didKeyDriver.use({
  multibaseMultikeyHeader: 'z6Mk',
  fromMultibase: Ed25519VerificationKey.from
})

const baseDocumentLoader = securityLoader()

const dynamoClient = new DynamoDBClient()
const TABLE_NAME = process.env.TABLE_NAME ?? 'wallet-test'

// The space id is the path segment after /space
function getSpaceId(path) {
  const segments = path.split('/').filter(Boolean)
  const spaceIndex = segments.indexOf('space')
  return spaceIndex === -1 ? undefined : segments[spaceIndex + 1]
}

// Looks up the DID registered for the space in the accounts table. The table
// is keyed by email and stores the full space URL, so filter on the URL's
// trailing /space/<spaceId> segment.
async function getSpaceControllerDid(spaceId) {
  const { Items: items = [] } = await dynamoClient.send(new ScanCommand({
    TableName: TABLE_NAME,
    FilterExpression: 'contains(spaceURL, :spaceId)',
    ExpressionAttributeValues: { ':spaceId': { S: spaceId } }
  }))
  const account = items.find(
    item => (item.spaceURL?.S ?? '').endsWith(`/space/${spaceId}`)
  )
  // Registered DIDs may carry a key fragment (did:key:z6Mk...#z6Mk...)
  return account?.did?.S?.split('#')[0]
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
    const { httpMethod, path, headers = {} } = event

    const host = getHeader(headers, 'Host')
    const proto = getHeader(headers, 'X-Forwarded-Proto') ?? 'https'

    // The invoked capability's target should match the resource actually being requested.
    const url = proto + '://' + host + path

    // The root capability for the space is controlled by the DID registered
    // for it in the accounts table, so verification rejects invocations
    // signed by any other key.
    const spaceId = getSpaceId(path)
    if (!spaceId) {
      throw new Error(`No space id in request path: ${path}`)
    }
    const spaceController = await getSpaceControllerDid(spaceId)
    if (!spaceController) {
      throw new Error(`No account registered for space: ${spaceId}`)
    }

    const result = await verifyCapabilityInvocation({
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
