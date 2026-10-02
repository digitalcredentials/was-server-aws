// The space registry endpoints of the Wallet Attached Storage spec
// (https://w3c-ccg.github.io/wallet-attached-storage-spec/):
//
//   POST /spaces          provision a space  {controller, email, type, name?, coupon}
//   GET  /spaces?email=.. list the account's spaces
//
// Per the spec, a POST must carry the new space's `controller` DID in the
// body and be authorized by that DID: the request is a zcap invocation of its
// own URL signed by the controller's key (see verify.mjs). Creation is
// further restricted by a coupon, redeemed from the was-coupons table (with
// optional usesRemaining and expiresAt); the controller must also be the DID
// registered for the account. A GET must be signed by the DID registered for
// the account.
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

const ACCOUNTS_TABLE = process.env.ACCOUNTS_TABLE_NAME ?? "wallet-test";
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

async function getAccount(email) {
  const { Item: account } = await dynamoClient.send(new GetItemCommand({
    TableName: ACCOUNTS_TABLE,
    Key: { email: { S: email } }
  }));
  return account;
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

async function createSpace({ email, controller, type, name }) {
  const bucketName = `dcc-was-${randomUUID()}`;
  const spaceURL = `${SPACE_URL_BASE}/${bucketName}`;
  const spaceName = name || `${email}'s ${type} space`;

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
  await dynamoClient.send(new PutItemCommand({
    TableName: SPACES_TABLE,
    Item: {
      spaceURL: { S: spaceURL },
      email: { S: email },
      did: { S: controller },
      type: { S: type },
      CreatedAt: { S: new Date().toISOString() }
    }
  }));
  return { space: spaceURL, type, name: spaceName };
}

async function listSpaces({ email }) {
  const { Items: items = [] } = await dynamoClient.send(new QueryCommand({
    TableName: SPACES_TABLE,
    IndexName: "by-email",
    KeyConditionExpression: "email = :email",
    ExpressionAttributeValues: { ":email": { S: email } }
  }));
  return { spaces: items.map(spaceFromItem) };
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

    const { controller, email, type, name, coupon } = body;
    if (!controller || typeof controller !== "string" || !controller.startsWith("did:")) {
      return json(400, { error: "controller must be a DID." });
    }
    if (!email) {
      return json(400, { error: "Missing email." });
    }
    if (!SPACE_TYPES.has(type)) {
      return json(400, { error: `type must be one of: ${[...SPACE_TYPES].join(", ")}` });
    }

    // The spec requires the request to be authorized by the body's controller.
    if (!(await verifyInvocation({ event, did: controller.split("#")[0] }))) {
      return json(401, { error: "Unauthorized." });
    }

    // The controller must be the DID registered for the account, so a leaked
    // coupon alone cannot register spaces under someone else's email.
    let account;
    try {
      account = await getAccount(email);
    } catch (error) {
      console.error("Error looking up account:", error);
      return json(500, { error: "Server error." });
    }
    const registeredDid = account?.did?.S?.split("#")[0];
    if (!registeredDid || registeredDid !== controller.split("#")[0]) {
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
      return json(201, await createSpace({ email, controller: controller.split("#")[0], type, name }));
    } catch (error) {
      console.error(`Space creation failed for ${email}:`, error);
      return json(500, { error: "Server error." });
    }
  }

  if (method === "GET") {
    const email = event.queryStringParameters?.email;
    if (!email) {
      return json(400, { error: "Missing email." });
    }

    // Listing is authorized by the DID registered for the account; the email
    // is in the query string, which the signed URL covers.
    let account;
    try {
      account = await getAccount(email);
    } catch (error) {
      console.error("Error looking up account:", error);
      return json(500, { error: "Server error." });
    }
    // Stored DIDs may carry a key fragment (did:key:z6Mk...#z6Mk...)
    const registeredDid = account?.did?.S?.split("#")[0];
    if (!registeredDid || !(await verifyInvocation({ event, did: registeredDid }))) {
      return json(401, { error: "Unauthorized." });
    }

    try {
      return json(200, await listSpaces({ email }));
    } catch (error) {
      console.error(`Space listing failed for ${email}:`, error);
      return json(500, { error: "Server error." });
    }
  }

  return json(405, { error: "Method not allowed." });
};
