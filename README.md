# Wallet Attached Storage (WAS) server

An implementation of the [W3C CCG Wallet Attached Storage specification](https://w3c-ccg.github.io/wallet-attached-storage-spec/)
v0.5 on AWS: one Lambda function per endpoint behind an API Gateway HTTP
API, a gateway authorizer that verifies capability invocations, a layer of
shared code, each Space in its own S3 bucket, and the Space registry in
DynamoDB. The reference client is [`@interop/was-client`](https://www.npmjs.com/package/@interop/was-client)
(0.93 and later), which is what the Learner Credential Wallet uses; the live
conformance check in [test/live.mjs](test/live.mjs) drives this server
through that client.

## Endpoints

One function per endpoint ([src/endpoints/](src/endpoints/), each a short
file naming its operation). Container URLs are canonically trailing-slash
(`/space/{s}/`, `/space/{s}/{c}/`, `/spaces/`); the bare forms answer `308`
to the canonical one.

| Method | Path | Function | Operation |
| --- | --- | --- | --- |
| GET, HEAD | `/` | `ServiceGetFn` | the service description (discovery; no authorization) |
| POST | `/spaces/` | `SpacesPostFn` | provision a Space (`{controller, name?, type?, coupon}`) |
| GET | `/spaces/` | `SpacesGetFn` | list the caller's Spaces |
| GET | `/space/{s}/` | `SpaceCollectionsGetFn` | list the Space's Collections |
| POST | `/space/{s}/` | `CollectionCreateFn` | create a Collection (`{id?, name?, encryption?, ...}`) |
| DELETE | `/space/{s}/` | `SpaceDeleteFn` | delete the Space (bucket + registry row) |
| GET | `/space/{s}/meta` | `SpaceMetaGetFn` | Space Metadata |
| PUT | `/space/{s}/meta` | `SpaceMetaPutFn` | replace it (`type` write-once; `controller` fixed) |
| GET / PUT / DELETE | `/space/{s}/policy` | `SpacePolicy{Get,Put,Delete}Fn` | the Space's access-control policy |
| GET | `/space/{s}/{c}/` | `ResourceGetFn` | list the Collection's Resources |
| POST | `/space/{s}/{c}/` | `ResourceCreateFn` | create a Resource with a server-assigned id |
| DELETE | `/space/{s}/{c}/` | `ResourceDeleteFn` | delete the Collection and everything in it |
| GET | `/space/{s}/{c}/meta` | `CollectionMetaGetFn` | Collection Metadata (configuration + `custom`/`epoch`) |
| PUT | `/space/{s}/{c}/meta` | `CollectionMetaPutFn` | replace it (`If-None-Match: *` creates) |
| GET / PUT / DELETE | `/space/{s}/{c}/policy` | `CollectionPolicy{Get,Put,Delete}Fn` | the Collection's policy |
| GET, HEAD | `/space/{s}/{c}/{r}` | `ResourceGetFn` | Resource content |
| PUT | `/space/{s}/{c}/{r}` | `ResourcePutFn` | create or replace it |
| DELETE | `/space/{s}/{c}/{r}` | `ResourceDeleteFn` | delete it (permanently) |
| GET / PUT | `/space/{s}/{c}/{r}/meta` | `ResourceMeta{Get,Put}Fn` | Resource Metadata (derived fields + `custom`) |
| GET / PUT / DELETE | `/space/{s}/{c}/{r}/policy` | `ResourcePolicy{Get,Put,Delete}Fn` | the Resource's policy |
| anything else | | `DefaultFn` | `308` for the bare Space URL, `405` for reserved segments not implemented (`linkset`, `quotas`, `meta/log`, `chunks`, ...), else `404` |

**Trailing slashes.** The gateway matches `/space/{s}/` to the
`/space/{space_id}/{collection_id}` route with an empty `collection_id`,
and `/space/{s}/{c}/` to the `{resource_id}` route with an empty
`resource_id`. So the Space container's three operations live on the
`{collection_id}` route, and `ResourceGetFn` / `ResourceDeleteFn` serve the
Collection container when the final segment is empty. Each such function
has that one branch and nothing else.

### Discovery

Every response carries `Link: <{base}/>; rel="service"`. The document at
the root lists the one specification version served (`0.5`), the Spaces
Repository URL, and the feature tokens. A v0.5 client reads it before its
first signed request and refuses a server without it.

### Spaces Repository

**POST /spaces/** provisions a Space. Per the spec the request must be
authorized by the `controller` DID named in the body: the authorizer
verifies the invocation against the DID that signed it, and the function
requires that DID to be the stated controller. This server adds a `coupon`,
redeemed from the `was-coupons` table (optional `usesRemaining` and
`expiresAt`; an unknown, spent or expired coupon is a `403`). `type` is the
Space's type array (default `["Space"]`; the wallet marks batch spaces
`["Space", "BatchSpace"]`); `name` is kept in the Space Metadata and mirrored
to the registry for listings. The server assigns the id (`dcc-was-{uuid}`,
also the bucket name), creates the bucket with `meta/space.json`, registers
the Space, and answers `201` with `Location` and the metadata. Mint coupons
directly:

```sh
aws dynamodb put-item --table-name was-coupons --item \
  '{"coupon":{"S":"<secret>"},"usesRemaining":{"N":"5"},"expiresAt":{"S":"2027-01-01T00:00:00Z"}}'
```

**GET /spaces/** lists the Spaces registered to the DID that signed the
request (the registry's `by-did` index), paged. An unsigned or unverifiable
caller gets an empty list, never an error.

### Status codes, validators, errors

- Create: `201` with `Location` and `ETag`. Update: `204` (content) or `200`
  with the stored object (metadata, policies). Delete: `204`. A resource read
  carries `ETag` and `Last-Modified`; `If-None-Match` answers `304`.
- `If-Match` and `If-None-Match: *` are honored on every write and delete
  through S3's conditional operations, so the precondition is atomic with
  the write; failure is `412`. Metadata objects are versioned by their own
  ETag, independent of content.
- Errors are RFC 9457 `application/problem+json` with the spec's
  `https://w3id.org/pws#...` types (`not-found`, `invalid-id`, `reserved-id`,
  `id-conflict`, `precondition-failed`, `invalid-request-body`,
  `invalid-cursor`, `missing-content-type`, `missing-authorization`,
  `invalid-authorization-header`, `controller-mismatch`,
  `unsupported-operation`).
- Listings are `{ url, totalItems, items, next? }` with `?cursor=` and
  `?limit=` (default 100, max 1000); `next` is the absolute URL of the
  following page. Resource listings page over S3; Collection and Space
  listings page in memory.

### Collections and Resources

A Collection comes into existence through `POST /space/{s}/` (create-only;
a taken id is `409 id-conflict`), through `PUT .../meta` with
`If-None-Match: *`, or implicitly on the first Resource write into it (the
server then writes plaintext metadata for it). Content written straight into
a bucket by another service (the issuer's `collections/{id}/bundle.json`)
is also listed, and its `/meta` is synthesized, unversioned, until written.

Resource content is stored exactly as sent, under the `Content-Type` the
client gave (required). The content object carries the stamps Resource
Metadata derives: creation time and author, the `Key-Epoch` and `Writer-Id`
headers of the last write (an absent header clears the stamp). Binary
content is served base64-encoded through the gateway. Deletion is
permanent: the wallet keeps its own `Trash` collection.

### Authorization

Verification and the decision are split between the authorizer and the
functions, because a gateway denial is always a `403` and the spec's
answers are different.

- **The authorizer** ([src/authorizer/](src/authorizer/), bundled with the
  `@interop` verification stack) runs on every route except `/` and
  `$default`. For a Space URL it reads the Space's controller DID from the
  registry row for `{base}/space/{s}` and verifies the invocation against it
  (every `urn:zcap:root:...` resolves to a root capability controlled by
  that DID; a delegation chain may start from the invoked URL, the
  Collection or the Space container). For `/spaces/` it verifies against the
  DID that signed. The URL is checked as delivered and, when ids were
  percent-encoded, re-encoded — API Gateway hands the path decoded. It
  **never denies**: it answers `isAuthorized: true` with the result in the
  context (`signed`, `verified`, `controller`, `delegated`, `spaceController`,
  `spaceType`, or `space=missing`).
- **Each function** turns that context into the spec's answer through the
  shared `authorize()` ([layers/was-lib/.../auth.mjs](layers/was-lib/nodejs/node_modules/was-lib/auth.mjs)):
  a verified invocation proceeds; the container rule (`DELETE /space/{s}/`,
  `PUT /space/{s}/meta`, `DELETE /space/{s}/{c}/`, `PUT /space/{s}/{c}/meta`)
  refuses a delegated capability; the `Digest` header a signed body carries is
  recomputed over the received bytes (`400 invalid-authorization-header` on
  mismatch — the authorizer never sees the body, so this is what binds the
  signature to it); an unsigned `GET`/`HEAD` is allowed where a
  `PublicCanRead` policy covers the target (the Resource's own policy, else
  its Collection's, else the Space's; policies themselves are never public);
  anything else is `404`, except a listing (`200`, no items) and an unsigned
  write (`401 missing-authorization`).

### Permissions

Each function's role carries only the actions and key prefixes its
operation touches, so a defect is bounded by the function it is in:

- read functions have `s3:GetObject` on their prefix and on `policies/*`
  (the public-read cascade), nothing that writes or deletes;
- every function that checks whether a key exists also has `s3:ListBucket`
  conditioned on its own prefixes (`s3:prefix`): without it S3 answers a
  `HEAD`/`GET` of a missing key with `403` rather than `404`;
- write functions add `s3:PutObject` on their prefix, never `DeleteObject`;
- delete functions add `s3:DeleteObject`, never `PutObject`;
- only `SpacesPostFn` can create a bucket or write a registry row; only
  `SpaceDeleteFn` can delete a bucket or a registry row; only
  `SpaceMetaPutFn` can update a registry row;
- `ServiceGetFn` and `DefaultFn` have no permissions and no authorizer.

The layer is code, not permissions: whatever a shared function tries, AWS
checks against the role of the lambda it is running in.

## Storage layout

One S3 bucket per Space, named for the space id.

```
s3://{space_id}/
├── meta/
│   ├── space.json                Space Metadata
│   ├── {collection_id}.json      Collection Metadata
│   └── {collection_id}/
│       └── {resource_id}.json    Resource Metadata (the custom annotation)
├── policies/
│   ├── space.json
│   ├── {collection_id}.json
│   └── {collection_id}/{resource_id}.json
└── collections/
    └── {collection_id}/
        └── {resource_id}         Resource content
```

The registry (`wallet-spaces`, owned by the lcw-back-end stack) has one row
per Space: `spaceURL` (no trailing slash), `did`, `type` (a list), `name`,
`CreatedAt`.

## Project layout

```
layers/was-lib/nodejs/node_modules/was-lib/   the shared layer (plain ESM, no dependencies)
├── handler.mjs      handler(operation, {scope, ...}): parse, resolve ids, authorize, run
├── auth.mjs         the authorization decision from the authorizer's context; Digest check
├── http.mjs         request parsing, responses, problem+json, the service link
├── ids.mjs          reserved segments, id rules
├── meta.mjs         reading and composing the metadata objects (used by several endpoints)
├── policy.mjs       PublicCanRead evaluation
├── problems.mjs     problem types
├── store.mjs        S3 (conditional writes, listings)
└── ops/             only what more than one endpoint runs: the policy operations
                     (three lambdas each), the content write (put and create),
                     pagination helpers
                     Everything a single endpoint does -- the registry row writes,
                     bucket creation and deletion, coupons, the annotation write --
                     is in that endpoint's own file.
src/authorizer/      the gateway authorizer (verification only; bundled)
src/endpoints/       one directory per endpoint, grouped by what the route addresses;
│                    each app.mjs is that endpoint's operation
├── service/get
├── spaces/          post, get
├── space/           collections-get, collection-create, delete, meta-get, meta-put,
│                    policy-get, policy-put, policy-delete
├── collection/      meta-get, meta-put, policy-get, policy-put, policy-delete
├── resource/        get, create, put, delete, meta-get, meta-put,
│                    policy-get, policy-put, policy-delete
└── default
test/
├── api.test.mjs     in-process tests (routing, authorizer and functions; AWS faked)
├── routes.mjs       the gateway route table, matched the way the gateway matches
├── fakes.mjs        in-memory S3 and DynamoDB
├── harness.mjs      signed events, the way the client signs them
└── live.mjs         conformance check through @interop/was-client against a deployment
template.yaml        all AWS resources: the API, the authorizer, the layer, 27 functions
```

Handlers import the layer as `was-lib/...`; in Lambda that resolves from
`/opt/nodejs/node_modules`, locally from the root `package.json`'s `file:`
link to the layer directory. The authorizer is bundled with esbuild (its
`@interop/*` dependencies are not available to the runtime otherwise) and
imports `@interop/http-client` first on purpose: a CJS dependency
`require()`s that ESM package mid-graph and hits a TDZ error otherwise.

## Requirements

* [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/serverless-sam-cli-install.html)
* Node.js 24 (the Lambda runtime is `nodejs24.x`; the tests run on 22)

## Build and deploy

```bash
sam build
sam deploy
```

The stack's one parameter, `SpaceBaseUrl`, is the base of registered space
URLs (`https://was.lcw-sandbox.org/space`). Keep it with
`UsePreviousValue` when deploying a change set.

## Tests

```bash
npm install                       # links the layer for local resolution
npm install --prefix src/authorizer
npm install --prefix test
npm test                          # test/api.test.mjs
```

[test/api.test.mjs](test/api.test.mjs) runs each request through the
gateway's route table ([test/routes.mjs](test/routes.mjs)), the real
authorizer, and the endpoint function it reaches, with S3 and DynamoDB
faked ([test/fakes.mjs](test/fakes.mjs), including S3's conditional writes
and paged listings). Every request is signed by
[test/harness.mjs](test/harness.mjs) the way `@interop/was-client` signs it —
an invocation of the request URL's root capability with a `Digest` over the
body — and delivered the way API Gateway delivers it (path decoded, path
parameters filled). It covers discovery, the repository, every endpoint's
status codes and validators, pagination, encoded ids, policies and public
reads, and the authorization answers (404, empty listings, 401).

```bash
WAS_URL=https://was.lcw-sandbox.org COUPON=<coupon> npm run live
```

[test/live.mjs](test/live.mjs) is the conformance check against a
deployment, through `@interop/was-client` itself: discovery, a scratch
Space, Space and Collection metadata with compare-and-swap, an encrypted
collection (`createCollection` + `ensureFirstEpoch`, `add`, `get`, encrypted
`setName`), plaintext resources with validators, resource metadata,
policies and public reads, listings, deletes. The Space it creates is
deleted at the end. Run it after every deploy.

## Logs

```bash
sam logs -n WASZcapAuthorizerFn --stack-name was-server --tail
```

A rejected invocation is logged by the authorizer with its reason; the
response deliberately says only `404`.

## Known gaps

- **Delegated capabilities** verify in principle (chains rooted at the
  invoked URL, its Collection or the Space) but are untested here, and the
  delegation proof suite the client signs with (`eddsa-jcs-2022`) is not yet
  configured on the verifier.
- **No replay protection.** A captured signed request can be replayed until
  its `expires` passes.
- **`expectedHost` is the request's own `Host` header**, so it constrains
  nothing by itself; the registry lookup keyed by host is what prevents a
  spoofed host from widening access.
- **Collection and Space listings are read whole** before paging; fine for
  the number of collections a wallet holds, not for thousands.
- **Resource listings `HEAD` each object** for its content type and stamps.
- Optional profiles not implemented: chunked resources, quotas, backends,
  linksets, query, export/import.

## Resources

- [WAS specification](https://w3c-ccg.github.io/wallet-attached-storage-spec/)
- [@interop/was-client](https://github.com/interop-alliance/was-client)
- [AWS SAM developer guide](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/what-is-sam.html)
