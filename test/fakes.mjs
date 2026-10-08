// In-memory stand-ins for the two AWS clients the API function uses, so the
// handler runs end to end in process: no Docker, no AWS. They implement the
// subset of S3 and DynamoDB semantics the handlers rely on, including S3's
// conditional writes (If-Match / If-None-Match: *), conditional deletes and
// paged listings with a delimiter.

import { createHash } from "node:crypto";
import { createRequire } from "node:module";

// The layer and the authorizer resolve the AWS SDK from the repo root's
// node_modules (the runtime provides it in Lambda); patching that copy
// intercepts every call from both.
const rootRequire = createRequire(new URL("../package.json", import.meta.url));
const s3 = rootRequire("@aws-sdk/client-s3");
const ddb = rootRequire("@aws-sdk/client-dynamodb");
// The authorizer carries its own copy of the DynamoDB client.
const authorizerRequire = createRequire(new URL("../src/authorizer/package.json", import.meta.url));
const authorizerDdb = authorizerRequire("@aws-sdk/client-dynamodb");

function awsError(name, status) {
  const err = new Error(name);
  err.name = name;
  err.$metadata = { httpStatusCode: status };
  return err;
}

const etagOf = (body) => `"${createHash("md5").update(body).digest("hex")}"`;

export class FakeS3 {
  buckets = new Map();

  bucket(name) {
    const bucket = this.buckets.get(name);
    if (!bucket) {
      throw awsError("NoSuchBucket", 404);
    }
    return bucket;
  }

  keys(name) {
    return [...this.bucket(name).keys()].sort();
  }

  async send(command) {
    const input = command.input;
    switch (command.constructor.name) {
      case "CreateBucketCommand":
        this.buckets.set(input.Bucket, new Map());
        return {};
      case "DeleteBucketCommand":
        this.bucket(input.Bucket);
        this.buckets.delete(input.Bucket);
        return {};
      case "PutObjectCommand": {
        const bucket = this.bucket(input.Bucket);
        const existing = bucket.get(input.Key);
        if (input.IfNoneMatch === "*" && existing) {
          throw awsError("PreconditionFailed", 412);
        }
        if (input.IfMatch !== undefined && (!existing || existing.etag !== input.IfMatch)) {
          throw awsError("PreconditionFailed", 412);
        }
        const body = Buffer.isBuffer(input.Body) ? input.Body : Buffer.from(input.Body ?? "");
        const object = {
          body,
          contentType: input.ContentType,
          metadata: input.Metadata ?? {},
          etag: etagOf(body),
          lastModified: new Date(),
        };
        bucket.set(input.Key, object);
        return { ETag: object.etag };
      }
      case "GetObjectCommand": {
        const object = this.bucket(input.Bucket).get(input.Key);
        if (!object) {
          throw awsError("NoSuchKey", 404);
        }
        if (input.IfNoneMatch !== undefined && input.IfNoneMatch === object.etag) {
          throw awsError("NotModified", 304);
        }
        return {
          Body: { transformToByteArray: async () => object.body },
          ContentType: object.contentType,
          ContentLength: object.body.length,
          ETag: object.etag,
          LastModified: object.lastModified,
          Metadata: object.metadata,
        };
      }
      case "HeadObjectCommand": {
        const object = this.bucket(input.Bucket).get(input.Key);
        if (!object) {
          throw awsError("NotFound", 404);
        }
        return {
          ContentType: object.contentType,
          ContentLength: object.body.length,
          ETag: object.etag,
          LastModified: object.lastModified,
          Metadata: object.metadata,
        };
      }
      case "DeleteObjectCommand": {
        const bucket = this.bucket(input.Bucket);
        const existing = bucket.get(input.Key);
        if (input.IfMatch !== undefined && existing && existing.etag !== input.IfMatch) {
          throw awsError("PreconditionFailed", 412);
        }
        bucket.delete(input.Key);
        return {};
      }
      case "DeleteObjectsCommand": {
        const bucket = this.bucket(input.Bucket);
        for (const { Key } of input.Delete.Objects) {
          bucket.delete(Key);
        }
        return {};
      }
      case "ListObjectsV2Command": {
        const bucket = this.bucket(input.Bucket);
        const prefix = input.Prefix ?? "";
        const all = [...bucket.keys()].filter((key) => key.startsWith(prefix)).sort();
        const contents = [];
        const prefixes = new Set();
        for (const key of all) {
          if (input.Delimiter) {
            const rest = key.slice(prefix.length);
            const slash = rest.indexOf(input.Delimiter);
            if (slash >= 0) {
              prefixes.add(prefix + rest.slice(0, slash + 1));
              continue;
            }
          }
          contents.push(key);
        }
        // Pages over the merged, ordered list of contents and prefixes.
        const entries = [
          ...contents.map((key) => ({ kind: "object", key })),
          ...[...prefixes].map((key) => ({ kind: "prefix", key })),
        ].sort((a, b) => (a.key < b.key ? -1 : 1));
        let start = 0;
        if (input.ContinuationToken !== undefined) {
          const decoded = Buffer.from(input.ContinuationToken, "base64").toString();
          const parsed = Number(decoded);
          if (!/^\d+$/.test(decoded) || Buffer.from(decoded).toString("base64") !== input.ContinuationToken) {
            throw awsError("InvalidArgument", 400);
          }
          start = parsed;
        }
        const max = input.MaxKeys ?? 1000;
        const page = entries.slice(start, start + max);
        const truncated = start + max < entries.length;
        return {
          Contents: page
            .filter((entry) => entry.kind === "object")
            .map(({ key }) => {
              const object = bucket.get(key);
              return { Key: key, Size: object.body.length, ETag: object.etag, LastModified: object.lastModified };
            }),
          CommonPrefixes: page.filter((entry) => entry.kind === "prefix").map(({ key }) => ({ Prefix: key })),
          IsTruncated: truncated,
          ...(truncated && { NextContinuationToken: Buffer.from(String(start + max)).toString("base64") }),
        };
      }
      default:
        throw new Error(`FakeS3: unsupported command ${command.constructor.name}`);
    }
  }
}

export class FakeDynamo {
  tables = { "wallet-spaces": new Map(), "was-coupons": new Map() };

  table(name) {
    const table = this.tables[name];
    if (!table) {
      throw new Error(`FakeDynamo: unknown table ${name}`);
    }
    return table;
  }

  keyOf(input) {
    return Object.values(input.Key)[0].S;
  }

  async send(command) {
    const input = command.input;
    switch (command.constructor.name) {
      case "GetItemCommand":
        return { Item: this.table(input.TableName).get(this.keyOf(input)) };
      case "PutItemCommand": {
        const key = Object.values(input.Item)[0].S;
        this.table(input.TableName).set(key, input.Item);
        return {};
      }
      case "DeleteItemCommand":
        this.table(input.TableName).delete(this.keyOf(input));
        return {};
      case "UpdateItemCommand": {
        const table = this.table(input.TableName);
        const key = this.keyOf(input);
        const item = table.get(key);
        if (input.UpdateExpression.startsWith("SET usesRemaining")) {
          const remaining = Number(item?.usesRemaining?.N ?? 0);
          if (remaining <= 0) {
            throw awsError("ConditionalCheckFailedException", 400);
          }
          item.usesRemaining = { N: String(remaining - 1) };
          return {};
        }
        const next = { ...(item ?? { spaceURL: { S: key } }) };
        if (input.UpdateExpression.startsWith("REMOVE")) {
          delete next.name;
        } else {
          next.name = input.ExpressionAttributeValues[":name"];
        }
        table.set(key, next);
        return {};
      }
      case "QueryCommand": {
        const did = input.ExpressionAttributeValues[":did"].S;
        const all = [...this.table(input.TableName).values()]
          .filter((item) => item.did?.S === did)
          .sort((a, b) => (a.spaceURL.S < b.spaceURL.S ? -1 : 1));
        let start = 0;
        if (input.ExclusiveStartKey) {
          start = all.findIndex((item) => item.spaceURL.S === input.ExclusiveStartKey.spaceURL.S) + 1;
        }
        const limit = input.Limit ?? all.length;
        const page = all.slice(start, start + limit);
        const last = page[page.length - 1];
        return {
          Items: page,
          ...(start + limit < all.length && last && { LastEvaluatedKey: { spaceURL: last.spaceURL, did: last.did } }),
        };
      }
      default:
        throw new Error(`FakeDynamo: unsupported command ${command.constructor.name}`);
    }
  }
}

// Installs fresh fakes and returns them.
export function installFakes() {
  const fakeS3 = new FakeS3();
  const fakeDynamo = new FakeDynamo();
  s3.S3Client.prototype.send = (command) => fakeS3.send(command);
  ddb.DynamoDBClient.prototype.send = (command) => fakeDynamo.send(command);
  authorizerDdb.DynamoDBClient.prototype.send = (command) => fakeDynamo.send(command);
  return { s3: fakeS3, dynamo: fakeDynamo };
}
