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
| GET, HEAD | `/service`, `/` | `ServiceGetFn` | the service description (discovery; no authorization) |
| POST | `/spaces/` | `SpacesPostFn` | provision a Space (`{controller, name?, type?, coupon, id?}`) |
| GET | `/spaces/` | `SpacesGetFn` | list the caller's Spaces |
| GET | `/space/{s}/` | `SpaceCollectionsGetFn` | list the Space's Collections |
| POST | `/space/{s}/` | `CollectionCreateFn` | create a Collection (`{id?, name?, encryption?, ...}`) |
| DELETE | `/space/{s}/` | `SpaceDeleteFn` | delete the Space (bucket + registry row) |
| GET | `/space/{s}/meta` | `SpaceMetaGetFn` | Space Metadata |
| PUT | `/space/{s}/meta` | `SpaceMetaPutFn` | replace it (`type` write-once; `controller` fixed) |
| GET / PUT / DELETE | `/space/{s}/policy` | `SpacePolicy{Get,Put,Delete}Fn` | the Space's access-control policy |
| POST | `/space/{s}/export` | `SpaceExportFn` | the Space as a Space archive (tar) |
| POST | `/space/{s}/import` | `SpaceImportFn` | merge a Space archive into the Space |
| POST | `/space/{s}/zcaps/revocations/{id}` | `SpaceRevocationPostFn` | revoke a delegated capability rooted in the Space (the body is the capability) |
| GET | `/space/{s}/{c}/` | `ResourceGetFn` | list the Collection's Resources |
| POST | `/space/{s}/{c}/` | `ResourceCreateFn` | create a Resource with a server-assigned id |
| DELETE | `/space/{s}/{c}/` | `ResourceDeleteFn` | delete the Collection and everything in it |
| GET | `/space/{s}/{c}/meta` | `CollectionMetaGetFn` | Collection Metadata (configuration + `custom`/`epoch`) |
| PUT | `/space/{s}/{c}/meta` | `CollectionMetaPutFn` | replace it (`If-None-Match: *` creates) |
| GET / PUT / DELETE | `/space/{s}/{c}/policy` | `CollectionPolicy{Get,Put,Delete}Fn` | the Collection's policy |
| GET, HEAD | `/space/{s}/{c}/meta/log` | `CollectionLogGetFn` | the Collection's governing history log (JSON Lines) |
| PUT | `/space/{s}/{c}/meta/log` | `CollectionLogPutFn` | declare it (`If-None-Match: *`) or append one entry (`If-Match`) |
| POST, GET | `/space/{s}/{c}/query` | `CollectionQueryFn` | the `changes` query profile: the Collection's replication feed |
| GET, HEAD | `/space/{s}/{c}/{r}` | `ResourceGetFn` | Resource content |
| PUT | `/space/{s}/{c}/{r}` | `ResourcePutFn` | create or replace it |
| DELETE | `/space/{s}/{c}/{r}` | `ResourceDeleteFn` | delete it (permanently) |
| GET / PUT | `/space/{s}/{c}/{r}/meta` | `ResourceMeta{Get,Put}Fn` | Resource Metadata (derived fields + `custom`) |
| GET / PUT / DELETE | `/space/{s}/{c}/{r}/policy` | `ResourcePolicy{Get,Put,Delete}Fn` | the Resource's policy |
| anything else | | `DefaultFn` | `308` for the bare Space URL, `501` for optional sections not implemented (`linkset`, `quotas`, `backends`, `replicas`, `chunks`), `405` for an undefined method at a reserved endpoint, else `404` |

**Trailing slashes.** The gateway matches `/space/{s}/` to the
`/space/{space_id}/{collection_id}` route with an empty `collection_id`,
and `/space/{s}/{c}/` to the `{resource_id}` route with an empty
`resource_id`. So the Space container's three operations live on the
`{collection_id}` route, and `ResourceGetFn` / `ResourceDeleteFn` serve the
Collection container when the final segment is empty. Each such function
has that one branch and nothing else.

### Discovery

Every response carries `Link: <{base}/service>; rel="service"`. The document
at `/service` (and, for clients that follow the link from the root, at `/`)
lists the one specification version served (`0.5`), the Spaces Repository
URL, and the feature tokens, with entries for the authorization profile, the
Encrypted Collections profile and the client-annex clause (`version` alone:
a conformance claim a wallet checks at signup, see
[The client-annex clause](#the-client-annex-clause)). A v0.5 client reads it
before its first signed request and refuses a server without it; a client
built on a base server URL (pws-client 0.105+, FreeWallet) reads
`{base}/service` directly, which is why the description lives there.

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
also the bucket name) unless the body names one: a wallet built on
wallet-core mints its account Space's id before genesis (43 URL-safe
characters), redeems the coupon here with that `id`, and genesis then finds
the Space in place, since its provisioning step is an ensure. A client id
must be a valid id form, not reserved, and not in use (`409 id-conflict`);
its bucket is `bucketOf(id)`. Either way the server creates the bucket with
`meta/space.json`, registers the Space, and answers `201` with `Location`
and the metadata. Mint coupons directly:

```sh
aws dynamodb put-item --table-name was-coupons --item \
  '{"coupon":{"S":"<secret>"},"usesRemaining":{"N":"5"},"expiresAt":{"S":"2027-01-01T00:00:00Z"}}'
```

**GET /spaces/** lists the Spaces registered to the DID that signed the
request (the registry's `by-did` index), paged. An unsigned or unverifiable
caller gets an empty list, never an error.

### Export and import

`POST /space/{s}/export` answers the Space as a Space archive, the tar
layout of the specification's Export Space operation (currently its PR 92,
"Specify Export and Import and the Space Archive Format"), and
`POST /space/{s}/import` merges such an archive into an existing Space. Both
are advertised by the `export` feature token and need a capability on the
Space, its root or a delegated one allowing `POST`; an unsigned export is a
`404` like any read. The `@interop/space-archive` codec, the reference
implementation's, writes and reads the layout, so the file names and
`manifest.yml` are its own; each function bundles it (`src/endpoints/space/{export,import}/package.json`).

An archive holds the Space Metadata object and policy, and each Collection's
metadata, policy, Resources (content as stored, so encrypted collections stay
encrypted, with a metadata sidecar each) and Resource policies, plus this
server's service description as `service.json`. What this server does not keep
is absent: no tombstones, chunks, revocation records or provenance
statements; a Collection's governing history log travels as its own file. An unchanged Space exports byte-identical archives.

Import adds what the Space lacks and skips what it holds, so a second import
of the same archive changes nothing: the Space's `name` is restored under the
root capability only (and mirrored to the registry), `type` must match or the
import is refused with `invalid-import` before anything is written, policies
are written only where none exist, a Collection the Space already holds keeps
its metadata while its missing Resources are still imported, and an archived
Collection naming a backend is `unsupported-backend`. The report counts
created and skipped Collections, Resources and policies, says whether the
Space Metadata was `restored` or `skipped`, and lists every attested object as
`unattested`, since no provenance is verified yet.

The archive is built in memory and returned as one response. API Gateway
carries at most 6 MB after base64 encoding, so an archive over 4 MB is refused
with `413 payload-too-large`; larger Spaces will need a presigned-URL
hand-off.

### Provisioning a Space by id

Besides `POST /spaces/` (a coupon, a server-assigned id) and the unlock
Spaces (an id derived from the signing did:key), the stack can let any
did:key create a Space by id: `PUT /space/{id}/meta` with
`If-None-Match: *` and a body naming the key as `controller`, which is how
the reference client (pws-client, wallet-core, FreeWallet) creates an
account Space. It is off by default; the `OpenProvisioning` parameter
(`"true"`) turns it on, and `MaxSpacesPerController` (default 20) caps how
many Spaces one key may create that way (507 `quota-exceeded` past it).
The id `server` is reserved. The authorizer verifies such a request as a
root invocation of the signer, and the handler requires the stated
controller to be that signer. Both of these coupon-less creations, the
unlock Spaces and open provisioning, count against the cap below.

### The cap on Spaces created without a coupon

**Standing note (2026-11-11).** The unlock Space path is open: any holder
of a did:key can create an unlock Space, and so an S3 bucket, with no
coupon and no account, because an unlock Space is created before the
account it will point at is known to the server. FreeWallet depends on it
(binding a passphrase or passkey creates one), so it stays open while
FreeWallet clients join accounts on this server. Our own wallet creates
every Space it needs, unlock Spaces included, through `POST /spaces/` with
the coupon (a client-chosen `id`, see above), so it is not subject to the
cap. When FreeWallet no longer needs the path, close it by deploying with
`MaxCouponlessSpaces=0`.

What bounds it:

- `MaxCouponlessSpaces` (default 200) caps how many Spaces created without
  a coupon may exist. A counter row in the registry table
  (`urn:was-server-aws:couponless-spaces`) is reserved with a conditional
  increment before such a bucket is created and released when such a Space
  is deleted; past the cap the creation is `507 quota-exceeded`. Each
  registry row records `provisioning` (`coupon`, `derived`, `open`).
- `QuotaWatchFn` runs hourly (and by hand: `aws lambda invoke
  --function-name <stack>-QuotaWatchFn-... --payload '{}' out.json`),
  publishing `WasServer/CouponlessSpaces` and `WasServer/SpaceBuckets`.
  The alarms `was-server-couponless-spaces` (threshold
  `CouponlessAlarmThreshold`, default 160) and `was-server-space-buckets`
  (`SpaceBucketsAlarmThreshold`, default 300) notify the SNS topic
  `was-server-quota-alerts`; deploy with `AlertEmail=<address>` to
  subscribe an address (confirm the subscription email). Check them with
  `aws cloudwatch describe-alarms --alarm-name-prefix was-server`.
- A whole-registry feed sweep (`FeedSweepFn` with `{}`) recounts the
  counter from the rows and backfills `provisioning` on rows from before
  the attribute existed (read by their id form until then). Run it once
  after deploying this.

### Self-hosted did:webvh

A did:webvh whose location names this server's own host and a Collection,
`did:webvh:{scid}:{ApiDomain}:space:{space_id}:{collection_id}` (a port as
`%3A`), resolves from that Collection's `did.jsonl` in the bucket, as the
identity-domain form does from `id`. This is the form the reference client
mints for an account (`...:space:{id}:id`) and for a client-annex
generation (`...:space:{annex}:gen-...`).

### Governing history logs

A Collection's `encryption` descriptor can be governed by a client-written,
append-only history log at `/space/{s}/{c}/meta/log` (PWS v0.5, Collection
Governing History Log; the log format is PWS-EC's resource log profile).
This is how the reference client and FreeWallet provision an encrypted
Collection: the container is created bare, then a guarded `PUT` of the
log's genesis entry (`If-None-Match: *`) declares the Collection governed
and installs its first key epoch. From then on the served `encryption`
member is derived from the log's head entry, its `state` less the
`revisions` slot, with `history` (`method`, the log's URL) stamped on, and
`revisions` is served from the slot. The stored metadata object never holds
the derived members; a `PUT` of the metadata that restates the served
descriptor passes, one that changes it is `encryption-history-log-governed`
(409), and declaring governance on a Collection whose metadata already
holds a client-written descriptor is `encryption-immutable` (409).

An append sends the stored log verbatim plus exactly one new line under
`If-Match`. The server checks the line contract (JSON objects with an
object `state`), that the body fast-forwards the stored log (a stale or
rewritten body is 412, zero or several new lines 400), the head state's
shape and, against the prior head, the epoch invariants: `epochs` is
append-only, `currentEpoch` never moves backwards, the blinding key is
permanent, `scheme` and `version` are set-once (`epochs.mjs`). It verifies
nothing inside an entry: proofs and hash links are the verifying reader's
business. A log write also rewrites the metadata object's `updatedAt`, so
the metadata ETag advances with the derived member. The log is stored as
`meta/{c}.log`, versioned by its own ETag, excluded from listings, deleted
with its Collection, and carried by export and import as its own archive
file. The same shape and invariant checks apply to a descriptor written
directly on the metadata object (the `encryption` feature token).

The service description advertises `governed-history-logs` under the
PWS-EC entry (`https://w3id.org/pws/encrypted-collections`), lists the
authorization profile entry, and names the core feature tokens as the
specification's conformance table spells them (`listing`,
`collection-management`, `space-management`, `metadata`, `policy`,
`export`, `encryption`).

### The changes feed

`POST /space/{s}/{c}/query` with `{"profile": "changes", "checkpoint"?,
"limit"?}` (or the `GET` form with the same parameters in the query string,
for a read-only capability) answers the Collection's replication feed (PWS
v0.5, Query Profile Registry): `{"documents": [...], "checkpoint"}`, one
entry per record at the position of its latest write, in position order.
A `resource` entry carries the Resource's live state (`contentType`,
`etag` as a read answers it, `data` for a JSON Resource, `custom` and
`metaEtag` when metadata was written, `createdBy`, `epoch`, `writerId`);
a deleted Resource or policy is a tombstone (`deleted: true`, no `data`);
`collection-metadata`, `log` and `policy` entries carry the sub-resource's
URL and validator. Every entry carries the opaque checkpoint that resumes
after it, the page's `checkpoint` is the last entry's, and `null` means the
end. A checkpoint not issued for this Collection (or from before the
Collection was deleted and re-created) is refused with
`invalid-request-body` at `#/checkpoint`, and the client starts over. Any
other profile is `unsupported-operation` (501). A query needs read
authorization: a capability covering the Collection, or a `PublicCanRead`
policy. Advertised as `changes-query`; the core entry also carries the
store's `originId` (`ORIGIN_ID`, default `dcc-was-sandbox`).

S3 stays the system of record. The feed is a DynamoDB projection
(`was-feed`: one row per record, keyed by bucket and
`{collection}#{kind}#{record}`, with a per-Collection counter row and a
`by-position` index) kept by a pipeline the buckets' object events drive:
every Space bucket publishes to EventBridge, a rule routes the `dcc-was-*`
events to a FIFO queue in one message group, and `FeedConsumerFn`
(`src/feed/consumer`) applies them in order, taking the next position from
the counter and writing the record's row (a stale event by S3 sequencer, or
one that changes nothing, is skipped; the delete of a Collection's metadata
object drops its feed). A query hydrates each row from the object's live
state, so the entry is what a read answers at that moment, a few seconds
after the write. `FeedSweepFn` (`src/feed/sweep`) compares a bucket's
objects with its rows and queues an event for every record the feed lacks
or has wrong, and enables event publishing on a bucket created before the
feed existed:

```bash
aws lambda invoke --function-name <stack>-FeedSweepFn-... --payload '{}' /dev/stdout
```

Run it once after the first deploy, for the Spaces that predate the feed.
(`was-lib/feed.mjs` holds the whole of it; the `blinded-index` profile is
not served.)

### did:webvh controllers

A Space's controller may be a `did:webvh` as well as a `did:key`. The
authorizer resolves the DID's log (`did.jsonl`) to the account document as
it stands now and authorizes against it: a request signed with a key id of
the form `<did:webvh>#<multibase>` verifies only if that method is listed
under `capabilityInvocation` (or `capabilityDelegation`, for a delegation's
proof) in the current document, whose `controller` is then the invoker the
root capability is checked against. Revoking a key is one log entry. The
resolved document is cached for `WEBVH_CACHE_SECONDS` (default 30), which
is the window a revoked key keeps working.

Where a log comes from (`was-lib/webvh.mjs`): a DID whose domain is the
deployment's `IdDomain` parameter (default `id.lcw-sandbox.org`) and whose
single path segment is a Space id names the log published in that Space's
`id` collection (`collections/id/did.jsonl`), read from the bucket, so a
freshly published log is seen at once and no public-read policy is
involved. Any other `did:webvh` is fetched over HTTPS from the location the
DID encodes, with a timeout (`WEBVH_FETCH_TIMEOUT_MS`, 3000) and a size cap
(`WEBVH_MAX_LOG_BYTES`, 1 MiB). One verifier, two fetchers.

The identity domain itself is a CloudFront distribution the stack creates
(`IdDistribution`, aliased to `IdDomain` under `IdCertificateArn`, with
alias records in `HostedZoneId`): a CloudFront Function rewrites
`/{spaceId}/did.jsonl` and `/{spaceId}/did.json` onto
`/space/{spaceId}/id/...` on the API (`ApiDomain`), and everything else
answers 404. Caching is disabled, so a resolver always sees the log as it
stands. The `id` collection has to be world-readable (`PublicCanRead`) for
the distribution's unsigned fetch to succeed; the wallet sets that policy
when it publishes the log. A DID therefore names the identity domain, not
the storage host, and if a Space moves the distribution's origin (or a
redirect at the identity domain) follows it.

Two operations exist for a wallet to move an account onto a `did:webvh`
(the FreeWallet model):

- **Promotion.** `PUT /space/{s}/meta` with a `did:webvh` as `controller`,
  on a Space whose controller is a `did:key`, is accepted when the DID's
  current document lists the invoking key under `capabilityInvocation` or
  `capabilityDelegation` (wallet-core's genesis hands the account's Spaces
  over with its bootstrap key, which the document lists for delegation
  only, before any invocation key exists); the registry row follows. From
  then on only keys in that document invoke. A key the document does not
  name cannot file a Space under the DID. Any other controller change is
  refused (`controller-mismatch`).
- **Unlock Spaces.** `PUT /space/{id}/meta` on a Space the registry does not
  hold provisions it, without a coupon, when `id` is was-client's
  `deriveSpaceId` over the signing `did:key` (the unpadded base64url of its
  SHA-256), the body names that `did:key` as `controller`, and its `type`
  carries `UnlockSpace`. The id is bound to the key, so nothing else can be
  claimed. Such an id is not a valid bucket name, so `bucketOf` in
  `store.mjs` maps it to `dcc-was-` plus 40 hex characters of its SHA-256;
  server-assigned ids are their own bucket names.

### Revoking a capability

`POST /space/{s}/zcaps/revocations/{id}` revokes a delegated capability
rooted in the Space: the body is the capability itself, proof and chain
included, and `{id}` is its id. This is the reference stack's Space-scoped
revocation endpoint (the authorization profile has not specified one yet),
as `@interop/pws-client`'s `revoke()` submits it. The record is one object
per revoked capability under `revocations/` in the Space's bucket, keyed by
the digest of its delegator and its id, kept until a day after the
capability's own `expires` and deleted with the Space.

Who may submit it is the dual-root rule. The invocation may root in the
Space, whose controller may revoke anything delegated from it, or in the
revocation URL itself, whose root capability the function synthesizes as
controlled by every controller in the submitted capability's chain (the
Space controller included), so a delegee revokes its own grant without
holding a separate capability. The chain in the body is verified first,
structurally and by its delegation proofs, to learn those controllers; the
invocation is then verified against them; only after that is a refusal of
the body reported (`400 invalid-request-body`: a root capability, an id
other than the URL's, a chain that does not verify or is rooted outside the
Space), so a submitter outside the chain learns nothing but the masked
`404`. A capability already revoked, or whose chain holds a revoked link, is
`400 capability-already-revoked`; two submissions that race are `409`.
Success is `204`.

From then on every invocation that embeds a delegation chain is checked
against the records by the authorizer's chain inspector (`src/authorizer/revocations.mjs`):
a chain holding a revoked capability at any depth no longer verifies. The
holder of the invoked capability is answered `404 capability-revoked` (and
a chain with an expired link `404 capability-expired`), the named problems
pws-client reports as such; anyone else is answered the plain `404`, as the
reference server does.

### The client-annex clause

The service description claims `https://w3id.org/pws/client-annex` at
version `0.1`, which a wallet built on wallet-core checks before it signs
an account up on a server: the claim that the server enforces the reference
server's bound on what a *ladder* verification method may delegate
(`src/authorizer/annex.mjs`, a port of web-spaces-server's
`lib/clientAnnexClause.ts` and `docs/client-annex-clause.md`).

A ladder VM is the credential-derived method a wallet publishes on its
`did:webvh` account document under `capabilityDelegation` but not
`capabilityInvocation`: it signs delegations and never invokes. A
delegation it signs is admitted in seven shapes only -- the Space items
subtree to the annex DID the account document's `DelegatedClients` service
entry names, with actions from the closed PWS verb vocabulary (the
generation delegation); a `PUT`-only grant of the account's own history log
(the bridge) or a `GET`/`PUT`/`POST` grant of a Space typed
`AuxiliarySpace` + `DelegatedClientsSpace`; a target-exact `DELETE`-only
grant of a Space; a target-exact `GET`-only grant of a Space Metadata object
or of one Resource; a target-exact `POST`-only grant over a management
capability the Space's controller delegated to the account; a `GET`/`HEAD`
pull of the account or annex Space by a replica server the annex document
points at; and a maintenance grant on a Space's replicas route, which holds
on a replica server only and so never here. Two invocation-time bounds
follow: a chain carrying a ladder-signed link never performs
`PUT /space/{s}/meta`, and performs `DELETE /space/{s}/` only when every
ladder-signed link is itself that target-exact `DELETE`-only grant; a chain
carrying a link signed by a *transient annex VM* (a per-visit method under
the two capability relationships and nothing else) never deletes a Space
either. Only DIDs whose log this server hosts are judged; a delegation
signed by any other key passes untouched, as does a chain with no
`did:webvh` link at all. A refusal is the masked `404`.

The clause is applied by the authorizer on every verification and by the
revocation endpoint on its own (without the invocation-time bounds, which
have no operation to bound there). The container rule keeps Delete Space
and Update Space Metadata root-only regardless, so the bounds are defense
in depth here.

### Status codes, validators, errors

- Create: `201` with `Location` and `ETag`. Update: `204` (content) or `200`
  with the stored object (metadata, policies). Delete: `204`. A resource read
  carries `ETag` and `Last-Modified`; `If-None-Match` answers `304`. Every
  GET and HEAD answer carries `Cache-Control: no-cache` (the service
  description, which sets a short `max-age` of its own, is the exception),
  so a browser revalidates a cached read instead of applying heuristic
  freshness to a document that may have been rewritten since.
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
  `@interop` verification stack) runs on every route except `/`, `$default`
  and the revocation endpoint (which verifies its own invocation, see
  [Revoking a capability](#revoking-a-capability)). For a Space URL it reads
  the Space's controller DID from the registry row for `{base}/space/{s}`
  and verifies the invocation against it (every `urn:zcap:root:...`
  resolves to a root capability controlled by that DID; a delegation chain
  may start from the invoked URL, the Collection or the Space container, and
  each delegation's proof may be `Ed25519Signature2020` or `eddsa-jcs-2022`,
  the suite `@interop/was-client` and wallet-core clients sign with). For
  `/spaces/` it verifies against the DID that signed. The URL is checked as
  delivered and, when ids were percent-encoded, re-encoded — API Gateway
  hands the path decoded. A verified delegation chain then passes the chain
  inspectors: the Space's revocation records and the client-annex clause.
  It **never denies**: it answers `isAuthorized: true` with the result in
  the context (`signed`, `verified`, `controller`, `delegated`, `denial`,
  `spaceController`, `spaceType`, or `space=missing`).
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
  anything else is `404`, except a listing (`200`, no items), an unsigned
  write (`401 missing-authorization`), and the holder of a revoked or
  expired grant (`404 capability-revoked` / `capability-expired`).

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
├── revocations/
│   └── {digest}.json             a revoked delegated capability (digest of delegator + id)
└── collections/
    └── {collection_id}/
        └── {resource_id}         Resource content
```

The registry (`was-spaces`, the `WasSpacesTable` of this stack) has one row
per Space: `spaceURL` (no trailing slash), `did`, `type` (a list), `name`,
`CreatedAt`, with a `by-did` index for the listing. The authorizer reads it
on every request and the Space functions write it. lcw-back-end's
registration and login still use it by name, an interim that stage 3 of the
did:webvh work removes.

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
src/authorizer/      the verification stack (bundled): app.mjs the gateway authorizer,
│                    zcap.mjs verification, chain.mjs + revocations.mjs + annex.mjs the
│                    chain inspectors, revoke.mjs the revocation endpoint
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
and paged listings, and DynamoDB's refusal of a bare reserved word in an
expression). Every request is signed by
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

- **No replay protection.** A captured signed request can be replayed until
  its `expires` passes.
- **Unlock Spaces are created without a coupon** by any key holder, bounded
  only by `MaxCouponlessSpaces` (see the cap section above). Close the path
  with `MaxCouponlessSpaces=0` once FreeWallet no longer needs it.
- **`expectedHost` is the request's own `Host` header**, so it constrains
  nothing by itself; the registry lookup keyed by host is what prevents a
  spoofed host from widening access.
- **Collection and Space listings are read whole** before paging; fine for
  the number of collections a wallet holds, not for thousands.
- **Resource listings `HEAD` each object** for its content type and stamps.
- **Export is bounded by the gateway's response size** (4 MB of archive);
  no provenance is signed or verified.
- **Revocation records are not part of the Space archive**: an export
  carries no `revocations/` entries and an import installs none, where the
  reference server archives them under `.revocations/`.
- **The container rule has no exceptions**: the reference server lets a
  delegated chain whose tail is a target-exact `DELETE`-only grant delete a
  Space, and a Space-subtree grant write a Collection's history log; here
  `DELETE /space/{s}/` stays root-only, and `PUT .../meta/log` takes any
  chain that covers the URL.
- Optional profiles not implemented: chunked resources, quotas, backends,
  linksets, the `blinded-index` query profile.

## Resources

- [WAS specification](https://w3c-ccg.github.io/wallet-attached-storage-spec/)
- [@interop/was-client](https://github.com/interop-alliance/was-client)
- [AWS SAM developer guide](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/what-is-sam.html)
