# Wallet Attached Storage (WAS) API

An implementation of part of the [W3C CCG Wallet Attached Storage
specification](https://w3c-ccg.github.io/wallet-attached-storage-spec/), built as
AWS Lambda functions behind an API Gateway HTTP API, with objects stored in S3.

Requests are authorized with signed zCap (Authorization Capability) invocations,
verified by a single Lambda REQUEST authorizer rather than by each handler. An
HTTP API (rather than a REST API) because its CORS is a real gateway feature
injected into every response — on a REST API only the OPTIONS preflight can be
configured centrally — and because its `$default` stage serves at the root, so
URLs carry no `/Prod` prefix.

## Endpoints

| Method | Path | Function | Source |
| --- | --- | --- | --- |
| GET | `/space/{space_id}` | `SpaceDescriptionGetFn` | [src/spaces/description/get](src/spaces/description/get/app.mjs) |
| GET | `/space/{space_id}/collections` | `SpaceCollectionsListGetFn` | [src/spaces/get](src/spaces/get/app.mjs) |
| GET | `/space/{space_id}/{collection_id}` | `CollectionsGetFn` | [src/collections/get](src/collections/get/app.mjs) |
| PUT | `/space/{space_id}/{collection_id}` | `CollectionsPutFn` | [src/collections/put](src/collections/put/app.mjs) |
| GET | `/space/{space_id}/{collection_id}/{resource_id}` | `ResourcesGetFn` | [src/resources/get](src/resources/get/app.mjs) |
| PUT | `/space/{space_id}/{collection_id}/{resource_id}` | `ResourcesPutFn` | [src/resources/put](src/resources/put/app.mjs) |
| DELETE | `/space/{space_id}/{collection_id}/{resource_id}` | `ResourcesDeleteFn` | [src/resources/delete](src/resources/delete/app.mjs) |
| GET/PUT/DELETE | `/space/{space_id}/policy`, `.../{collection_id}/policy`, `.../{resource_id}/policy` | `PoliciesFn` | [src/policies](src/policies/app.mjs) |

**Trailing slashes.** WAS list URLs end in a slash (`/space/{s}/collections/`
lists a Space's Collections; `/space/{s}/{c}/` lists a Collection's members).
A deployed HTTP API cannot route a trailing slash to its own route key — the
empty last segment matches the resource route with an empty `resource_id` — so
`ResourcesGetFn` dispatches an empty `resource_id` to the appropriate listing.
(`sam local` collapses the trailing slash instead, where `CollectionsGetFn`'s
own listing branch handles it.)

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

### `PUT /space/{space_id}/{collection_id}` and `PUT .../{resource_id}`

Upsert a Collection description or a member resource. Both return **201** with
a `Location` header on create and **200** on update, always with a JSON body —
API Gateway defaults the `Content-Type` to `application/json`, so an empty
body breaks clients that trust the header.

### `DELETE /space/{space_id}/{collection_id}/{resource_id}`

A soft delete: the object is copied into the Space's `Trash` collection and the
original removed. Deleting a resource already in `Trash` removes it
permanently. Responds 200 with a JSON body pointing at the trashed location.

### `{GET,PUT,DELETE} .../policy` — access-control policies

Policy sub-resources exist at all three scopes: the Space, a Collection, and a
resource. A policy document is stored under the bucket's `policies/` prefix
(mirroring the path it governs), so policies never appear in listings. PUT
upserts the document, GET returns it, DELETE reverts the scope to
capability-only access. The one policy the system acts on is `PublicCanRead`
(what `@interop/was-client`'s `setPublic()` writes): it lets **unsigned GETs**
read the covered scope — see Authorization below. The LCW front end uses a
resource-scoped policy for its public share links, so a shared credential's
collection and siblings stay private.

## Storage layout

**One S3 bucket per Space, named for the `space_id`.** The bucket *is* the Space,
so keys are already rooted at the Space and contain no `/space/{space_id}`
segment.

```
s3://{space_id}/
├── metadata/
│   └── description.json          <- the Space description
├── policies/                     <- access-control policies, keyed by governed path
│   └── {collection_id}/
│       └── {resource_id}.json    <- e.g. a resource-scoped PublicCanRead policy
└── collections/
    ├── Trash/                    <- soft-deleted resources (created on first delete)
    └── {collection_id}/
        ├── description.json      <- the Collection description
        ├── {resource_id}         <- a member resource
        └── {resource_id}
```

## Authorization

Every route on `WASApi` is protected by `WASZcapAuthorizer`, a Lambda **REQUEST**
authorizer declared as the API's `DefaultAuthorizer`. Handlers do no verification
of their own.

The authorizer runs for **unsigned requests too** (it declares no
`Authorization` identity source, which would make API Gateway answer 401
before the authorizer could look). A request without authorization headers is
allowed only as a **public read**: a GET of a space, collection, or resource
covered by a `PublicCanRead` policy, cascading outward — the resource's own
policy, else its collection's, else the space's
([src/authorizer/publicRead.mjs](src/authorizer/publicRead.mjs)). Such
requests get `context.controller = "public"`. Policy sub-resources themselves
are never public, and unsigned writes are always denied.

- [src/authorizer/app.mjs](src/authorizer/app.mjs) — the authorizer entry
  point; returns an HTTP API *simple response* (`{ isAuthorized, context }`,
  payload format 2.0).
- [src/authorizer/zcap.mjs](src/authorizer/zcap.mjs) — `verifyZcap`, which wraps
  `verifyCapabilityInvocation` from `@interop/http-signature-zcap-verify`.

The **space's controller DID comes from the accounts table** (the `wallet-test`
DynamoDB table owned by the lcw-back-end stack): `verifyZcap` takes everything
in the request URL up to and including the `{space_id}` segment — which also
matches the invoked zcap target — and looks it up against the registered
`spaceURL` by exact match. That account's `did` controls the root capability,
so only invocations signed by the registered key verify, and an unregistered
space is rejected outright.

`verifyZcap(event)` derives everything else from the payload-v2 event:

| `verifyCapabilityInvocation` argument | Derived from |
| --- | --- |
| `url`, `expectedTarget` | `x-forwarded-proto` + `host` header + `event.rawPath` |
| `method`, `expectedAction` | `event.requestContext.http.method` |
| `expectedHost` | `host` header |
| `expectedRootCapability` | `urn:zcap:root:` + URI-encoded target |
| `headers` | `event.headers`, with `authorization` normalized to lowercase |

Header lookups are case-insensitive; the `$default` stage serves at the root,
so `rawPath` is exactly the path the client signed.

On success the authorizer answers `{ isAuthorized: true, context: {...} }`.
HTTP APIs nest that context under `lambda`, so handlers read:

```js
const { controller, capability, capabilityAction } =
  event.requestContext.authorizer.lambda;
```

Context values must be scalars — no nested objects or arrays — so the capability
is passed as its id string.

On failure the authorizer answers `{ isAuthorized: false }`, which API Gateway
maps to a **403** (a missing `Authorization` header never reaches the
authorizer: the gateway answers 401 itself, because the header is the declared
identity source). The real verification error is logged, never returned.

Deliberate settings in `template.yaml`:

- **`ReauthorizeEvery: 0`** disables the authorizer result cache. Each zCap is
  signed over its own request, so a cached decision would authorize a *different*
  request than the one that was actually verified.
- **`CorsConfiguration`** on the API handles the OPTIONS preflight and injects
  the CORS headers into every response — including authorizer denials — with
  nothing per handler. Preflights are never sent to the authorizer.

## Project layout

```
src/
├── authorizer/            zCap REQUEST authorizer (deps bundled, no layer)
│   ├── app.mjs            simple-response construction
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
│   │                      (also serves trailing-slash listings; see Endpoints)
│   ├── put/               PUT /space/{space_id}/{collection_id}/{resource_id}
│   └── delete/            DELETE /space/{space_id}/{collection_id}/{resource_id}
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
`resource-put`, `resource-get`, `resource-delete`. `--invalid` corrupts the
signature to exercise the denial path. Diagnostics go to stderr, so the pipe
stays clean.

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
| `resource-delete.json` | `DELETE /space/{space_id}/{collection_id}/{resource_id}` |

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
controller). It asserts that each route answers `{ isAuthorized: true }` with
the controller and capability on the context, that a tampered signature answers
`{ isAuthorized: false }` (a denial, which API Gateway maps to a 403 — never a
thrown error, which would be a 500), and that the controller embedded in the
static proxy fixtures still matches the key the signer derives, so a seed change
cannot leave them quietly stale.

[events/handlers.test.mjs](events/handlers.test.mjs) then runs every route
handler in process on `node --test`, feeding it the same proxy events the
fixtures are generated from and stubbing `S3Client.prototype.send` per test. It
covers the happy paths (listings — including the trailing-slash dispatch
through the resource handler — descriptions, resource reads) and the write
semantics: 201-with-`Location` vs 200 on PUT, the soft delete into `Trash` and
the permanent delete from it, `ETag` passthrough, base64 body decoding, the
400s for malformed collection descriptions, the reserved `description.json`
key, and the `NoSuchBucket`/`NoSuchKey` 404s.

The signing key is a throwaway for a seed that is already public in this repo.
Never point it at a real deployment.

## Logs

```bash
sam logs -n WASZcapAuthorizerFn --stack-name "YOUR_STACK_NAME" --tail
```

When a request is denied (403), the authorizer's log group has the real
verification error; the response body deliberately does not.

## Cleanup

```bash
sam delete
```

## Known gaps

- **`expectedHost` no longer constrains anything.** It is derived from the
  request's own `Host` header, so the comparison is self-satisfying — though a
  spoofed `Host` also changes the space URL the accounts-table lookup matches
  against, so it no longer widens access on its own. Restoring the guard needs
  a server-controlled source: an environment variable, or
  `event.requestContext.domainName`.
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
- [HTTP API Lambda authorizers](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-lambda-authorizer.html)
