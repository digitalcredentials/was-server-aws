import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({});

// https://w3c-ccg.github.io/wallet-attached-storage-spec/#http-api-get-space-space_id
// GET /space/:space_id -> the Space's description object.
export const lambdaHandler = async (event, context) => {
  try {
    // The zcap invocation was already verified by the WASZcapAuthorizer; the
    // invoker is on event.requestContext.authorizer.controller.
    const { pathParameters } = event;

    const { space_id } = pathParameters;
    const spacePath = `/space/${space_id}`;

    try {
      const command = new GetObjectCommand({
        Bucket: space_id,
        Key: `metadata/description.json`,
      });
      const { Body } = await s3.send(command);
      const stored = JSON.parse(await Body.transformToString());

      // Keep whatever was authored (name, controller, createdBy, ...) but let the
      // server own the fields that are derived from the request path.
      const body = {
        ...stored,
        id: space_id,
        url: spacePath,
        type: ["Space"],
        linkset: `${spacePath}/linkset`,
      };

      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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
  } catch (err) {
    console.error("Unhandled error in space description GET handler:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: "Server error." }),
    };
  }
};
