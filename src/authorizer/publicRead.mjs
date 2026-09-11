import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'

const s3 = new S3Client({})

// Whether an unsigned request may proceed: only a GET of a space, collection,
// or resource covered by a PublicCanRead policy. The policy cascade widens
// outward -- the resource's own policy, else its collection's, else the
// space's -- reading the same policies/ keys the policy endpoints write.
// Policy sub-resources themselves are never public.
export async function isPublicRead (event) {
  const method = event.requestContext?.http?.method ?? event.httpMethod
  if (method !== 'GET') {
    return false
  }

  const path = event.rawPath ?? event.requestContext?.path ?? event.path
  const segments = (path ?? '').split('/').filter(Boolean)
  if (segments[0] !== 'space' || !segments[1] || segments.length > 4) {
    return false
  }
  if (segments[segments.length - 1] === 'policy') {
    return false
  }

  const [, spaceId, collectionId, resourceId] = segments

  const keys = []
  if (collectionId && resourceId) {
    keys.push(`policies/${collectionId}/${resourceId}.json`)
  }
  // 'collections' is the space's listing route, not a collection id
  if (collectionId && collectionId !== 'collections') {
    keys.push(`policies/${collectionId}.json`)
  }
  keys.push('policies/space.json')

  for (const key of keys) {
    try {
      const { Body } = await s3.send(
        new GetObjectCommand({ Bucket: spaceId, Key: key })
      )
      const policy = JSON.parse(await Body.transformToString())
      if (policy?.type === 'PublicCanRead') {
        return true
      }
    } catch (err) {
      if (err.name !== 'NoSuchKey' && err.name !== 'NoSuchBucket') {
        console.error(`policy lookup failed for ${key}:`, err)
        return false
      }
    }
  }
  return false
}
