import { randomUUID } from "node:crypto";
import {
  S3Client,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

const s3 = new S3Client({});

// Collection ids that collide with the space's own sub-routes.
const RESERVED_COLLECTION_IDS = new Set(["collections", "policy"]);

// One path segment: no separators, no query/fragment characters, no spaces.
const COLLECTION_ID_RE = /^[^/?#\s]{1,128}$/;

const json = (statusCode, body, headers = {}) => ({
  statusCode,
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body),
});

// POST /space/:space_id/ -> creates a collection in the space (the WAS
// create-collection operation): the body carries the writable description
// fields and an optional id; without one the server generates it. Responds
// 201 with the stored description (its `id` is what the client reads back).
//
// Routing note: a deployed HTTP API matches the trailing-slash path to the
// {collection_id} route with an empty final segment (the same quirk the
// resource listings dispatch on), so this handler is registered on both
// POST /space/{space_id} and POST /space/{space_id}/{collection_id} and
// refuses a POST to an actual collection path.
export const lambdaHandler = async (event, context) => {
  // The zcap invocation was already verified by the WASZcapAuthorizer.
  const { pathParameters, body } = event;
  const { space_id, collection_id } = pathParameters ?? {};

  if (!space_id) {
    return json(500, { message: "Server error." });
  }
  // POST belongs on the space root; a collection path takes PUT, not POST.
  if (collection_id) {
    return json(405, { message: "Method not allowed." });
  }

  let description;
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(body ?? "", "base64").toString("utf8")
      : body ?? "";
    description = raw.trim() === "" ? {} : JSON.parse(raw);
  } catch {
    return json(400, { message: "Request body must be JSON." });
  }

  const { id: requestedId, ...fields } = description;
  if (requestedId !== undefined) {
    if (typeof requestedId !== "string" || !COLLECTION_ID_RE.test(requestedId)) {
      return json(400, { message: "Collection id must be a single path segment." });
    }
    if (RESERVED_COLLECTION_IDS.has(requestedId)) {
      return json(400, { message: `Collection id "${requestedId}" is reserved.` });
    }
  }
  const collectionId = requestedId ?? randomUUID();

  // Same type rule as the collection PUT: stamped when absent, must include
  // "Collection" when given.
  if (fields.type === undefined) {
    fields.type = ["Collection"];
  }
  const types = Array.isArray(fields.type) ? fields.type : [fields.type];
  if (!types.includes("Collection")) {
    return json(400, {
      message: 'Collection description "type" must include "Collection".',
    });
  }

  const collectionPath = `/space/${space_id}/${collectionId}`;
  const key = `collections/${collectionId}/description.json`;

  try {
    // Creation is create-only: an existing collection is a conflict, unlike
    // the PUT route's update-or-create.
    try {
      await s3.send(new HeadObjectCommand({ Bucket: space_id, Key: key }));
      return json(409, { message: `Collection "${collectionId}" already exists.` });
    } catch (err) {
      if (err.name !== "NotFound" && err.$metadata?.httpStatusCode !== 404) {
        throw err;
      }
    }

    const stored = {
      ...fields,
      id: collectionId,
      url: collectionPath,
    };

    await s3.send(
      new PutObjectCommand({
        Bucket: space_id,
        Key: key,
        Body: JSON.stringify(stored),
        ContentType: "application/json",
      })
    );

    return json(201, stored, { Location: collectionPath });
  } catch (err) {
    if (err.name === "NoSuchBucket") {
      return json(404, { message: "Not found" });
    }
    console.error("Unhandled error in collection create handler:", err);
    return json(500, { message: "Server error." });
  }
};
