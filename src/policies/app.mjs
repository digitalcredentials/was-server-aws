import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

const s3 = new S3Client({});

// Access-control policy endpoints, one handler for all three scopes:
//
//   {GET,PUT,DELETE} /space/{space_id}/policy
//   {GET,PUT,DELETE} /space/{space_id}/{collection_id}/policy
//   {GET,PUT,DELETE} /space/{space_id}/{collection_id}/{resource_id}/policy
//
// Policies live under the bucket's policies/ prefix (space.json, {c}.json,
// {c}/{r}.json), separate from collections/ so they never appear in listings.
// The authorizer reads the same keys to grant unsigned public reads when a
// policy of type PublicCanRead covers the target.

export function policyKey({ collection_id, resource_id }) {
  if (resource_id) {
    return `policies/${collection_id}/${resource_id}.json`;
  }
  if (collection_id) {
    return `policies/${collection_id}.json`;
  }
  return "policies/space.json";
}

const json = (statusCode, body, headers = {}) => ({
  statusCode,
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body),
});

export const lambdaHandler = async (event, context) => {
  // The zcap invocation was already verified by the WASZcapAuthorizer (policy
  // endpoints are never public); the invoker is on
  // event.requestContext.authorizer.lambda.controller.
  const { pathParameters, body, isBase64Encoded } = event;
  const { space_id } = pathParameters ?? {};
  const method = event.requestContext?.http?.method ?? event.httpMethod;

  if (!space_id) {
    return json(500, { message: "Server error." });
  }

  const key = policyKey(pathParameters ?? {});

  try {
    if (method === "GET") {
      try {
        const { Body } = await s3.send(
          new GetObjectCommand({ Bucket: space_id, Key: key })
        );
        return {
          statusCode: 200,
          headers: { "Content-Type": "application/json" },
          body: await Body.transformToString(),
        };
      } catch (err) {
        if (err.name === "NoSuchKey") {
          return json(404, { message: "Not found" });
        }
        throw err;
      }
    }

    if (method === "PUT") {
      let policy;
      try {
        const raw = isBase64Encoded
          ? Buffer.from(body ?? "", "base64").toString("utf8")
          : body ?? "";
        policy = JSON.parse(raw);
      } catch {
        return json(400, { message: "Request body must be JSON." });
      }
      if (typeof policy?.type !== "string" || !policy.type) {
        return json(400, { message: 'Policy "type" must be a string.' });
      }

      await s3.send(
        new PutObjectCommand({
          Bucket: space_id,
          Key: key,
          Body: JSON.stringify(policy),
          ContentType: "application/json",
        })
      );
      // 200 with a JSON body: API Gateway defaults the Content-Type to
      // application/json, and clients that trust the header fail to parse an
      // empty response.
      return json(200, policy);
    }

    if (method === "DELETE") {
      // Idempotent: reverting to capability-only access
      await s3.send(new DeleteObjectCommand({ Bucket: space_id, Key: key }));
      return json(200, { deleted: true });
    }

    return json(405, { message: "Method not allowed" });
  } catch (err) {
    if (err.name === "NoSuchBucket") {
      return json(404, { message: "Not found" });
    }
    console.error("Unhandled error in policy handler:", err);
    return json(500, { message: "Server error." });
  }
};
