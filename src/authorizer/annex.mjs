import * as webvhDriver from "@interop/did-method-webvh";
import { getJson, KEYS } from "was-lib/store.mjs";
import { isWebvhDid, locationOf, logSource, relationIds, resolveWebvhDocument, LOG_RESOURCE } from "was-lib/webvh.mjs";
import { RESERVED_COLLECTION_IDS, RESERVED_RESOURCE_IDS, encodeSegment } from "was-lib/ids.mjs";
import {
  actionsExactly,
  actionsWithin,
  asList,
  capabilityControllers,
  delegationVerificationMethod,
  didOfMethodId,
} from "./chain.mjs";

// The client-annex clause: the reference server's bound on what a "ladder"
// verification method may delegate, enforced here as a chain inspector so
// that this server can claim the `https://w3id.org/pws/client-annex` 0.1
// profile a wallet checks at signup.
//
// A ladder VM is the stable, credential-derived method a wallet publishes
// on a did:webvh account document under `capabilityDelegation` but not
// `capabilityInvocation`. It can sign delegations but never invoke, and the
// clause admits a delegation it signs in exactly seven shapes (the
// predicates below), then bounds two invocations a chain carrying such a
// link may not make: a `PUT` of a Space's Metadata object (the controller
// rewrite) and, unless every ladder-signed link is itself a target-exact
// DELETE-only grant, a `DELETE` of the Space. A second signer, the
// transient annex VM a wallet publishes per visit (`capabilityInvocation`
// and `capabilityDelegation`, nothing else), may never end a Space either.
// Only DIDs whose log this server hosts are judged: a delegation signed by
// any other key passes untouched.
//
// Source: web-spaces-server docs/client-annex-clause.md and
// lib/clientAnnexClause.ts (0.45).

const DELEGATED_CLIENTS_SERVICE_TYPE = "https://w3id.org/byoe#DelegatedClients";
const REPLICA_SERVER_SERVICE_TYPE = "https://w3id.org/pws#ReplicaServer";
const WAS_ACTIONS = ["GET", "HEAD", "POST", "PUT", "DELETE"];
const META_SEGMENT = "meta";
const ID_PATTERN = /^[A-Za-z0-9._~-]+$/;

const isUrlSafeSegment = (id) => typeof id === "string" && id.length > 0 && id !== "." && id !== ".." && ID_PATTERN.test(id);

// The canonical URLs the shapes are compared against, built from this
// server's base URL exactly as the endpoints build them.
const spaceUrlOf = (serverUrl, spaceId) => `${serverUrl}/space/${encodeSegment(spaceId)}/`;
const spaceMetaUrlOf = (serverUrl, spaceId) => `${spaceUrlOf(serverUrl, spaceId)}${META_SEGMENT}`;
const replicasUrlOf = (serverUrl, spaceId) => `${spaceUrlOf(serverUrl, spaceId)}replicas`;
const resourceUrlOf = (serverUrl, spaceId, collectionId, resourceId) =>
  `${spaceUrlOf(serverUrl, spaceId)}${encodeSegment(collectionId)}/${encodeSegment(resourceId)}`;

// The path segments of a clean URL on this server (same origin, no query,
// no fragment), or undefined.
function localPathSegments(target, serverUrl) {
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return undefined;
  }
  if (parsed.origin !== new URL(serverUrl).origin || parsed.search !== "" || parsed.hash !== "") {
    return undefined;
  }
  return parsed.pathname.split("/");
}

// Where a did:webvh's log is stored here (the Space and Collection the DID
// names, in either self-hosted form), or undefined for a DID this server
// does not host. This server replicates nothing, so a hosted log is always
// the DID's own.
export function locateLog(did) {
  let source;
  try {
    source = logSource(did);
  } catch {
    return undefined;
  }
  if (source.spaceId === undefined) {
    return undefined;
  }
  return { spaceId: source.spaceId, collectionId: source.collectionId, selfHosted: true };
}

// A server identity: a did:webvh on any host whose path is space:server:id.
export function isServerIdentityDid(did) {
  if (!isWebvhDid(did)) {
    return false;
  }
  try {
    const { paths } = locationOf(did);
    return paths.length === 3 && paths[0] === "space" && paths[1] === "server" && paths[2] === "id";
  } catch {
    return false;
  }
}

// Which signer a delegation proof's method is, read off the signer's own
// document: a ladder VM (delegation without invocation), a transient annex
// VM (the two capability relations and no other), or anything else.
export function signerKindOf(doc, verificationMethod) {
  const listed = (relation) => relationIds(doc, relation).includes(verificationMethod);
  if (!listed("capabilityDelegation")) {
    return "other";
  }
  if (!listed("capabilityInvocation")) {
    return "ladder";
  }
  return !listed("authentication") && !listed("assertionMethod") && !listed("keyAgreement") ? "transient" : "other";
}

// The annex DID an account document names: the endpoint of its
// DelegatedClients service entry (a bare DID string).
export function clientAnnexDidOf(doc) {
  for (const entry of asList(doc?.service)) {
    if (asList(entry?.type).includes(DELEGATED_CLIENTS_SERVICE_TYPE) && typeof entry.serviceEndpoint === "string") {
      return entry.serviceEndpoint;
    }
  }
  return undefined;
}

const hasReplicaPointer = (doc, did) =>
  asList(doc?.service).some((entry) => asList(entry?.type).includes(REPLICA_SERVER_SERVICE_TYPE) && entry.serviceEndpoint === did);

// The Space id when a target is one canonical shape under /space/{S}/,
// matched by exact string equality.
function localSpaceTargetId(target, serverUrl, canonical) {
  const segments = localPathSegments(target, serverUrl);
  if (!segments || segments[0] !== "" || segments[1] !== "space") {
    return undefined;
  }
  const spaceId = segments[2];
  if (!isUrlSafeSegment(spaceId)) {
    return undefined;
  }
  const url = canonical(spaceId, segments.slice(3));
  return url !== undefined && target === url ? spaceId : undefined;
}

const spaceUrlTargetId = (target, serverUrl) =>
  localSpaceTargetId(target, serverUrl, (spaceId, tail) => (tail.length === 1 && tail[0] === "" ? spaceUrlOf(serverUrl, spaceId) : undefined));

const spaceMetaUrlTargetId = (target, serverUrl) =>
  localSpaceTargetId(target, serverUrl, (spaceId, tail) =>
    tail.length === 1 && tail[0] === META_SEGMENT ? spaceMetaUrlOf(serverUrl, spaceId) : undefined
  );

const replicasUrlTargetId = (target, serverUrl) =>
  localSpaceTargetId(target, serverUrl, (spaceId, tail) => (tail.length === 1 ? replicasUrlOf(serverUrl, spaceId) : undefined));

// A Resource URL /space/{S}/{C}/{R} with C and R outside the reserved
// registry, so a Metadata object, a policy or a query endpoint is not one.
const resourceUrlTargetSpaceId = (target, serverUrl) =>
  localSpaceTargetId(target, serverUrl, (spaceId, tail) => {
    if (tail.length !== 2) {
      return undefined;
    }
    const [collectionId, resourceId] = tail;
    if (
      !isUrlSafeSegment(collectionId) ||
      !isUrlSafeSegment(resourceId) ||
      RESERVED_COLLECTION_IDS.has(collectionId) ||
      RESERVED_RESOURCE_IDS.has(resourceId)
    ) {
      return undefined;
    }
    return resourceUrlOf(serverUrl, spaceId, collectionId, resourceId);
  });

// Whether a target lies in one Space's items subtree: /space/{S}/ or any
// path under it except the Metadata URL and anything under it.
function isWithinSpaceItemsSubtree(target, spaceId, serverUrl) {
  const segments = localPathSegments(target, serverUrl);
  return (
    segments !== undefined &&
    segments.length >= 4 &&
    segments[0] === "" &&
    segments[1] === "space" &&
    segments[2] === spaceId &&
    segments[3] !== META_SEGMENT
  );
}

const isOwnAccountLogTarget = (target, logLocation, serverUrl) =>
  target === resourceUrlOf(serverUrl, logLocation.spaceId, logLocation.collectionId, LOG_RESOURCE);

async function readSpaceMetadata(spaceId) {
  try {
    const stored = await getJson(spaceId, KEYS.spaceMeta());
    return stored?.doc;
  } catch (err) {
    if (err?.status === 404) {
      return undefined;
    }
    throw err;
  }
}

const typesOf = (meta) => asList(meta?.type);
const isDelegatedClientsSpace = (meta) => typesOf(meta).includes("AuxiliarySpace") && typesOf(meta).includes("DelegatedClientsSpace");

const resolveDocument = (did, options = {}) => resolveWebvhDocument(did, { driver: webvhDriver, ...options });

// Predicate 6: a replica pull by a server the annex document points at.
async function replicaPullAdmitted({ capability, controllers, clientAnnexDid, spaceId, accountSpaceId, parentIsRoot, serverUrl }) {
  const [replicaDid] = controllers;
  if (
    spaceId === undefined ||
    !parentIsRoot ||
    !actionsWithin(capability, ["GET", "HEAD"]) ||
    controllers.length !== 1 ||
    !isServerIdentityDid(replicaDid) ||
    clientAnnexDid === undefined
  ) {
    return false;
  }
  // The annex document is read from this server's own storage only
  const annexLog = locateLog(clientAnnexDid);
  if (annexLog === undefined || (spaceId !== accountSpaceId && annexLog.spaceId !== spaceId)) {
    return false;
  }
  const annexDoc = await resolveDocument(clientAnnexDid);
  return annexDoc !== null && hasReplicaPointer(annexDoc, replicaDid);
}

// Judges one ladder-signed delegation against the seven admission
// predicates. `doc` is the delegator's (resolved) account document,
// `logLocation` where its log is stored, `parent` the link it hangs from.
export async function ladderDelegationAdmitted({ capability, doc, logLocation, parent, parentMeta, parentIsRoot, serverUrl }) {
  const target = capability.invocationTarget;
  if (typeof target !== "string") {
    return false;
  }
  const controllers = capabilityControllers(capability);
  const clientAnnexDid = clientAnnexDidOf(doc);

  // 1. The Space items subtree, to the annex DID the account document names,
  // with actions drawn from the closed PWS verb vocabulary (the generation
  // delegation).
  if (
    controllers.length === 1 &&
    clientAnnexDid !== undefined &&
    controllers[0] === clientAnnexDid &&
    isWithinSpaceItemsSubtree(target, logLocation.spaceId, serverUrl) &&
    actionsWithin(capability, WAS_ACTIONS) &&
    locateLog(clientAnnexDid) !== undefined
  ) {
    return true;
  }

  // 2a. The delegator's own history log, PUT only (the bridge).
  if (isOwnAccountLogTarget(target, logLocation, serverUrl) && actionsWithin(capability, ["PUT"])) {
    return true;
  }

  // 2b. A whole Space declared delegated-clients bookkeeping.
  const spaceId = spaceUrlTargetId(target, serverUrl);
  if (spaceId !== undefined && actionsWithin(capability, ["GET", "PUT", "POST"])) {
    if (isDelegatedClientsSpace(await readSpaceMetadata(spaceId))) {
      return true;
    }
  }

  // 6. A replica pull under the annex document's pointer.
  if (
    await replicaPullAdmitted({ capability, controllers, clientAnnexDid, spaceId, accountSpaceId: logLocation.spaceId, parentIsRoot, serverUrl })
  ) {
    return true;
  }

  // 7. A maintenance grant on a Space's replicas route holds on a replica
  // server only, where the delegator's log is a registration's copy. This
  // server hosts every log it stores as the DID's own, so the shape is
  // never admitted here, as on the reference server that hosts the
  // account's log of record.
  const replicasSpaceId = replicasUrlTargetId(target, serverUrl);
  if (
    replicasSpaceId !== undefined &&
    !logLocation.selfHosted &&
    parentIsRoot &&
    parent.invocationTarget === spaceUrlOf(serverUrl, replicasSpaceId) &&
    actionsWithin(capability, WAS_ACTIONS)
  ) {
    return true;
  }

  // 3 (DELETE). A target-exact DELETE-only grant of the parent's own Space.
  if (spaceId !== undefined && parent.invocationTarget === target && actionsExactly(capability, "DELETE")) {
    return true;
  }

  // 5. A target-exact POST-only grant over a delegated management
  // capability: the parent is a delegation to the account itself, made by
  // the Space's own controller.
  if (spaceId !== undefined && !parentIsRoot && parent.invocationTarget === target && actionsExactly(capability, "POST")) {
    const parentControllers = capabilityControllers(parent);
    const parentSignerDid = didOfMethodId(delegationVerificationMethod(parent, parentMeta));
    if (parentControllers.length === 1 && parentControllers[0] === doc.id && parentSignerDid !== "") {
      const meta = await readSpaceMetadata(spaceId);
      if (meta?.controller === parentSignerDid) {
        return true;
      }
    }
  }

  // 3 (GET) and 4. A target-exact GET-only grant of a Space Metadata object
  // or of one Resource, narrowing from the parent's own target or the
  // Space's canonical URL.
  const readSpaceId = spaceMetaUrlTargetId(target, serverUrl) ?? resourceUrlTargetSpaceId(target, serverUrl);
  if (readSpaceId === undefined || typeof parent.invocationTarget !== "string") {
    return false;
  }
  return (
    (parent.invocationTarget === target || parent.invocationTarget === spaceUrlOf(serverUrl, readSpaceId)) &&
    actionsExactly(capability, "GET")
  );
}

// Which of the two bounded operations an invocation is.
export function spaceOperationOf({ target, action }, serverUrl) {
  if (action === "PUT" && spaceMetaUrlTargetId(target, serverUrl) !== undefined) {
    return "put-space-meta";
  }
  if (action === "DELETE" && spaceUrlTargetId(target, serverUrl) !== undefined) {
    return "delete-space";
  }
  return undefined;
}

// The invocation-time bound on a chain carrying ladder-signed links: the
// reason the invoked operation is refused, or undefined. It reads the
// ladder-signed links rather than the chain's tail, since anything below
// such a link can narrow itself into a DELETE-only tail.
export function ladderInvocationRefusal(target, operation, ladderLinks) {
  if (operation === "put-space-meta") {
    return "invoked as PUT on a Space Metadata URL";
  }
  if (operation === "delete-space" && !ladderLinks.every((link) => link.invocationTarget === target && actionsExactly(link, "DELETE"))) {
    return "invoked as DELETE on a Space URL under a chain whose ladder-signed delegation is not a target-exact DELETE-only grant of that Space";
  }
  return undefined;
}

const REFUSED_SHAPE =
  "A capability in the chain is delegated by a delegation-only (ladder) verification method and is none of the admitted shapes: " +
  "it neither names the account document's client-annex DID as sole controller with a target inside the account Space's items " +
  "subtree (its Metadata URL excluded), nor carries a bridge-shaped invocation target, nor is a DELETE-only grant of the parent " +
  "capability's own Space URL, nor a GET-only grant of that Space's Metadata URL or of one Resource in it, nor a POST-only grant " +
  "of that Space URL under a management capability the Space's controller delegated to the account, nor a GET/HEAD pull of the " +
  "account Space or its client-annex Space by a replica server the annex document points at.";

// The chain inspector. `serverUrl` is this server's base URL; `invocation`
// (the operation's canonical target and HTTP method) engages the
// invocation-time bounds, and is left out where there is no operation to
// bound (the revocation route).
export function clientAnnexChainInspector({ serverUrl, invocation }) {
  return async ({ capabilityChain, capabilityChainMeta }) => {
    const docs = new Map();
    // The DIDs re-resolved fresh once in this inspection
    const refreshed = new Set();
    const ladderLinks = [];
    let transientAnnexSigned = false;
    for (let index = 1; index < capabilityChain.length; index++) {
      const capability = capabilityChain[index];
      const verificationMethod = delegationVerificationMethod(capability, capabilityChainMeta[index]);
      if (!isWebvhDid(verificationMethod)) {
        continue;
      }
      const did = didOfMethodId(verificationMethod);
      const logLocation = locateLog(did);
      if (logLocation === undefined) {
        continue;
      }
      // The signature verification that accepted this proof resolved (and
      // cached) the same document
      let doc = docs.get(did);
      if (doc === undefined) {
        doc = await resolveDocument(did);
        if (!doc) {
          continue;
        }
        docs.set(did, doc);
      }
      const signer = signerKindOf(doc, verificationMethod);
      if (signer !== "ladder") {
        transientAnnexSigned ||= signer === "transient";
        continue;
      }
      ladderLinks.push(capability);
      const admittedBy = (document) =>
        ladderDelegationAdmitted({
          capability,
          doc: document,
          logLocation,
          parent: capabilityChain[index - 1],
          parentMeta: capabilityChainMeta[index - 1],
          parentIsRoot: index === 1,
          serverUrl,
        });
      let admitted = await admittedBy(doc);
      if (!admitted && !refreshed.has(did)) {
        // The cached document may be behind the log: a transient recovery
        // re-points the account's client-annex entry to a fresh generation
        // and invokes under that generation in the same second. One fresh
        // resolution before refusing, as zcap.mjs does for a key the cached
        // document does not list.
        refreshed.add(did);
        const current = await resolveDocument(did, { fresh: true });
        if (current) {
          doc = current;
          docs.set(did, current);
          admitted = await admittedBy(current);
        }
      }
      if (!admitted) {
        return { valid: false, error: new Error(REFUSED_SHAPE) };
      }
    }
    if (invocation === undefined) {
      return { valid: true };
    }
    const operation = spaceOperationOf(invocation, serverUrl);
    if (transientAnnexSigned && operation === "delete-space") {
      return {
        valid: false,
        error: new Error(
          "A chain carrying a delegation signed by a transient annex verification method (a per-visit key) is invoked as DELETE on a Space URL: a per-visit key's own delegation never ends an account or its annex."
        ),
      };
    }
    if (ladderLinks.length === 0) {
      return { valid: true };
    }
    const refusal = ladderInvocationRefusal(invocation.target, operation, ladderLinks);
    if (refusal !== undefined) {
      return {
        valid: false,
        error: new Error(
          `A chain carrying a delegation signed by a delegation-only (ladder) verification method is ${refusal}: Update Space Metadata and Delete Space are outside ladder reach.`
        ),
      };
    }
    return { valid: true };
  };
}
