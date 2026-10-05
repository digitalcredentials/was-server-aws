import {
  S3Client,
  GetObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";

const s3 = new S3Client({});

// Keys that live in a collection folder but are not members of the collection:
// the folder marker S3 returns for the prefix itself, and the collection's own
// metadata documents.
const RESERVED_RESOURCE_IDS = new Set([
  "",
  "description.json",
]);

export const lambdaHandler = async (event, context) => {
  const { pathParameters } = event;
  // HTTP API payload v2: the method lives under requestContext.http and the
  // path is rawPath
  const httpMethod = event.requestContext?.http?.method ?? event.httpMethod;
  const path = event.rawPath ?? event.path;

  // The zcap invocation was already verified by the WASZcapAuthorizer; the
  // invoker is on event.requestContext.authorizer.controller.
  if (
    httpMethod === "GET" &&
    pathParameters?.space_id &&
    pathParameters?.collection_id 
  ) {
    const { space_id, collection_id } = pathParameters;
    const collectionPath = `/space/${space_id}/${collection_id}`;
    if (path.endsWith("/")) {
      try {
        const prefix = `collections/${collection_id}/`;
        const command = new ListObjectsV2Command({
          Bucket: space_id,
          Prefix: prefix,
          Delimiter: "/",
        });
        const { Contents } = await s3.send(command);
        const items = (Contents ?? [])
          .map(({ Key }) => Key.slice(prefix.length))
          .filter((resourceId) => !RESERVED_RESOURCE_IDS.has(resourceId))
          .map((resourceId) => ({
            id: resourceId,
            url: `${collectionPath}/${resourceId}`,
            contentType: "application/json",
          }));

        const body = {
          id: collection_id,
          url: collectionPath,
          name: "JSON Documents Collection",
          type: ["Collection"],
          totalItems: items.length,
          items,
        };

        return {
          statusCode: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        };
      } catch (err) {
        if (err.name === "NoSuchBucket") {
          return {
            statusCode: 404,
            body: JSON.stringify({ message: "Not found" }),
          };
        }
        throw err;
      }
    }

    try {
      const command = new GetObjectCommand({
        Bucket: space_id,
        Key: `collections/${collection_id}/description.json`,
      });
      const { Body } = await s3.send(command);
      const content = await Body.transformToString();
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: content,
      };
    } catch (err) {
      if (err.name === "NoSuchBucket") {
        return {
          statusCode: 404,
          body: JSON.stringify({ message: "Not found" }),
        };
      }
      if (err.name !== "NoSuchKey") {
        throw err;
      }
    }

    // No stored description. A collection that exists implicitly (resources
    // were put into it without a configure, e.g. Trash) still has a readable
    // Description: the derived fields are synthesized, the same way the space
    // description GET derives its own. This matters to encryption-capable
    // clients, which fail closed on an unreadable Description rather than
    // assume plaintext. A collection with no resources at all stays 404.
    try {
      const { Contents } = await s3.send(new ListObjectsV2Command({
        Bucket: space_id,
        Prefix: `collections/${collection_id}/`,
        MaxKeys: 1,
      }));
      if ((Contents ?? []).length === 0) {
        return {
          statusCode: 404,
          body: JSON.stringify({ message: "Not found" }),
        };
      }
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: collection_id,
          url: collectionPath,
          type: ["Collection"],
        }),
      };
    } catch (err) {
      if (err.name === "NoSuchBucket") {
        return {
          statusCode: 404,
          body: JSON.stringify({ message: "Not found" }),
        };
      }
      throw err;
    }
  }

  return {
    statusCode: 500,
    body: JSON.stringify({ message: "Server error." }),
  };
};
