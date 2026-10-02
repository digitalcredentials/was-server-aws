// The space registry endpoints of the Wallet Attached Storage spec
// (https://w3c-ccg.github.io/wallet-attached-storage-spec/):
//
//   POST /spaces          provision a space  {controller, type, name?, coupon}
//   GET  /spaces          list the caller's spaces
//
// Per the spec, a POST must carry the new space's `controller` DID in the
// body and be authorized by that DID: the request is a zcap invocation of its
// own URL signed by the controller's key (see verify.mjs). Creation is
// further restricted by a coupon, redeemed from the was-coupons table (with
// optional usesRemaining and expiresAt). The server knows nothing about
// wallet accounts: registry rows are keyed to the controller DID alone. A GET
// self-authenticates: the invocation must verify against the DID that signed
// it, and the response lists the spaces registered to that DID.
//
// DELETE is spec-shaped too, but lives at /space/{space_id} (src/spaces/
// delete), where the standard authorizer verifies the space's controller.
//
// Must be evaluated before @interop/jsonld (CJS) is pulled in below, which
// require()s this ESM package mid-graph and hits a TDZ error otherwise.
import "@interop/http-client";
import { randomUUID } from "node:crypto";
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand
} from "@aws-sdk/client-dynamodb";
import { S3Client, CreateBucketCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { verifyInvocation } from "./verify.mjs";

const dynamoClient = new DynamoDBClient();
const s3 = new S3Client();

const SPACES_TABLE = process.env.SPACES_TABLE_NAME ?? "wallet-spaces";
const COUPONS_TABLE = process.env.COUPONS_TABLE_NAME ?? "was-coupons";
const SPACE_URL_BASE = (process.env.SPACE_URL_BASE ?? "https://was.example.org/space").replace(/\/+$/, "");

const SPACE_TYPES = new Set(["credential", "batch"]);

const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body)
});

// The registry holds authorization and lookup data only; a space's display
// name lives in its WAS description document.
function spaceFromItem(item) {
  return {
    url: item.spaceURL?.S,
    type: item.type?.S,
    createdAt: item.CreatedAt?.S
  };
}

// Redeems a coupon from the coupons table: the row must exist, must not be
// expired (expiresAt, absent = never), and must have uses left (usesRemaining,
// absent = unlimited). A finite coupon is decremented with a conditional
// update, so concurrent redemptions cannot overspend it. Returns true when
// the coupon was redeemed.
async function redeemCoupon(coupon) {
  if (!coupon || typeof coupon !== "string") {
    return false;
  }
  const { Item: row } = await dynamoClient.send(new GetItemCommand({
    TableName: COUPONS_TABLE,
    Key: { coupon: { S: coupon } }
  }));
  if (!row) {
    return false;
  }
  const expiresAt = row.expiresAt?.S;
  if (expiresAt && expiresAt <= new Date().toISOString()) {
    return false;
  }
  if (row.usesRemaining === undefined) {
    return true;
  }
  try {
    await dynamoClient.send(new UpdateItemCommand({
      TableName: COUPONS_TABLE,
      Key: { coupon: { S: coupon } },
      UpdateExpression: "SET usesRemaining = usesRemaining - :one",
      ConditionExpression: "usesRemaining > :zero",
      ExpressionAttributeValues: { ":one": { N: "1" }, ":zero": { N: "0" } }
    }));
    return true;
  } catch (error) {
    if (error.name === "ConditionalCheckFailedException") {
      return false;
    }
    throw error;
  }
}

async function createSpace({ controller, type, name }) {
  const bucketName = `dcc-was-${randomUUID()}`;
  const spaceURL = `${SPACE_URL_BASE}/${bucketName}`;
  const spaceName = name || `My ${type} space`;

  await s3.send(new CreateBucketCommand({ Bucket: bucketName }));
  // The space description, read back from metadata/description.json (same
  // seed shape as the wallet-account-creator state machine writes).
  await s3.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: "metadata/description.json",
    ContentType: "application/json",
    Body: JSON.stringify({
      name: spaceName,
      type: ["Space"],
      controller,
      createdBy: controller
    })
  }));
  // Registry rows are keyed to the controller DID alone; the server knows
  // nothing about wallet accounts.
  await dynamoClient.send(new PutItemCommand({
    TableName: SPACES_TABLE,
    Item: {
      spaceURL: { S: spaceURL },
      did: { S: controller },
      type: { S: type },
      CreatedAt: { S: new Date().toISOString() }
    }
  }));
  return { space: spaceURL, type, name: spaceName };
}

async function listSpaces({ did }) {
  const { Items: items = [] } = await dynamoClient.send(new QueryCommand({
    TableName: SPACES_TABLE,
    IndexName: "by-did",
    KeyConditionExpression: "did = :did",
    ExpressionAttributeValues: { ":did": { S: did } }
  }));
  return { spaces: items.map(spaceFromItem) };
}

// The DID whose key signed the invocation, from the http-signature header's
// keyId (a did:key URL like did:key:z6Mk...#z6Mk...). Verification against
// this DID still has to pass before it is trusted.
function signerDid(event) {
  const authorization = Object.entries(event.headers ?? {}).find(
    ([name]) => name.toLowerCase() === "authorization"
  )?.[1];
  const keyId = authorization?.match(/keyId="([^"]+)"/)?.[1];
  return keyId?.startsWith("did:key:") ? keyId.split("#")[0] : undefined;
}

export const lambdaHandler = async (event) => {
  const method = event.requestContext?.http?.method;

  if (method === "POST") {
    let body;
    try {
      const rawBody = event.isBase64Encoded
        ? Buffer.from(event.body ?? "", "base64").toString("utf8")
        : event.body;
      body = JSON.parse(rawBody ?? "{}");
    } catch {
      return json(400, { error: "Request body must be valid JSON." });
    }

    const { controller, type, name, coupon } = body;
    if (!controller || typeof controller !== "string" || !controller.startsWith("did:")) {
      return json(400, { error: "controller must be a DID." });
    }
    if (!SPACE_TYPES.has(type)) {
      return json(400, { error: `type must be one of: ${[...SPACE_TYPES].join(", ")}` });
    }

    // The spec requires the request to be authorized by the body's controller.
    if (!(await verifyInvocation({ event, did: controller.split("#")[0] }))) {
      return json(401, { error: "Unauthorized." });
    }

    // Space creation requires redeeming a coupon from the coupons table.
    try {
      if (!(await redeemCoupon(coupon))) {
        return json(403, { error: "A valid coupon is required to create a space." });
      }
    } catch (error) {
      console.error("Error redeeming coupon:", error);
      return json(500, { error: "Server error." });
    }

    try {
      return json(201, await createSpace({ controller: controller.split("#")[0], type, name }));
    } catch (error) {
      console.error(`Space creation failed for ${controller}:`, error);
      return json(500, { error: "Server error." });
    }
  }

  if (method === "GET") {
    // Per the spec, listing returns the spaces the caller is authorized to
    // access: the caller self-authenticates (the invocation must verify
    // against the DID that signed it) and gets the spaces registered to that
    // DID. No account lookup, no email parameter.
    const did = signerDid(event);
    if (!did || !(await verifyInvocation({ event, did }))) {
      return json(401, { error: "Unauthorized." });
    }

    try {
      return json(200, await listSpaces({ did }));
    } catch (error) {
      console.error(`Space listing failed for ${did}:`, error);
      return json(500, { error: "Server error." });
    }
  }

  return json(405, { error: "Method not allowed." });
};
