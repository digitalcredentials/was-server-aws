import { S3Client, ListBucketsCommand } from "@aws-sdk/client-s3";
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { maxCouponlessSpaces, readCouponlessCount } from "was-lib/quota.mjs";

// The quota watch: on a schedule (and by hand), counts this stack's Space
// buckets and reads the coupon-less Space counter, and publishes both as
// CloudWatch metrics (namespace PwsServer: SpaceBuckets, CouponlessSpaces)
// for the stack's alarms. Returns the numbers.

const s3 = new S3Client({});
const cloudwatch = new CloudWatchClient({});
const NAMESPACE = "PwsServer";

async function spaceBucketCount() {
  let count = 0;
  let token;
  do {
    const out = await s3.send(new ListBucketsCommand({ ...(token && { ContinuationToken: token }) }));
    count += (out.Buckets ?? []).filter((bucket) => bucket.Name?.startsWith("dcc-pws-")).length;
    token = out.ContinuationToken;
  } while (token);
  return count;
}

export const lambdaHandler = async () => {
  const [buckets, couponlessSpaces] = await Promise.all([spaceBucketCount(), readCouponlessCount()]);
  const max = maxCouponlessSpaces();
  await cloudwatch.send(
    new PutMetricDataCommand({
      Namespace: NAMESPACE,
      MetricData: [
        { MetricName: "SpaceBuckets", Value: buckets, Unit: "Count" },
        { MetricName: "CouponlessSpaces", Value: couponlessSpaces, Unit: "Count" },
      ],
    })
  );
  const report = { buckets, couponlessSpaces, max };
  console.log(JSON.stringify(report));
  return report;
};
