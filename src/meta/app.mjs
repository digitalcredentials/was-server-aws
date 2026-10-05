import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";

const s3 = new S3Client({});

// The /meta sub-resource at the collection and resource scopes:
//
//   GET /space/:s/:c/meta         the Collection's metadata document
//   PUT /space/:s/:c/meta         replace its user-writable part
//   GET /space/:s/:c/:r/meta      the Resource's metadata document
//   PUT /space/:s/:c/:r/meta      replace its user-writable part
//
// The document carries the user-writable `custom` ({name, tags} — or an
// opaque EDV envelope on an encrypted collection, with its `epoch` beside it)
// plus server-managed fields: createdAt/updatedAt, and for a resource the
// stored representation's contentType and size, derived from the object. The
// metadata has its own version: the stored document's ETag, returned on GET
// and PUT and honored as If-Match / If-None-Match preconditions (412 on
// failure) via S3's own conditional writes, so metadata concurrency is
// independent of the content's ETag.
//
// Stored under the bucket's meta/ prefix (mirroring the path it describes),
// like policies/, so metadata never appears in listings.

const json = (statusCode, body, headers = {}) => ({
  statusCode,
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body),
});

const header = (event, name) =>
  Object.entries(event.headers ?? {}).find(
    ([key]) => key.toLowerCase() === name
  )?.[1];

const metaKey = (collectionId, resourceId) =>
  resourceId
    ? `meta/${collectionId}/${resourceId}.json`
    : `meta/${collectionId}.json`;

// The stored metadata document and its ETag; null when none exists yet.
async function readStored(bucket, key) {
  try {
    const { Body, ETag } = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key })
    );
    return { doc: JSON.parse(await Body.transformToString()), etag: ETag };
  } catch (err) {
    if (err.name === "NoSuchKey") {
      return null;
    }
    throw err;
  }
}

// A collection exists when it has a stored description or any object under
// its prefix (the same implicit-collection rule the description GET applies).
async function collectionExists(bucket, collectionId) {
  const { Contents } = await s3.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: `collections/${collectionId}/`,
      MaxKeys: 1,
    })
  );
  return (Contents ?? []).length > 0;
}

// The stored representation's head, for a resource's derived fields.
async function resourceHead(bucket, collectionId, resourceId) {
  try {
    return await s3.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: `collections/${collectionId}/${resourceId}`,
      })
    );
  } catch (err) {
    if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw err;
  }
}

export const lambdaHandler = async (event, context) => {
  // The zcap invocation was already verified by the WASZcapAuthorizer.
  const method = event.requestContext?.http?.method ?? event.httpMethod;
  const { space_id, collection_id, resource_id } = event.pathParameters ?? {};

  if (!space_id || !collection_id) {
    return json(500, { message: "Server error." });
  }

  try {
    // The subject must exist: metadata describes a thing, it does not create
    // one.
    let head = null;
    if (resource_id) {
      head = await resourceHead(space_id, collection_id, resource_id);
      if (!head) {
        return json(404, { message: "Not found" });
      }
    } else if (!(await collectionExists(space_id, collection_id))) {
      return json(404, { message: "Not found" });
    }

    const key = metaKey(collection_id, resource_id);

    if (method === "GET") {
      const stored = await readStored(space_id, key);
      const derived = resource_id
        ? {
            contentType: head.ContentType ?? "application/json",
            size: head.ContentLength ?? 0,
          }
        : {};
      return json(200, { ...derived, ...(stored?.doc ?? {}) },
        stored?.etag ? { ETag: stored.etag } : {});
    }

    if (method === "PUT") {
      let body;
      try {
        const raw = event.isBase64Encoded
          ? Buffer.from(event.body ?? "", "base64").toString("utf8")
          : event.body ?? "";
        body = raw.trim() === "" ? {} : JSON.parse(raw);
      } catch {
        return json(400, { message: "Request body must be JSON." });
      }
      const { custom, epoch } = body;
      if (custom !== undefined && (typeof custom !== "object" || custom === null)) {
        return json(400, { message: '"custom" must be an object.' });
      }
      if (epoch !== undefined && typeof epoch !== "string") {
        return json(400, { message: '"epoch" must be a string.' });
      }

      // Full replacement of the user-writable part; createdAt survives from
      // the current document.
      const current = await readStored(space_id, key);
      const now = new Date().toISOString();
      const doc = {
        createdAt: current?.doc?.createdAt ?? now,
        updatedAt: now,
        ...(epoch !== undefined && { epoch }),
        ...(custom !== undefined && { custom }),
      };

      const ifMatch = header(event, "if-match");
      const ifNoneMatch = header(event, "if-none-match");
      try {
        const put = await s3.send(
          new PutObjectCommand({
            Bucket: space_id,
            Key: key,
            Body: JSON.stringify(doc),
            ContentType: "application/json",
            ...(ifMatch !== undefined && { IfMatch: ifMatch }),
            ...(ifNoneMatch !== undefined && { IfNoneMatch: ifNoneMatch }),
          })
        );
        return json(200, doc, put.ETag ? { ETag: put.ETag } : {});
      } catch (err) {
        if (
          err.name === "PreconditionFailed" ||
          err.$metadata?.httpStatusCode === 412 ||
          // S3 answers If-None-Match collisions on new objects as 409
          err.$metadata?.httpStatusCode === 409
        ) {
          return json(412, { message: "Precondition failed." });
        }
        throw err;
      }
    }

    return json(405, { message: "Method not allowed." });
  } catch (err) {
    if (err.name === "NoSuchBucket") {
      return json(404, { message: "Not found" });
    }
    console.error("Unhandled error in meta handler:", err);
    return json(500, { message: "Server error." });
  }
};
