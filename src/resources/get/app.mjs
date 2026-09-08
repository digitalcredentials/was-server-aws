import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({});

// The collection's own metadata lives alongside its resources, so it must not
// be readable through the resource endpoint.
const RESERVED_RESOURCE_IDS = new Set(["description.json"]);

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

  try {
    const { Body, ContentType, ETag } = await s3.send(
      new GetObjectCommand({
        Bucket: space_id,
        Key: `collections/${collection_id}/${resource_id}`,
      })
    );
    const content = await Body.transformToString();
    return {
      statusCode: 200,
      headers: {
        "Content-Type": ContentType ?? "application/json",
        ...(ETag && { ETag }),
      },
      body: content,
    };
  } catch (err) {
    if (err.name === "NoSuchKey" || err.name === "NoSuchBucket") {
      return {
        statusCode: 404,
        body: JSON.stringify({ message: "Not found" }),
      };
    }
    throw err;
  }
};
