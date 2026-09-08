# Wallet Attached Storage (WAS) API

An implementation of part of the [W3C CCG Wallet Attached Storage
specification](https://w3c-ccg.github.io/wallet-attached-storage-spec/), built as
AWS Lambda functions behind an API Gateway REST API, with objects stored in S3.

Requests are authorized with signed zCap (Authorization Capability) invocations,
verified by a single API Gateway Lambda REQUEST authorizer rather than by each
handler.

## Endpoints

| Method | Path | Function | Source |
| --- | --- | --- | --- |
| GET | `/space/{space_id}` | `SpaceDescriptionGetFn` | [src/spaces/description/get](src/spaces/description/get/app.mjs) |
| GET | `/space/{space_id}/collections` | `SpaceCollectionsListGetFn` | [src/spaces/get](src/spaces/get/app.mjs) |
| GET | `/space/{space_id}/{collection_id}` | `CollectionsGetFn` | [src/collections/get](src/collections/get/app.mjs) |

### `GET /space/{space_id}`

Implements [http-api-get-space-space_id](https://w3c-ccg.github.io/wallet-attached-storage-spec/#http-api-get-space-space_id).
Returns the Space's description document. The handler reads
`metadata/description.json` from the Space's bucket, then overlays the fields the
server owns, so the response stays spec-shaped even if the stored document is
partial:

```json
{
  "id": "<space_id>",
  "url": "/space/<space_id>",
  "type": ["Space"],
  "name": "Example space #1",
  "controller": "did:key:z6Mk...",
  "createdBy": "did:key:z6Mk...",
  "linkset": "/space/<space_id>/linkset"
}
```

`name`, `controller`, `createdBy` and any other authored fields pass through from
the stored document. `id`, `url`, `type` and `linkset` are always derived from
the request path.

### `GET /space/{space_id}/collections`

Lists the Collections in a Space, by listing the `collections/` prefix with
`Delimiter: "/"` and reading `CommonPrefixes` — each sub-folder is one
Collection.

### `GET /space/{space_id}/{collection_id}`

Behaviour depends on the trailing slash:

- **With** a trailing slash — lists the Collection's member resources, by listing
  `collections/{collection_id}/` and reading `Contents`. Keys named in
  `RESERVED_RESOURCE_IDS` (currently the folder marker and `description.json`)
  are excluded, since they are not members of the Collection.
- **Without** — returns the Collection's own
  `collections/{collection_id}/description.json` verbatim.

## Storage layout

**One S3 bucket per Space, named for the `space_id`.** The bucket *is* the Space,
so keys are already rooted at the Space and contain no `/space/{space_id}`
segment.

```
s3://{space_id}/
├── metadata/
│   └── description.json          <- the Space description
└── collections/
    └── {collection_id}/
        ├── description.json      <- the Collection description
        ├── {resource_id}         <- a member resource
        └── {resource_id}
```

## Authorization

Every route on `WASApi` is protected by `WASZcapAuthorizer`, a Lambda **REQUEST**
authorizer declared as the API's `DefaultAuthorizer`. Handlers do no verification
of their own.

- [src/authorizer/app.mjs](src/authorizer/app.mjs) — the authorizer entry point;
  builds the IAM policy.
- [src/authorizer/zcap.mjs](src/authorizer/zcap.mjs) — `verifyZcap`, which wraps
  `verifyCapabilityInvocation` from `@interop/http-signature-zcap-verify`.

`verifyZcap(event)` takes the Lambda event as its only argument and derives
everything it needs from it:

| `verifyCapabilityInvocation` argument | Derived from |
| --- | --- |
| `url`, `expectedTarget` | `X-Forwarded-Proto` + `Host` + `event.path` |
| `method`, `expectedAction` | `event.httpMethod` |
| `expectedHost` | `Host` header |
| `expectedRootCapability` | `urn:zcap:root:` + URI-encoded target |
| `headers` | `event.headers`, with `authorization` normalized to lowercase |

A REQUEST authorizer event carries `headers`, `path` and `httpMethod` under the
same names a proxy-integration event does, so the event passes straight through.
Header lookups are case-insensitive, because API Gateway preserves whatever
casing the client sent.

On success the authorizer returns an `Allow` policy scoped to `event.methodArn`,
plus the invoker on the authorizer context. Handlers can read it from
`event.requestContext.authorizer`:

```js
const { controller, capability, capabilityAction } = event.requestContext.authorizer;
```

Context values must be scalars — no nested objects or arrays — so the capability
is passed as its id string.

On failure the authorizer throws an error whose message is exactly
`Unauthorized`, which is what API Gateway maps to a **401**. Rethrowing the
underlying verification error would surface as a 500 instead, so the real reason
is logged rather than thrown.

Two settings in `template.yaml` are deliberate and should not be changed without
thought:

- **`ReauthorizeEvery: 0`** disables the authorizer result cache. Each zCap is
  signed over its own request, so a cached decision would authorize a *different*
  request than the one that was actually verified.
- **`AddDefaultAuthorizerToCorsPreflight: false`**. SAM defaults this to `true`,
  which puts the authorizer in front of `OPTIONS`. Preflight carries no
  `Authorization` header, so the browser would get a 401 and never reach the real
  request.

## Project layout

```
src/
├── authorizer/            zCap REQUEST authorizer (deps bundled, no layer)
│   ├── app.mjs            policy construction
│   ├── zcap.mjs           verifyZcap / verifyCapabilityInvocation
│   └── package.json       @interop/* dependencies
├── spaces/
│   ├── description/get/   GET /space/{space_id}
│   └── get/               GET /space/{space_id}/collections
├── collections/
│   ├── get/               GET /space/{space_id}/{collection_id}
│   └── put/               PUT /space/{space_id}/{collection_id}
├── resources/
│   ├── get/               GET /space/{space_id}/{collection_id}/{resource_id}
│   └── put/               PUT /space/{space_id}/{collection_id}/{resource_id}
└── sharedLayer/           dead code; commented out of template.yaml
events/
├── routes.mjs             shared route table + event scaffolding
├── sign.mjs               prints a freshly-signed authorizer event to stdout
├── generate.mjs           rewrites the static proxy fixtures
├── check.mjs              signs fresh + runs the real authorizer (npm test)
├── handlers.test.mjs      in-process route handler tests, S3 stubbed (npm test)
└── *.json                 static, unsigned proxy events
template.yaml              all AWS resources
package.json               root test script + @aws-sdk/client-s3 devDependency
                           (Lambda provides the SDK at runtime; handler tests
                           resolve this local copy)
```

### Build notes

Only `WASZcapAuthorizerFn` has a `Metadata` block. It is the one function with
third-party dependencies, so it is the only one that needs bundling:

- **`BuildMethod: esbuild`** bundles its `@interop/*` dependencies into a single
  ~1 MB `app.mjs`, since they are not available to the runtime any other way.
- **`Banner`** injects `createRequire`, which is what lets those bundled CJS
  dependencies work inside an ESM output.

It also overrides the 3s `Globals` timeout to 10s, because a cold start does DID
resolution and Ed25519 verification.

The S3 handlers use SAM's default Node.js builder, which copies the source
as-is. They import nothing but `@aws-sdk/client-s3`, which
[every supported Node.js runtime provides](https://docs.aws.amazon.com/lambda/latest/dg/lambda-nodejs.html#nodejs-sdk-included),
so there is nothing to bundle. `.mjs` files are treated as ESM by Node
regardless of any build setting, and each handler directory carries a
`package.json` with `"type": "module"` as well.

## Requirements

* [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/serverless-sam-cli-install.html)
* [Docker](https://hub.docker.com/search/?type=edition&offering=community) (only for `--use-container` builds)
* Node.js 24 (the Lambda runtime is `nodejs24.x`)

## Build and deploy

```bash
sam build
sam deploy --guided
```

Subsequent deploys are just `sam deploy`. Endpoint URLs are in the stack outputs.

To build one function at a time:

```bash
sam build WASZcapAuthorizerFn
```

## Test locally

```bash
sam local start-api
curl http://localhost:3000/space/{space_id}
```

The API runs on port 3000, which is why `localhost:3000` shows up as the expected
host in signed test invocations. `sam local start-api` does invoke the Lambda
authorizer, so local requests need a validly signed zCap too.

A single function can be invoked directly with a test event, which bypasses the
authorizer. See [Test events](#test-events) below for where those come from:

```bash
sam local invoke SpaceDescriptionGetFn --event events/space-description-get.json
```

## Test events

`events/` handles the two event shapes differently, because only one of them
needs a signature.

```bash
cd events && npm install
```

### Authorizer events — signed on demand

`WASZcapAuthorizerFn` needs a valid signature, so its events are generated per
invocation and never stored. [events/sign.mjs](events/sign.mjs) prints one to
stdout, and `sam local invoke` reads an event from stdin with `-e -`:

```bash
node sign.mjs space-description-get | sam local invoke WASZcapAuthorizerFn -e -
node sign.mjs space-description-get --invalid | sam local invoke WASZcapAuthorizerFn -e -
```

Routes: `space-description-get`, `space-collections-list-get`,
`collection-list-get`, `collection-description-get`, `collection-put`,
`resource-put`, `resource-get`. `--invalid` corrupts the signature to exercise
the 401 path. Diagnostics go to stderr, so the pipe stays clean.

Signing on demand avoids the trap that static signed fixtures fall into: the
signer sets `expires` to `created + 600` and the signature covers the
`(expires)` pseudo-header, so a stored signed event stops verifying ten minutes
after it is written. A fresh one is always inside that window.

The authorizer resolves each space's controller DID from the accounts table
([src/authorizer/zcap.mjs](src/authorizer/zcap.mjs)), and only an invocation
signed by that DID verifies. `check.mjs` stubs the lookup so the test signing
key is always the registered controller; to exercise a real deployment with
`sign.mjs`, the account for `SPACE_ID` must be registered with the DID the test
seed derives. A signature also covers `(request-target)` and `host`, so it is
bound to one route and one host — it is not reusable across paths. Routes with
a body additionally get a signed `digest` header over the JSON payload.

### Proxy events — static, unsigned

| File | Route |
| --- | --- |
| `space-description-get.json` | `GET /space/{space_id}` |
| `space-collections-list-get.json` | `GET /space/{space_id}/collections` |
| `collection-list-get.json` | collection listing (trailing slash) |
| `collection-description-get.json` | collection description (no trailing slash) |
| `collection-put.json` | `PUT /space/{space_id}/{collection_id}` |
| `resource-put.json` | `PUT /space/{space_id}/{collection_id}/{resource_id}` |
| `resource-get.json` | `GET /space/{space_id}/{collection_id}/{resource_id}` |

These are what a route handler sees, for invoking one directly:

```bash
sam local invoke SpaceDescriptionGetFn --event events/space-description-get.json
```

They carry no signature. The authorizer has already run by the time a handler is
invoked and no handler reads the `Authorization` header, so a signature here
would be decoration that goes stale. They do carry a filled-in
`requestContext.authorizer` block, so handler code that reads the invoker finds
something realistic.

Rewrite them with `npm run generate` after changing a route or path.

### Checking it all works

```bash
npm test        # from the repo root or from events/
```

Running it from the repo root needs a one-time `npm install` there too (it
provides the `@aws-sdk/client-s3` the handler tests resolve).

[events/check.mjs](events/check.mjs) signs a fresh invocation for each route and
runs it through the real authorizer in process — no files, no Docker, no AWS
(the accounts-table lookup is stubbed to register the test key as the space's
controller). It asserts that each route returns `Allow` scoped to the right
`methodArn`, that a tampered signature throws exactly `Unauthorized` (the
message API Gateway maps to a 401), and that the controller embedded in the
static proxy fixtures still matches the key the signer derives, so a seed change
cannot leave them quietly stale.

[events/handlers.test.mjs](events/handlers.test.mjs) then runs every route
handler in process on `node --test`, feeding it the same proxy events the
fixtures are generated from and stubbing `S3Client.prototype.send` per test. It
covers the happy paths (listings, descriptions, resource reads) and the write
semantics: 201-with-`Location` vs 204 on PUT, `ETag` passthrough, base64 body
decoding, the 400s for malformed collection descriptions, the reserved
`description.json` key, and the `NoSuchBucket`/`NoSuchKey` 404s.

The signing key is a throwaway for a seed that is already public in this repo.
Never point it at a real deployment.

## Logs

```bash
sam logs -n WASZcapAuthorizerFn --stack-name "YOUR_STACK_NAME" --tail
```

When a request 401s, the authorizer's log group has the real verification error;
the response body deliberately does not.

## Cleanup

```bash
sam delete
```

## Known gaps

- **The dev signing seed is hardcoded.** `zcap.mjs` derives `spaceController` —
  the DID every root capability is issued to, and therefore the root authority
  for all Spaces — from a literal `testSeed`. This must move to Secrets Manager
  or SSM before the API is exposed.
- **`expectedHost` no longer constrains anything.** It is derived from the
  request's own `Host` header, so the comparison is self-satisfying and a spoofed
  `Host` passes. Restoring the guard needs a server-controlled source: an
  environment variable, or `event.requestContext.domainName`.
- **`src/resources/put` is not deployed.** The handler exists and writes to
  `collections/{collection_id}/{resource_id}`, but `template.yaml` declares no
  function or route for it. There is a leftover `ResourcesApi` output that
  advertises a path nothing serves.
- **`src/sharedLayer` is dead code.** `verifyZcap` moved into the authorizer and
  nothing imports the layer any more, so `DCCSharedLayer` is commented out in
  `template.yaml` along with every `Layers:` and `External:` reference to it. The
  source is still on disk and still contains a stale duplicate of `verifyZcap`,
  which will drift from the real one in `src/authorizer/zcap.mjs`.
- **Listings are not paginated.** `ListObjectsV2` returns at most 1000 keys and
  the handlers ignore `IsTruncated`, so larger Spaces and Collections silently
  truncate.
- **Query strings are not covered.** `event.path` omits the query string, so a
  capability signed over a URL with query parameters will not match.
- **No replay protection.** Nothing tracks invocation nonces, so a captured
  signed request can be replayed until its `expires` passes — and the verifier
  only checks `expires` when the header is present, so an invocation signed
  without one is replayable indefinitely.
- **`/space/{space_id}/linkset` is advertised but not implemented.** The Space
  description returns a `linkset` URL; no route serves it.
- **`S3ReadPolicy: BucketName: '*'`** grants read on every bucket in the account,
  not just Space buckets.

## Resources

- [WAS specification](https://w3c-ccg.github.io/wallet-attached-storage-spec/)
- [AWS SAM developer guide](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/what-is-sam.html)
- [API Gateway Lambda authorizers](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-use-lambda-authorizer.html)
