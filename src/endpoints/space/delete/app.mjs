import { DynamoDBClient, DeleteItemCommand } from "@aws-sdk/client-dynamodb";
import { DeleteBucketCommand } from "@aws-sdk/client-s3";
import { handler } from "was-lib/handler.mjs";
import { noContent, NO_STORE } from "was-lib/http.mjs";
import { s3, isNoBucket, deletePrefix } from "was-lib/store.mjs";

// DELETE /space/{s}/ -- the whole Space: its bucket (emptied first) and its
// registry row. Root capability only (the container rule). An
// already-missing bucket is tolerated so a half-deleted Space can be
// cleaned up by retrying.

const dynamo = new DynamoDBClient({});
const SPACES_TABLE = process.env.SPACES_TABLE_NAME ?? "wallet-spaces";

export const lambdaHandler = handler(
  async (req, { spaceId, registryUrl }) => {
    try {
      await deletePrefix(spaceId, "");
      await s3.send(new DeleteBucketCommand({ Bucket: spaceId }));
    } catch (err) {
      if (!isNoBucket(err) && err?.status !== 404) {
        throw err;
      }
    }
    await dynamo.send(
      new DeleteItemCommand({ TableName: SPACES_TABLE, Key: { spaceURL: { S: registryUrl } } })
    );
    return noContent(req, NO_STORE);
  },
  { scope: "space", rootOnly: true }
);
