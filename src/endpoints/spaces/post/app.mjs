import { randomUUID } from "node:crypto";
import { DynamoDBClient, GetItemCommand, PutItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { CreateBucketCommand, PutBucketNotificationConfigurationCommand } from "@aws-sdk/client-s3";
import { plainHandler } from "was-lib/handler.mjs";
import { json, parseJsonBody, NO_STORE } from "was-lib/http.mjs";
import { verifyDigest } from "was-lib/auth.mjs";
import { s3, bucketOf } from "was-lib/store.mjs";
import { now, spaceUrl, typesOf, writeSpaceMeta } from "was-lib/meta.mjs";
import { isReservedSpaceId, isValidSpaceId } from "was-lib/ids.mjs";
import { HttpProblem, idConflict, invalidId, invalidRequestBody, notFound, reservedId } from "was-lib/problems.mjs";

// POST /spaces/ -- provision a Space. Per the spec the request must be
// authorized by the `controller` DID in the body: the authorizer verified
// the invocation against the DID that signed it, and that DID must be the
// stated controller. This server additionally requires a coupon. The id is
// server-assigned (`dcc-was-{uuid}`, also the bucket name) unless the body
// names one: a wallet built on wallet-core mints its account Space's id
// before genesis, redeems the coupon here with that id, and genesis then
// finds the Space in place (its provisioning step is an ensure). A client
// id maps to its bucket through `bucketOf`, and an id already in use is a
// conflict. The bucket is created with its metadata object and the Space
// registered.
//
// The registry row (the was-spaces table, keyed by space URL without a
// trailing slash, with a by-did index) holds authorization and lookup data
// only: the controller DID, the type array, the name (mirrored for
// listings) and the creation time.

const dynamo = new DynamoDBClient({});
const SPACES_TABLE = process.env.SPACES_TABLE_NAME ?? "was-spaces";
const COUPONS_TABLE = process.env.COUPONS_TABLE_NAME ?? "was-coupons";
const SPACE_URL_BASE = (process.env.SPACE_URL_BASE ?? "https://was.example.org/space").replace(/\/+$/, "");

const couponRequired = () =>
  new HttpProblem({
    status: 403,
    type: "https://github.com/digitalcredentials/was-server-aws#coupon-required",
    title: "Coupon required",
    detail: "Space creation requires a valid coupon.",
  });

// Redeems a coupon: the row must exist, must not be expired (expiresAt,
// absent = never), and must have uses left (usesRemaining, absent =
// unlimited). A finite coupon is decremented with a conditional update, so
// concurrent redemptions cannot overspend it.
async function redeemCoupon(coupon) {
  if (!coupon || typeof coupon !== "string") {
    return false;
  }
  const { Item: row } = await dynamo.send(
    new GetItemCommand({ TableName: COUPONS_TABLE, Key: { coupon: { S: coupon } } })
  );
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
    await dynamo.send(
      new UpdateItemCommand({
        TableName: COUPONS_TABLE,
        Key: { coupon: { S: coupon } },
        UpdateExpression: "SET usesRemaining = usesRemaining - :one",
        ConditionExpression: "usesRemaining > :zero",
        ExpressionAttributeValues: { ":one": { N: "1" }, ":zero": { N: "0" } },
      })
    );
    return true;
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      return false;
    }
    throw err;
  }
}

async function registerSpace({ url, controller, type, name, createdAt }) {
  try {
    await dynamo.send(
      new PutItemCommand({
        TableName: SPACES_TABLE,
        Item: {
          spaceURL: { S: url },
          did: { S: controller },
          type: { L: type.map((entry) => ({ S: entry })) },
          ...(name !== undefined && { name: { S: name } }),
          CreatedAt: { S: createdAt },
          // A coupon was spent: outside the cap on coupon-less Spaces
          provisioning: { S: "coupon" },
        },
        ConditionExpression: "attribute_not_exists(spaceURL)",
      })
    );
  } catch (err) {
    if (err?.name === "ConditionalCheckFailedException") {
      throw idConflict("A Space with this id already exists.");
    }
    throw err;
  }
}

async function isRegistered(url) {
  const { Item } = await dynamo.send(new GetItemCommand({ TableName: SPACES_TABLE, Key: { spaceURL: { S: url } } }));
  return Boolean(Item);
}

// The id the Space gets: the client's, when the body names one it may
// choose (a valid id form, not reserved, not in use), else a fresh
// server-assigned one.
async function chooseSpaceId(id) {
  if (id === undefined) {
    return { spaceId: `dcc-was-${randomUUID()}`, chosen: false };
  }
  if (typeof id !== "string" || !isValidSpaceId(id)) {
    throw invalidId("A Space id must be a server-assigned id or 43 URL-safe characters.");
  }
  if (isReservedSpaceId(id)) {
    throw reservedId(id);
  }
  if (await isRegistered(`${SPACE_URL_BASE}/${id}`)) {
    throw idConflict("A Space with this id already exists.");
  }
  return { spaceId: id, chosen: true };
}

export const lambdaHandler = plainHandler(async (req) => {
  // The gateway routes /spaces/{anything} here too; only /spaces/ is the
  // repository.
  if (req.ids.length !== 1 || req.ids[0] !== "spaces") {
    throw notFound();
  }
  const body = parseJsonBody(req, { problem: invalidRequestBody });
  const { controller, name, coupon, id } = body;
  if (typeof controller !== "string" || !controller.startsWith("did:key:")) {
    throw invalidRequestBody('"controller" must be a did:key DID.');
  }
  if (name !== undefined && typeof name !== "string") {
    throw invalidRequestBody('"name" must be a string.');
  }
  const type = typesOf(body, "Space");
  const controllerDid = controller.split("#")[0];

  if (req.auth.verified !== "true" || req.auth.controller !== controllerDid) {
    throw invalidRequestBody("The request is not authorized by the stated controller.");
  }
  verifyDigest(req);

  // The id is settled before the coupon is spent, so a conflict costs
  // nothing; two requests racing for one id are caught by the metadata
  // object's If-None-Match and the registry row's condition below
  const { spaceId, chosen } = await chooseSpaceId(id);
  if (!(await redeemCoupon(coupon))) {
    throw couponRequired();
  }

  const stamp = now();
  const doc = {
    id: spaceId,
    type,
    ...(name !== undefined && { name }),
    controller: controllerDid,
    createdBy: controllerDid,
    createdAt: stamp,
    updatedAt: stamp,
  };
  const bucket = bucketOf(spaceId);
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  // The bucket's object events feed the Collections' `changes` feeds
  await s3.send(new PutBucketNotificationConfigurationCommand({ Bucket: bucket, NotificationConfiguration: { EventBridgeConfiguration: {} } }));
  let written;
  try {
    written = await writeSpaceMeta(req, spaceId, doc, chosen ? { ifNoneMatch: "*" } : {});
  } catch (err) {
    if (err instanceof HttpProblem && err.status === 412) {
      throw idConflict("A Space with this id already exists.");
    }
    throw err;
  }
  await registerSpace({ url: `${SPACE_URL_BASE}/${spaceId}`, controller: controllerDid, type, name, createdAt: stamp });

  return json(req, 201, written.doc, {
    ...NO_STORE,
    Location: spaceUrl(req, spaceId),
    ETag: written.etag,
  });
});
