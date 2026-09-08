import {
  S3Client,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

const s3 = new S3Client({});

export const lambdaHandler = async (event, context) => {
  // The zcap invocation was already verified by the WASZcapAuthorizer; the
  // invoker is on event.requestContext.authorizer.controller.
  const { pathParameters, body } = event;
  const { space_id, collection_id } = pathParameters ?? {};

  if (!space_id || !collection_id) {
    return {
      statusCode: 500,
      body: JSON.stringify({ message: "Server error." }),
    };
  }

  let description;
  try {
    description = JSON.parse(body ?? "");
  } catch {
    return {
      statusCode: 400,
      body: JSON.stringify({ message: "Request body must be JSON." }),
    };
  }

  // A collection description must at least declare itself a Collection.
  const types = Array.isArray(description?.type)
    ? description.type
    : [description?.type];
  if (!types.includes("Collection")) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        message: 'Collection description "type" must include "Collection".',
      }),
    };
  }

  const collectionPath = `/space/${space_id}/${collection_id}`;
  const key = `collections/${collection_id}/description.json`;

  try {
    // 201 when the PUT creates the collection, 204 when it updates one.
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

    const stored = {
      ...description,
      id: collection_id,
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

    if (exists) {
      return { statusCode: 204, body: "" };
    }
    return {
      statusCode: 201,
      headers: {
        "Content-Type": "application/json",
        Location: collectionPath,
      },
      body: JSON.stringify(stored),
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
