import { S3Client, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";

const s3 = new S3Client({});

// The collection's own metadata lives alongside its resources, so it must not
// be readable through the resource endpoint.
const RESERVED_RESOURCE_IDS = new Set(["description.json"]);

// WAS list URLs end in a slash (/space/{s}/collections/ lists the space's
// collections; /space/{s}/{c}/ lists a collection's members). An HTTP API
// cannot route a trailing slash to its own route key - the empty last segment
// matches /space/{space_id}/{collection_id}/{resource_id} with an empty
// resource_id - so this handler serves those listings.
async function listCollections(space_id) {
  const spacePath = `/space/${space_id}`;
  const prefix = `collections/`;
  const { CommonPrefixes } = await s3.send(
    new ListObjectsV2Command({ Bucket: space_id, Prefix: prefix, Delimiter: "/" })
  );
  const items = (CommonPrefixes ?? []).map(({ Prefix }) => {
    const collectionId = Prefix.slice(prefix.length, -1);
    return {
      id: collectionId,
      url: `${spacePath}/${collectionId}`,
      name: collectionId,
      public: false,
    };
  });
  return {
    url: `${spacePath}/collections/`,
    totalItems: items.length,
    items,
  };
}

async function listResources(space_id, collection_id) {
  const collectionPath = `/space/${space_id}/${collection_id}`;
  const prefix = `collections/${collection_id}/`;
  const { Contents } = await s3.send(
    new ListObjectsV2Command({ Bucket: space_id, Prefix: prefix, Delimiter: "/" })
  );
  const items = (Contents ?? [])
    .map(({ Key }) => Key.slice(prefix.length))
    .filter((resourceId) => resourceId && !RESERVED_RESOURCE_IDS.has(resourceId))
    .map((resourceId) => ({
      id: resourceId,
      url: `${collectionPath}/${resourceId}`,
      contentType: "application/json",
    }));
  return {
    id: collection_id,
    url: collectionPath,
    name: "JSON Documents Collection",
    type: ["Collection"],
    totalItems: items.length,
    items,
  };
}

export const lambdaHandler = async (event, context) => {
  // The zcap invocation was already verified by the WASZcapAuthorizer; the
  // invoker is on event.requestContext.authorizer.lambda.controller.
  const { pathParameters } = event;
  const { space_id, collection_id, resource_id } = pathParameters ?? {};

  if (!space_id || !collection_id) {
    return {
      statusCode: 500,
      body: JSON.stringify({ message: "Server error." }),
    };
  }

  try {
    // A trailing-slash list URL: the empty last segment arrives as an empty
    // resource_id.
    if (!resource_id) {
      const body =
        collection_id === "collections"
          ? await listCollections(space_id)
          : await listResources(space_id, collection_id);
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      };
    }

    if (RESERVED_RESOURCE_IDS.has(resource_id)) {
      return {
        statusCode: 404,
        body: JSON.stringify({ message: "Not found" }),
      };
    }

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
    console.error("Unhandled error in resource GET handler:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: "Server error." }),
    };
  }
};
