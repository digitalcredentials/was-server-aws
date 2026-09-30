import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({});

// https://w3c-ccg.github.io/wallet-attached-storage-spec/ Space description
// update: PUT /space/:space_id stores the space's description document
// (metadata/description.json — what the GET serves back, with the derived
// fields stamped on read).
export const lambdaHandler = async (event, context) => {
  // The zcap invocation was already verified by the WASZcapAuthorizer; the
  // invoker is on event.requestContext.authorizer.lambda.controller.
  const { pathParameters, body } = event;
  const { space_id } = pathParameters ?? {};

  if (!space_id) {
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
  if (typeof description !== "object" || description === null || Array.isArray(description)) {
    return {
      statusCode: 400,
      body: JSON.stringify({ message: "Request body must be a JSON object." }),
    };
  }

  // A description without a type gets Space stamped rather than rejected; a
  // type that names something else is refused.
  if (description.type === undefined) {
    description = { ...description, type: ["Space"] };
  }
  const types = Array.isArray(description.type) ? description.type : [description.type];
  if (!types.includes("Space")) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        message: 'Space description "type" must include "Space".',
      }),
    };
  }

  const spacePath = `/space/${space_id}`;
  // The server owns the derived fields, whatever the client sent; the GET
  // stamps them on read as well.
  const stored = {
    ...description,
    id: space_id,
    url: spacePath,
    type: ["Space"],
    linkset: `${spacePath}/linkset`,
  };

  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: space_id,
        Key: "metadata/description.json",
        Body: JSON.stringify(stored),
        ContentType: "application/json",
      })
    );
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(stored),
    };
  } catch (err) {
    if (err.name === "NoSuchBucket") {
      return {
        statusCode: 404,
        body: JSON.stringify({ message: "Not found" }),
      };
    }
    console.error("Unhandled error in space description PUT handler:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: "Server error." }),
    };
  }
};
