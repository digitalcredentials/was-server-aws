import { applyObjectEvent } from "was-lib/feed.mjs";

// The feed consumer: the Space buckets' object events, delivered by
// EventBridge through the feed's FIFO queue in one message group, applied
// in order to the `changes` feed (was-lib/feed.mjs). A message that fails
// is reported back to the queue for a retry; the others in the batch
// stand.
export const lambdaHandler = async (event) => {
  const failures = [];
  for (const record of event.Records ?? []) {
    try {
      const body = JSON.parse(record.body);
      const detail = body.detail ?? {};
      const result = await applyObjectEvent({
        bucket: detail.bucket?.name,
        key: detail.object?.key,
        deleted: body["detail-type"] === "Object Deleted",
        etag: detail.object?.etag,
        sequencer: detail.object?.sequencer,
        time: body.time,
      });
      console.log(JSON.stringify({ feed: result, key: detail.object?.key, bucket: detail.bucket?.name }));
    } catch (err) {
      console.error("Feed event failed:", err?.message ?? err, record.body?.slice?.(0, 400));
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
};
