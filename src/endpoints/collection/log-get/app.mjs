import { handler } from "was-lib/handler.mjs";
import { respond } from "was-lib/http.mjs";
import { readCollectionLog, LOG_CONTENT_TYPE } from "was-lib/history.mjs";
import { notFound } from "was-lib/problems.mjs";

// GET, HEAD /space/{s}/{c}/meta/log -- the Collection's governing history
// log, verbatim, as text/jsonl with its own ETag; 304 under If-None-Match.
// Readable under any capability covering the Collection, or where a
// PublicCanRead policy grants reads; a Collection with no log is a 404.
export const lambdaHandler = handler(
  async (req, { spaceId, collectionId }) => {
    const log = await readCollectionLog(spaceId, collectionId);
    if (log === null) {
      throw notFound();
    }
    const ifNoneMatch = req.headers["if-none-match"];
    if (ifNoneMatch !== undefined && ifNoneMatch === log.etag) {
      return respond(req, { status: 304, headers: { ETag: log.etag } });
    }
    return respond(req, {
      status: 200,
      headers: { ETag: log.etag },
      body: Buffer.from(log.text, "utf8"),
      contentType: LOG_CONTENT_TYPE,
    });
  },
  { scope: "collection-log" }
);
