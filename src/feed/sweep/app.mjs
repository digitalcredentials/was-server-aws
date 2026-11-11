import { createHash } from "node:crypto";
import { S3Client, PutBucketNotificationConfigurationCommand } from "@aws-sdk/client-s3";
import { SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import { DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";
import { bucketOf, headObject, listAllKeys } from "was-lib/store.mjs";
import { classifyKey, keyOfRecord, allFeedRows } from "was-lib/feed.mjs";

// The feed sweep: compares a bucket's objects with its feed rows and
// queues a synthetic event for every record the feed has wrong or missing
// (an object with no row or a stale validator, a row whose object is gone
// without a tombstone), so the consumer repairs it in order with the live
// events. It also makes sure the bucket publishes its object events to
// EventBridge, which is what a bucket created before the feed existed
// lacks. Invoked by hand or on a schedule with `{ "buckets": [...] }`, or
// with no input for every registered Space.

const SPACES_TABLE = process.env.SPACES_TABLE_NAME ?? "was-spaces";
const QUEUE_URL = process.env.FEED_QUEUE_URL;
const s3 = new S3Client({});
const sqs = new SQSClient({});
const dynamo = new DynamoDBClient({});

async function registeredBuckets() {
  const buckets = [];
  let cursor;
  do {
    const out = await dynamo.send(
      new ScanCommand({ TableName: SPACES_TABLE, ProjectionExpression: "spaceURL", ...(cursor && { ExclusiveStartKey: cursor }) })
    );
    for (const row of out.Items ?? []) {
      const spaceId = row.spaceURL.S.split("/space/")[1];
      if (spaceId) {
        buckets.push(bucketOf(spaceId));
      }
    }
    cursor = out.LastEvaluatedKey;
  } while (cursor);
  return buckets;
}

export async function ensureBucketEvents(bucket) {
  await s3.send(
    new PutBucketNotificationConfigurationCommand({
      Bucket: bucket,
      NotificationConfiguration: { EventBridgeConfiguration: {} },
    })
  );
}

const syntheticEvent = ({ bucket, key, deleted, etag }) => ({
  "detail-type": deleted ? "Object Deleted" : "Object Created",
  source: "was-server-aws.feed-sweep",
  time: new Date().toISOString(),
  detail: { bucket: { name: bucket }, object: { key, ...(etag && { etag: etag.replace(/"/g, "") }) }, reason: "sweep" },
});

async function enqueue(events) {
  for (let i = 0; i < events.length; i += 10) {
    const batch = events.slice(i, i + 10);
    await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: QUEUE_URL,
        Entries: batch.map((event, n) => ({
          Id: String(n),
          MessageBody: JSON.stringify(event),
          MessageGroupId: "feed",
          MessageDeduplicationId: createHash("sha256")
            .update(`${event.detail.bucket.name}/${event.detail.object.key}/${event.detail.object.etag ?? "deleted"}/${event.time}`)
            .digest("hex"),
        })),
      })
    );
  }
}

// The events one bucket needs, from its objects and rows.
export async function sweepBucket(bucket) {
  const keys = (await Promise.all(["collections/", "meta/", "policies/"].map((prefix) => listAllKeys(bucket, prefix)))).flat();
  const byCollection = new Map();
  const want = new Map();
  for (const key of keys) {
    const classified = classifyKey(key);
    if (classified === null || classified.sidecar) {
      continue;
    }
    byCollection.set(classified.collectionId, true);
    want.set(`${classified.collectionId}#${classified.kind}#${classified.recordId}`, { ...classified, key });
  }
  const events = [];
  for (const collectionId of byCollection.keys()) {
    const rows = await allFeedRows(bucket, collectionId);
    const seen = new Set();
    for (const row of rows) {
      seen.add(row.record);
      const expected = want.get(row.record);
      if (expected === undefined) {
        if (!row.deleted && (row.kind === "resource" || row.kind === "policy")) {
          events.push(syntheticEvent({ bucket, key: keyOfRecord(collectionId, row.kind, row.recordId), deleted: true }));
        }
        continue;
      }
      const head = await headObject(bucket, expected.key);
      if (head !== null && (row.deleted || row.etag !== head.etag)) {
        events.push(syntheticEvent({ bucket, key: expected.key, deleted: false, etag: head.etag }));
      }
    }
    for (const [record, expected] of want) {
      if (expected.collectionId === collectionId && !seen.has(record)) {
        const head = await headObject(bucket, expected.key);
        if (head !== null) {
          events.push(syntheticEvent({ bucket, key: expected.key, deleted: false, etag: head.etag }));
        }
      }
    }
  }
  return events;
}

export const lambdaHandler = async (input = {}) => {
  const buckets = Array.isArray(input.buckets) && input.buckets.length ? input.buckets : await registeredBuckets();
  const report = {};
  for (const bucket of buckets) {
    try {
      await ensureBucketEvents(bucket);
      const events = await sweepBucket(bucket);
      if (events.length && QUEUE_URL) {
        await enqueue(events);
      }
      report[bucket] = { queued: events.length };
    } catch (err) {
      console.error(`Sweep of ${bucket} failed:`, err?.message ?? err);
      report[bucket] = { error: err?.message ?? String(err) };
    }
  }
  return report;
};
