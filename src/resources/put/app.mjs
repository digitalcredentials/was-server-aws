import {
  S3Client,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

const s3 = new S3Client({});

// The collection's own metadata lives alongside its resources, so it must not
// be writable through the resource endpoint.
const RESERVED_RESOURCE_IDS = new Set(["description.json"]);

export const lambdaHandler = async (event, context) => {
  // The zcap invocation was already verified by the WASZcapAuthorizer; the
  // invoker is on event.requestContext.authorizer.controller.
  const { pathParameters, body, headers, isBase64Encoded } = event;
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
    // 201 when the PUT creates the resource, 204 when it updates one.
    let exists = true;
    try {
      await s3.send(new HeadObjectCommand({ Bucket: space_id, Key: key }));
    } catch (err) {
      if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) {
        exists = false;
      } else {
        throw err;
      }
    }

    const contentType =
      headers?.["Content-Type"] ?? headers?.["content-type"];
    const { ETag } = await s3.send(
      new PutObjectCommand({
        Bucket: space_id,
        Key: key,
        Body: isBase64Encoded
          ? Buffer.from(body ?? "", "base64")
          : body ?? "",
        ...(contentType && { ContentType: contentType }),
      })
    );

    const responseHeaders = { ...(ETag && { ETag }) };
    if (exists) {
      return { statusCode: 204, headers: responseHeaders, body: "" };
    }
    return {
      statusCode: 201,
      headers: {
        ...responseHeaders,
        Location: `/space/${space_id}/${collection_id}/${resource_id}`,
      },
      body: "",
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
};
