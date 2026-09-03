import {
  S3Client,
  GetObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";

const s3 = new S3Client({});

export const lambdaHandler = async (event, context) => {
  try {
    // The zcap invocation was already verified by the WASZcapAuthorizer; the
    // invoker is on event.requestContext.authorizer.controller.
    const { pathParameters } = event;

    const { space_id } = pathParameters;
    const spacePath = `/space/${space_id}`;

      try {
        const prefix = `collections/`;
        const command = new ListObjectsV2Command({
          Bucket: space_id,
          Prefix: prefix,
          Delimiter: "/",
        });
        const { CommonPrefixes } = await s3.send(command);
        const items = (CommonPrefixes ?? []).map(({ Prefix }) => {
          const collectionId = Prefix.slice(prefix.length, -1);
          return {
            id: collectionId,
            url: `${spacePath}/${collectionId}`,
            name: collectionId,
            public: false
          };
        });

        const body = {
          url: `${spacePath}/collections/`,
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
    

    /*  this goes into a different lambda later
    try {
      const command = new GetObjectCommand({
        Bucket: space_id,
        Key: `metadata/description.json`,
      });
      const { Body } = await s3.send(command);
      const content = await Body.transformToString();
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
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
    } */
  } catch (err) {
    console.error("Unhandled error in spaces GET handler:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: "Server error." }),
    };
  }
};
