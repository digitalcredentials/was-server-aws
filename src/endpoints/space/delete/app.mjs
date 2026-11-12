import { DynamoDBClient, DeleteItemCommand, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { DeleteBucketCommand } from "@aws-sdk/client-s3";
import { handler } from "was-lib/handler.mjs";
import { noContent, NO_STORE } from "was-lib/http.mjs";
import { s3, isNoBucket, deletePrefix, bucketOf } from "was-lib/store.mjs";
import { purgeBucket } from "was-lib/feed.mjs";
import { isCouponlessRow, releaseCouponlessSlot } from "was-lib/quota.mjs";

// DELETE /space/{s}/ -- the whole Space: its bucket (emptied first) and its
// registry row. The root capability, or a delegated capability whose tail
// targets exactly this Space's URL and allows exactly DELETE: the container
// rule's Space-delete exception, which the authorizer's container-rule
// inspector (src/authorizer/container.mjs) applies, so this handler takes a
// verified delegated chain. An already-missing bucket is tolerated so a
// half-deleted Space can be cleaned up by retrying. A Space created without
// a coupon gives its slot under the global cap back.

const dynamo = new DynamoDBClient({});
const SPACES_TABLE = process.env.SPACES_TABLE_NAME ?? "pws-spaces";

export const lambdaHandler = handler(
  async (req, { spaceId, registryUrl }) => {
    const { Item: row } = await dynamo.send(new GetItemCommand({ TableName: SPACES_TABLE, Key: { spaceURL: { S: registryUrl } } }));
    try {
      await deletePrefix(spaceId, "");
      await s3.send(new DeleteBucketCommand({ Bucket: bucketOf(spaceId) }));
    } catch (err) {
      if (!isNoBucket(err) && err?.status !== 404) {
        throw err;
      }
    }
    await dynamo.send(
      new DeleteItemCommand({ TableName: SPACES_TABLE, Key: { spaceURL: { S: registryUrl } } })
    );
    if (row && isCouponlessRow(row)) {
      await releaseCouponlessSlot();
    }
    // The Collections' feeds go with the Space (a re-created unlock Space
    // reuses the bucket name)
    await purgeBucket(bucketOf(spaceId));
    return noContent(req, NO_STORE);
  },
  { scope: "space" }
);
