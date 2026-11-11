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
const sqs = rootRequire("@aws-sdk/client-sqs");
const cloudwatch = rootRequire("@aws-sdk/client-cloudwatch");
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
      case "PutBucketNotificationConfigurationCommand":
        this.bucket(input.Bucket);
        return {};
      case "CreateBucketCommand":
        this.buckets.set(input.Bucket, new Map());
        return {};
      case "ListBucketsCommand":
        return { Buckets: [...this.buckets.keys()].map((Name) => ({ Name })) };
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

export class FakeSqs {
  messages = [];

  async send(command) {
    if (command.constructor.name === "SendMessageBatchCommand") {
      this.messages.push(...command.input.Entries.map((entry) => ({ ...entry, body: JSON.parse(entry.MessageBody) })));
      return { Successful: command.input.Entries.map((entry) => ({ Id: entry.Id })), Failed: [] };
    }
    throw new Error(`FakeSqs: unsupported command ${command.constructor.name}`);
  }
}

// DynamoDB's reserved words (docs.aws.amazon.com, "Reserved words in
// DynamoDB", complete as of 2026-11): an attribute named by one of these in
// an expression must go by an alias (`#name`), or the service refuses the
// request with a ValidationException. The fake refuses it the same way, so
// a bare reserved word cannot pass the unit tests and fail live.
const DYNAMODB_RESERVED_WORDS = new Set(
  `ABORT ABSOLUTE ACTION ADD AFTER AGENT AGGREGATE ALL ALLOCATE ALTER ANALYZE AND ANY ARCHIVE ARE ARRAY AS ASC ASCII
  ASENSITIVE ASSERTION ASYMMETRIC AT ATOMIC ATTACH ATTRIBUTE AUTH AUTHORIZATION AUTHORIZE AUTO AVG BACK BACKUP BASE BATCH
  BEFORE BEGIN BETWEEN BIGINT BINARY BIT BLOB BLOCK BOOLEAN BOTH BREADTH BUCKET BULK BY BYTE CALL CALLED CALLING CAPACITY
  CASCADE CASCADED CASE CAST CATALOG CHAR CHARACTER CHECK CLASS CLOB CLOSE CLUSTER CLUSTERED CLUSTERING CLUSTERS COALESCE
  COLLATE COLLATION COLLECTION COLUMN COLUMNS COMBINE COMMENT COMMIT COMPACT COMPILE COMPRESS CONDITION CONFLICT CONNECT
  CONNECTION CONSISTENCY CONSISTENT CONSTRAINT CONSTRAINTS CONSTRUCTOR CONSUMED CONTINUE CONVERT COPY CORRESPONDING COUNT
  COUNTER CREATE CROSS CUBE CURRENT CURSOR CYCLE DATA DATABASE DATE DATETIME DAY DEALLOCATE DEC DECIMAL DECLARE DEFAULT
  DEFERRABLE DEFERRED DEFINE DEFINED DEFINITION DELETE DELIMITED DEPTH DEREF DESC DESCRIBE DESCRIPTOR DETACH DETERMINISTIC
  DIAGNOSTICS DIRECTORIES DISABLE DISCONNECT DISTINCT DISTRIBUTE DO DOMAIN DOUBLE DROP DUMP DURATION DYNAMIC EACH ELEMENT
  ELSE ELSEIF EMPTY ENABLE END EQUAL EQUALS ERROR ESCAPE ESCAPED EVAL EVALUATE EXCEEDED EXCEPT EXCEPTION EXCEPTIONS
  EXCLUSIVE EXEC EXECUTE EXISTS EXIT EXPLAIN EXPLODE EXPORT EXPRESSION EXTENDED EXTERNAL EXTRACT FAIL FALSE FAMILY FETCH
  FIELDS FILE FILTER FILTERING FINAL FINISH FIRST FIXED FLATTERN FLOAT FOR FORCE FOREIGN FORMAT FORWARD FOUND FREE FROM
  FULL FUNCTION FUNCTIONS GENERAL GENERATE GET GLOB GLOBAL GO GOTO GRANT GREATER GROUP GROUPING HANDLER HASH HAVE HAVING
  HEAP HIDDEN HOLD HOUR IDENTIFIED IDENTITY IF IGNORE IMMEDIATE IMPORT IN INCLUDING INCLUSIVE INCREMENT INCREMENTAL INDEX
  INDEXED INDEXES INDICATOR INFINITE INITIALLY INLINE INNER INNTER INOUT INPUT INSENSITIVE INSERT INSTEAD INT INTEGER
  INTERSECT INTERVAL INTO INVALIDATE IS ISOLATION ITEM ITEMS ITERATE JOIN KEY KEYS LAG LANGUAGE LARGE LAST LATERAL LEAD
  LEADING LEAVE LEFT LENGTH LESS LEVEL LIKE LIMIT LIMITED LINES LIST LOAD LOCAL LOCALTIME LOCALTIMESTAMP LOCATION LOCATOR
  LOCK LOCKS LOG LOGED LONG LOOP LOWER MAP MATCH MATERIALIZED MAX MAXLEN MEMBER MERGE METHOD METRICS MIN MINUS MINUTE
  MISSING MOD MODE MODIFIES MODIFY MODULE MONTH MULTI MULTISET NAME NAMES NATIONAL NATURAL NCHAR NCLOB NEW NEXT NO NONE
  NOT NULL NULLIF NUMBER NUMERIC OBJECT OF OFFLINE OFFSET OLD ON ONLINE ONLY OPAQUE OPEN OPERATOR OPTION OR ORDER
  ORDINALITY OTHER OTHERS OUT OUTER OUTPUT OVER OVERLAPS OVERRIDE OWNER PAD PARALLEL PARAMETER PARAMETERS PARTIAL
  PARTITION PARTITIONED PARTITIONS PATH PERCENT PERCENTILE PERMISSION PERMISSIONS PIPE PIPELINED PLAN POOL POSITION
  PRECISION PREPARE PRESERVE PRIMARY PRIOR PRIVATE PRIVILEGES PROCEDURE PROCESSED PROJECT PROJECTION PROPERTY PROVISIONING
  PUBLIC PUT QUERY QUIT QUORUM RAISE RANDOM RANGE RANK RAW READ READS REAL REBUILD RECORD RECURSIVE REDUCE REF REFERENCE
  REFERENCES REFERENCING REGEXP REGION REINDEX RELATIVE RELEASE REMAINDER RENAME REPEAT REPLACE REQUEST RESET RESIGNAL
  RESOURCE RESPONSE RESTORE RESTRICT RESULT RETURN RETURNING RETURNS REVERSE REVOKE RIGHT ROLE ROLES ROLLBACK ROLLUP
  ROUTINE ROW ROWS RULE RULES SAMPLE SATISFIES SAVE SAVEPOINT SCAN SCHEMA SCOPE SCROLL SEARCH SECOND SECTION SEGMENT
  SEGMENTS SELECT SELF SEMI SENSITIVE SEPARATE SEQUENCE SERIALIZABLE SESSION SET SETS SHARD SHARE SHARED SHORT SHOW SIGNAL
  SIMILAR SIZE SKEWED SMALLINT SNAPSHOT SOME SOURCE SPACE SPACES SPARSE SPECIFIC SPECIFICTYPE SPLIT SQL SQLCODE SQLERROR
  SQLEXCEPTION SQLSTATE SQLWARNING START STATE STATIC STATUS STORAGE STORE STORED STREAM STRING STRUCT STYLE SUB
  SUBMULTISET SUBPARTITION SUBSTRING SUBTYPE SUM SUPER SYMMETRIC SYNONYM SYSTEM TABLE TABLESAMPLE TEMP TEMPORARY
  TERMINATED TEXT THAN THEN THROUGHPUT TIME TIMESTAMP TIMEZONE TINYINT TO TOKEN TOTAL TOUCH TRAILING TRANSACTION TRANSFORM
  TRANSLATE TRANSLATION TREAT TRIGGER TRIM TRUE TRUNCATE TTL TUPLE TYPE UNDER UNDO UNION UNIQUE UNIT UNKNOWN UNLOGGED
  UNNEST UNPROCESSED UNSIGNED UNTIL UPDATE UPPER URL USAGE USE USER USERS USING UUID VACUUM VALUE VALUED VALUES VARCHAR
  VARIABLE VARIANCE VARINT VARYING VIEW VIEWS VIRTUAL VOID WAIT WHEN WHENEVER WHERE WHILE WINDOW WITH WITHIN WITHOUT WORK
  WRAPPED WRITE YEAR ZONE`.split(/\s+/)
);

// The words of the expression grammar itself (operators, clause verbs and
// functions), which are not attribute names where they appear.
const EXPRESSION_GRAMMAR = new Set([
  "SET", "ADD", "REMOVE", "DELETE", "AND", "OR", "NOT", "BETWEEN", "IN",
  "ATTRIBUTE_EXISTS", "ATTRIBUTE_NOT_EXISTS", "ATTRIBUTE_TYPE", "BEGINS_WITH", "CONTAINS", "SIZE", "IF_NOT_EXISTS", "LIST_APPEND",
]);

const EXPRESSION_INPUTS = ["ProjectionExpression", "ConditionExpression", "UpdateExpression", "KeyConditionExpression", "FilterExpression"];

// Refuses a bare reserved word used as an attribute name in any of the
// request's expressions, with the service's own error. Aliases (`#x`) and
// value placeholders (`:v`) are exempt, as are the grammar's own words.
function assertNoReservedWords(input) {
  for (const kind of EXPRESSION_INPUTS) {
    const expression = input[kind];
    if (typeof expression !== "string") {
      continue;
    }
    for (const [, prefix, word] of expression.matchAll(/([#:]?)([A-Za-z_][A-Za-z0-9_]*)/g)) {
      const upper = word.toUpperCase();
      if (prefix === "" && !EXPRESSION_GRAMMAR.has(upper) && DYNAMODB_RESERVED_WORDS.has(upper)) {
        const err = new Error(`Invalid ${kind}: Attribute name is a reserved keyword; reserved keyword: ${word}`);
        err.name = "ValidationException";
        throw err;
      }
    }
  }
}

export class FakeDynamo {
  tables = { "was-spaces": new Map(), "was-coupons": new Map(), "was-feed": new Map() };

  // The feed table's rows, keyed by bucket and record; the by-position
  // index is a sort over them.
  feedKey = (key) => `${key.bucket.S}|${key.record.S}`;

  async feed(command) {
    const input = command.input;
    const table = this.tables["was-feed"];
    const values = input.ExpressionAttributeValues ?? {};
    const names = input.ExpressionAttributeNames ?? {};
    const attr = (token) => names[token] ?? token;
    switch (command.constructor.name) {
      case "GetItemCommand":
        return { Item: table.get(this.feedKey(input.Key)) };
      case "PutItemCommand":
        table.set(this.feedKey(input.Item), input.Item);
        return {};
      case "DeleteItemCommand":
        table.delete(this.feedKey(input.Key));
        return {};
      case "UpdateItemCommand": {
        // ADD #n :one SET #g = if_not_exists(#g, :gen), #c = :collection
        const key = this.feedKey(input.Key);
        const next = { ...(table.get(key) ?? input.Key) };
        const [, addClause, setClause] = /^ADD (.+?) SET (.+)$/s.exec(input.UpdateExpression);
        const [addName, addValue] = addClause.split(/\s+/);
        const current = Number(next[attr(addName)]?.N ?? 0);
        next[attr(addName)] = { N: String(current + Number(values[addValue].N)) };
        // Clauses split on the commas between assignments, not inside a function
        for (const clause of setClause.split(/,\s*(?=#?\w+\s*=)/).map((c) => c.trim())) {
          const [lhs, rhs] = clause.split(/\s*=\s*(.*)/s);
          const exists = /if_not_exists\((#?\w+),\s*(:\w+)\)/.exec(rhs);
          if (exists) {
            next[attr(lhs)] = next[attr(exists[1])] ?? values[exists[2]];
          } else {
            next[attr(lhs)] = values[rhs];
          }
        }
        table.set(key, next);
        return { Attributes: next };
      }
      case "QueryCommand": {
        let rows;
        if (input.IndexName === "by-position") {
          const feed = values[":feed"].S;
          const after = Number(values[":after"].N);
          rows = [...table.values()]
            .filter((it) => it.feed?.S === feed && it.position !== undefined && Number(it.position.N) > after)
            .sort((a, b) => Number(a.position.N) - Number(b.position.N));
        } else {
          const bucket = values[":bucket"].S;
          const prefix = values[":prefix"]?.S ?? "";
          rows = [...table.values()]
            .filter((it) => it.bucket.S === bucket && it.record.S.startsWith(prefix))
            .sort((a, b) => (a.record.S < b.record.S ? -1 : 1));
        }
        let start = 0;
        if (input.ExclusiveStartKey) {
          const key = this.feedKey(input.ExclusiveStartKey);
          start = rows.findIndex((it) => this.feedKey(it) === key) + 1;
        }
        const limit = input.Limit ?? rows.length;
        const page = rows.slice(start, start + limit);
        const last = page[page.length - 1];
        return {
          Items: page,
          ...(start + limit < rows.length && last && { LastEvaluatedKey: { bucket: last.bucket, record: last.record } }),
        };
      }
      default:
        throw new Error(`FakeDynamo: unsupported feed command ${command.constructor.name}`);
    }
  }

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
    assertNoReservedWords(input);
    if (input.TableName === "was-feed") {
      return this.feed(command);
    }
    switch (command.constructor.name) {
      case "GetItemCommand":
        return { Item: this.table(input.TableName).get(this.keyOf(input)) };
      // The whole table in one page (the sweep's registry scan)
      case "ScanCommand":
        return { Items: [...this.table(input.TableName).values()] };
      case "PutItemCommand": {
        const key = Object.values(input.Item)[0].S;
        // attribute_not_exists(<key attribute>): a conditional create
        if (input.ConditionExpression?.startsWith("attribute_not_exists(") && this.table(input.TableName).has(key)) {
          throw awsError("ConditionalCheckFailedException", 400);
        }
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
        // ADD #field :delta, with the two conditions the counters use:
        // `attribute_not_exists(#f) OR #f < :max` and `#f > :zero`
        if (input.UpdateExpression.startsWith("ADD ")) {
          const names = input.ExpressionAttributeNames ?? {};
          const values = input.ExpressionAttributeValues ?? {};
          const [, lhs, rhs] = input.UpdateExpression.match(/^ADD\s+(\S+)\s+(\S+)/);
          const field = names[lhs] ?? lhs;
          const current = item?.[field]?.N;
          if (input.ConditionExpression) {
            const absentOk = /attribute_not_exists\(/.test(input.ConditionExpression) && current === undefined;
            const comparison = input.ConditionExpression.match(/\S+\s*([<>])\s*(:\w+)/);
            let ok = absentOk;
            if (!ok && comparison) {
              const bound = Number(values[comparison[2]].N);
              const value = Number(current ?? 0);
              ok = comparison[1] === "<" ? value < bound : value > bound;
            }
            if (!ok) {
              throw awsError("ConditionalCheckFailedException", 400);
            }
          }
          const next = { ...(item ?? { spaceURL: { S: key } }), [field]: { N: String(Number(current ?? 0) + Number(values[rhs].N)) } };
          table.set(key, next);
          return { Attributes: next };
        }
        if (input.UpdateExpression.startsWith("SET usesRemaining")) {
          const remaining = Number(item?.usesRemaining?.N ?? 0);
          if (remaining <= 0) {
            throw awsError("ConditionalCheckFailedException", 400);
          }
          item.usesRemaining = { N: String(remaining - 1) };
          return {};
        }
        // SET a = :a, b = :b / REMOVE a, b, with #names resolved through
        // ExpressionAttributeNames.
        const next = { ...(item ?? { spaceURL: { S: key } }) };
        const names = input.ExpressionAttributeNames ?? {};
        const attr = (token) => names[token] ?? token;
        const [verb, rest] = input.UpdateExpression.split(/\s+(.*)/s);
        for (const clause of rest.split(",").map((c) => c.trim())) {
          if (verb === "REMOVE") {
            delete next[attr(clause)];
          } else {
            const [lhs, rhs] = clause.split("=").map((c) => c.trim());
            next[attr(lhs)] = input.ExpressionAttributeValues[rhs];
          }
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

// The metrics the quota watch publishes.
export class FakeCloudWatch {
  metrics = [];

  async send(command) {
    if (command.constructor.name === "PutMetricDataCommand") {
      this.metrics.push(...command.input.MetricData.map((datum) => ({ namespace: command.input.Namespace, ...datum })));
      return {};
    }
    throw new Error(`FakeCloudWatch: unsupported command ${command.constructor.name}`);
  }
}

// Installs fresh fakes and returns them.
export function installFakes() {
  const fakeS3 = new FakeS3();
  const fakeDynamo = new FakeDynamo();
  const fakeSqs = new FakeSqs();
  const fakeCloudWatch = new FakeCloudWatch();
  s3.S3Client.prototype.send = (command) => fakeS3.send(command);
  ddb.DynamoDBClient.prototype.send = (command) => fakeDynamo.send(command);
  authorizerDdb.DynamoDBClient.prototype.send = (command) => fakeDynamo.send(command);
  sqs.SQSClient.prototype.send = (command) => fakeSqs.send(command);
  cloudwatch.CloudWatchClient.prototype.send = (command) => fakeCloudWatch.send(command);
  return { s3: fakeS3, dynamo: fakeDynamo, sqs: fakeSqs, cloudwatch: fakeCloudWatch };
}
