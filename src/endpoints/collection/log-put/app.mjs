import { handler } from "was-lib/handler.mjs";
import { noContent, preconditions, NO_STORE } from "was-lib/http.mjs";
import { KEYS, getJson } from "was-lib/store.mjs";
import { hasContent } from "was-lib/meta.mjs";
import {
  parseLog,
  readCollectionLog,
  checkHeadState,
  assertFastForward,
  writeCollectionLog,
  touchCollectionMeta,
} from "was-lib/history.mjs";
import { encryptionImmutable, invalidRequestBody, notFound, preconditionFailed } from "was-lib/problems.mjs";

// PUT /space/{s}/{c}/meta/log -- the whole log as text/jsonl. With
// If-None-Match: * it creates the log and so declares the Collection
// governed; with If-Match it appends: the stored lines verbatim plus exactly
// one new line. The line contract and the head state's shape are checked
// on every write, the transition invariants on an append; nothing inside an
// entry (proofs, hash links) is verified here. The write never creates the
// Collection. Answers 204 with the log's new ETag.
export const lambdaHandler = handler(
  async (req, { spaceId, collectionId }) => {
    if (req.body === null) {
      throw invalidRequestBody("The log body is empty.");
    }
    const stored = await getJson(spaceId, KEYS.collectionMeta(collectionId));
    if (stored === null && !(await hasContent(spaceId, collectionId))) {
      throw notFound();
    }
    const { ifMatch, ifNoneMatch } = preconditions(req);
    if (ifMatch === undefined && ifNoneMatch === undefined) {
      throw invalidRequestBody("A log write carries If-Match (an append) or If-None-Match: * (the declaring create).");
    }
    const { lines, entries } = parseLog(req.body);
    const current = await readCollectionLog(spaceId, collectionId);

    let written;
    if (ifNoneMatch !== undefined) {
      if (current !== null) {
        throw preconditionFailed("The Collection already carries a log.");
      }
      if (stored?.doc?.encryption !== undefined) {
        throw encryptionImmutable(
          "The Collection's metadata object already holds a client-written encryption descriptor; a Collection is provisioned in one form or the other."
        );
      }
      checkHeadState(entries, null);
      written = await writeCollectionLog(spaceId, collectionId, lines, { ifNoneMatch: "*" });
    } else {
      if (current === null) {
        throw notFound();
      }
      if (ifMatch !== current.etag) {
        throw preconditionFailed("The log changed since it was read.");
      }
      assertFastForward(current.lines, lines);
      checkHeadState(entries, current.entries);
      written = await writeCollectionLog(spaceId, collectionId, lines, { ifMatch: current.etag });
    }
    await touchCollectionMeta(spaceId, collectionId);
    return noContent(req, { ...NO_STORE, ETag: written.etag });
  },
  { scope: "collection-log" }
);
