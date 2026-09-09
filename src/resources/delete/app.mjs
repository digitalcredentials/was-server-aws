import {
  S3Client,
  CopyObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

const s3 = new S3Client({});

// The collection's own metadata lives alongside its resources, so it must not
// be deletable through the resource endpoint.
const RESERVED_RESOURCE_IDS = new Set(["description.json"]);

// Deleted resources are moved here rather than removed; deleting a resource
// that is already in the Trash removes it permanently.
const TRASH_COLLECTION = "Trash";

// DELETE /space/:space_id/:collection_id/:resource_id -> moves the resource
// into the space's Trash collection.
export const lambdaHandler = async (event, context) => {
  // The zcap invocation was already verified by the WASZcapAuthorizer; the
  // invoker is on event.requestContext.authorizer.controller.
  const { pathParameters } = event;
  const { space_id, collection_id, resource_id } = pathParameters ?? {};

  if (!space_id || !collection_id || !resource_id) {
    return {
      statusCode: 500,
      body: JSON.stringify({ message: "Server error." }),
    };
  }

  if (RESERVED_RESOURCE_IDS.has(resource_id)) {
    return {
      statusCode: 404,
      body: JSON.stringify({ message: "Not found" }),
    };
  }

  const key = `collections/${collection_id}/${resource_id}`;

  try {
    if (collection_id !== TRASH_COLLECTION) {
      // Soft delete: copy into Trash, then remove the original. A repeat of
      // the same name in Trash is overwritten.
      await s3.send(
        new CopyObjectCommand({
          Bucket: space_id,
          CopySource: encodeURIComponent(`${space_id}/${key}`),
          Key: `collections/${TRASH_COLLECTION}/${resource_id}`,
        })
      );
    }
    await s3.send(new DeleteObjectCommand({ Bucket: space_id, Key: key }));

    // API Gateway defaults the Content-Type to application/json, so the
    // response carries an actual JSON body rather than an empty 204 that
    // clients then fail to parse.
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        collection_id !== TRASH_COLLECTION
          ? {
              deleted: true,
              trash: `/space/${space_id}/${TRASH_COLLECTION}/${resource_id}`,
            }
          : { deleted: true }
      ),
    };
  } catch (err) {
    if (err.name === "NoSuchKey" || err.name === "NoSuchBucket") {
      return {
        statusCode: 404,
        body: JSON.stringify({ message: "Not found" }),
      };
    }
    console.error("Unhandled error in resource DELETE handler:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: "Server error." }),
    };
  }
};
