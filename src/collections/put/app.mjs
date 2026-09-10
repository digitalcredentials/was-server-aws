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

  // A collection description must declare itself a Collection; a description
  // without a type (the was-client's configure() sends only the writable
  // fields) gets the type stamped rather than rejected.
  if (description?.type === undefined) {
    description = { ...description, type: ["Collection"] };
  }
  const types = Array.isArray(description.type)
    ? description.type
    : [description.type];
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
      // 200 with a JSON body rather than an empty 204: API Gateway defaults
      // the Content-Type to application/json, and clients that trust the
      // header fail to parse an empty string.
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(stored),
      };
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
