import { DynamoDBClient, GetItemCommand, DeleteItemCommand } from "@aws-sdk/client-dynamodb";
import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  DeleteBucketCommand,
} from "@aws-sdk/client-s3";

const dynamoClient = new DynamoDBClient();
const s3 = new S3Client({});

const SPACES_TABLE = process.env.SPACES_TABLE_NAME ?? "wallet-spaces";

// DELETE /space/:space_id -> deletes the whole space: its bucket (emptied
// first) and its registry row. The WASZcapAuthorizer has already verified the
// invocation against the space's registered controller DID, matching the
// spec's rule that deletion requires a capability invoked by the controller.
// Only batch spaces may be deleted; an account's credential spaces are not
// deletable through the API.
export const lambdaHandler = async (event, context) => {
  const { space_id } = event.pathParameters ?? {};
  if (!space_id) {
    return {
      statusCode: 500,
      body: JSON.stringify({ message: "Server error." }),
    };
  }

  // The registry row, for the space's type. The authorizer resolved the
  // controller from this same row, so it exists.
  let item;
  try {
    const headers = Object.fromEntries(
      Object.entries(event.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value])
    );
    const proto = headers["x-forwarded-proto"] ?? "https";
    const host = headers.host ?? event.requestContext.domainName;
    const spaceURL = `${proto}://${host}/space/${space_id}`;
    ({ Item: item } = await dynamoClient.send(new GetItemCommand({
      TableName: SPACES_TABLE,
      Key: { spaceURL: { S: spaceURL } },
    })));
    if (!item) {
      return {
        statusCode: 404,
        body: JSON.stringify({ message: "Not found" }),
      };
    }
    if (item.type?.S !== "batch") {
      return {
        statusCode: 403,
        body: JSON.stringify({ message: "Only batch spaces can be deleted." }),
      };
    }

    // Empty the bucket, then delete it. NoSuchBucket is tolerated so a
    // half-deleted space can be cleaned up by retrying.
    try {
      let ContinuationToken;
      do {
        const page = await s3.send(new ListObjectsV2Command({
          Bucket: space_id,
          ContinuationToken,
        }));
        const objects = (page.Contents ?? []).map(({ Key }) => ({ Key }));
        if (objects.length) {
          await s3.send(new DeleteObjectsCommand({
            Bucket: space_id,
            Delete: { Objects: objects },
          }));
        }
        ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (ContinuationToken);
      await s3.send(new DeleteBucketCommand({ Bucket: space_id }));
    } catch (err) {
      if (err.name !== "NoSuchBucket") {
        throw err;
      }
    }

    await dynamoClient.send(new DeleteItemCommand({
      TableName: SPACES_TABLE,
      Key: { spaceURL: { S: spaceURL } },
    }));

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deleted: true }),
    };
  } catch (err) {
    console.error("Unhandled error in space DELETE handler:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: "Server error." }),
    };
  }
};
