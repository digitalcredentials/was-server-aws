// Live conformance check: drives a deployed server through
// @interop/was-client (the version the wallet uses), so what passes here is
// what the wallet can rely on. Creates a scratch Space with a coupon,
// exercises discovery, Space and Collection metadata, encrypted and
// plaintext resources, listings, resource metadata, policies and public
// reads, then deletes the Space.
//
//   WAS_URL=https://was.lcw-sandbox.org COUPON=... node live.mjs
//
// The signing key is derived from a throwaway seed; the Space it creates is
// its own, so nothing else on the server is touched.

import "@interop/http-client";
import { Ed25519VerificationKey } from "@interop/ed25519-verification-key";
import { EddsaJcs2022 } from "@interop/ed25519-signature/eddsa-jcs-2022";
import { ZcapClient } from "@interop/ezcap";
import { WasClient, discoverService } from "@interop/was-client";
import { createEdvEncryption, ensureFirstEpoch, ownerRecipient } from "@interop/was-client/edv";
import { X25519KeyAgreementKey2020 } from "@interop/x25519-key-agreement-key";

const WAS = (process.env.WAS_URL ?? "https://was.lcw-sandbox.org").replace(/\/+$/, "");
const COUPON = process.env.COUPON;
const SEED = process.env.SEED ?? "live-conformance-seed-0000000000";

if (!COUPON) {
  console.error("Set COUPON to a valid space-creation coupon.");
  process.exit(2);
}

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail !== undefined ? ` (${detail})` : ""}`);
  if (!ok) failures++;
};
const expectThrow = async (label, fn, name) => {
  try {
    await fn();
    check(label, false, "no error thrown");
  } catch (err) {
    check(label, name === undefined || err.name === name, `${err.name}: ${err.message.slice(0, 80)}`);
  }
};

const edKey = await Ed25519VerificationKey.generate({ seed: new TextEncoder().encode(SEED.padEnd(32, "x").slice(0, 32)) });
edKey.controller = `did:key:${edKey.fingerprint()}`;
edKey.id = `${edKey.controller}#${edKey.fingerprint()}`;
const exported = await edKey.export({ secretKey: true });
const keyAgreementKey = X25519KeyAgreementKey2020.fromEd25519({
  controller: edKey.controller,
  publicKeyMultibase: exported.publicKeyMultibase,
  privateKeyMultibase: exported.secretKeyMultibase,
});
keyAgreementKey.id ??= `${edKey.controller}#${keyAgreementKey.fingerprint()}`;
const encryption = createEdvEncryption({
  resolveKeys: async () => ({ keyAgreementKey, keyResolver: async () => { throw new Error("unexpected"); } }),
});

// --- discovery ---------------------------------------------------------------
const service = await discoverService({ url: WAS });
check("service discovery selects v0.5", service.version === "0.5");
check("service description names the spaces repository", service.spacesUrl === `${WAS}/spaces/`, service.spacesUrl);

// --- space creation (this server's coupon extension: a raw invocation) -----
const zcapClient = new ZcapClient({ SuiteClass: EddsaJcs2022, invocationSigner: edKey.signer(), delegationSigner: edKey.signer() });
const created = await zcapClient.request({
  url: service.spacesUrl,
  method: "POST",
  action: "POST",
  json: { controller: edKey.controller, name: "live check", type: ["Space"], coupon: COUPON },
});
check("POST /spaces/ answers 201 with Location", created.status === 201 && Boolean(created.headers.get("location")), created.status);
const spaceId = created.data.id;
console.log(`     scratch space ${spaceId}`);

const was = await WasClient.fromSigner({ serverUrl: WAS, signer: edKey.signer(), encryption });
const space = was.space(spaceId);

try {
  // --- space metadata ---------------------------------------------------------
  const desc = await space.describe();
  check("space.describe() reads Space Metadata", desc?.name === "live check" && desc.controller === edKey.controller);
  const renamed = await space.configure({ name: "live check (renamed)" });
  check("space.configure() renames under If-Match", renamed.description.name === "live check (renamed)" && Boolean(renamed.etag));
  const spaces = await was.listSpaces();
  check("listSpaces() includes the scratch space with its type", spaces.items.some((item) => item.id === spaceId && item.type.includes("Space")));

  // --- encrypted collection ----------------------------------------------------
  const vault = await space.createCollection({ id: "vault", name: "Vault", encryption: { scheme: "edv" } });
  await ensureFirstEpoch({ collection: vault, recipients: [ownerRecipient({ keyAgreementKey })] });
  const added = await vault.add({ hello: "world" });
  check("vault.add() mints an id and returns an etag", typeof added.id === "string" && Boolean(added.etag));
  const roundTrip = await vault.get(added.id);
  check("vault.get() decrypts the document", roundTrip?.hello === "world");
  await vault.setName("My private vault");
  const vaultMeta = await vault.meta();
  check("encrypted collection name decodes back", vaultMeta?.custom?.name === "My private vault" && Boolean(vaultMeta.etag));
  const rawMeta = await zcapClient.request({ url: `${WAS}/space/${spaceId}/vault/meta`, method: "GET", action: "GET" });
  check("stored collection custom is an envelope", Boolean(rawMeta.data?.custom?.jwe));
  const listing = await vault.list();
  check("vault.list() lists the document", listing?.items.some((item) => item.id === added.id));
  await expectThrow("vault.setMeta() with a stale If-Match is a 412", () => vault.setMeta({ custom: { name: "x" } }, { ifMatch: '"stale"' }), "PreconditionFailedError");
  await expectThrow("createCollection() with a taken id is a conflict", () => space.createCollection({ id: "vault" }), "ConflictError");
  await expectThrow("createCollection() with a reserved id is refused", () => space.createCollection({ id: "meta" }), "ValidationError");

  // --- plaintext collection, resource metadata, policies -----------------------
  const notes = space.collection("notes", { encryption: "plaintext" });
  const put = await notes.put("note.json", { body: "plain" });
  check("plaintext put() returns an etag", Boolean(put.etag));
  const note = notes.resource("note.json");
  await note.setName("A note");
  const noteMeta = await note.meta();
  check("resource meta round-trips custom.name with derived fields", noteMeta?.custom?.name === "A note" && typeof noteMeta.size === "number");
  const noteRead = await note.getWithEtag();
  check("getWithEtag() returns the content and its validator", noteRead?.data?.body === "plain" && Boolean(noteRead.etag));
  await expectThrow("put() pinned to a stale etag is a 412", () => note.put({ body: "x" }, { ifMatch: '"stale"' }), "PreconditionFailedError");
  const collections = await space.collections();
  check("space.collections() lists both collections", ["notes", "vault"].every((id) => collections?.items.some((item) => item.id === id)));

  check("a private resource is not publicly readable", (await was.publicRead({ resourceUrl: `${WAS}/space/${spaceId}/notes/note.json` })) === null);
  const policy = await note.setPublic();
  check("setPublic() returns an etag", Boolean(policy.etag));
  const publicRead = await was.publicRead({ resourceUrl: `${WAS}/space/${spaceId}/notes/note.json` });
  check("publicRead() serves a PublicCanRead resource", publicRead?.body === "plain");
  await note.clearPolicy();
  check("clearPolicy() closes it again", (await was.publicRead({ resourceUrl: `${WAS}/space/${spaceId}/notes/note.json` })) === null);

  await note.delete();
  check("delete() removes the resource", (await note.get()) === null);
  await notes.delete();
  check("collection.delete() removes the collection", (await notes.describe()) === null);
  check("meta of a missing resource is null", (await notes.resource("absent.json").meta()) === null);
} catch (err) {
  console.error("FAIL with error:", err);
  failures++;
} finally {
  const outcome = await space.deleteWithOutcome().catch((err) => ({ outcome: err.message }));
  check(`scratch space deleted (${outcome.outcome})`, outcome.outcome === "deleted");
}
process.exit(failures ? 1 : 0);
