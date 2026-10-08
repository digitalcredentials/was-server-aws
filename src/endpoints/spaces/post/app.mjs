import { randomUUID } from "node:crypto";
import { DynamoDBClient, GetItemCommand, PutItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { CreateBucketCommand } from "@aws-sdk/client-s3";
import { plainHandler } from "was-lib/handler.mjs";
import { json, parseJsonBody, NO_STORE } from "was-lib/http.mjs";
import { verifyDigest } from "was-lib/auth.mjs";
import { s3 } from "was-lib/store.mjs";
import { now, spaceUrl, typesOf, writeSpaceMeta } from "was-lib/meta.mjs";
import { HttpProblem, invalidRequestBody, notFound } from "was-lib/problems.mjs";

// POST /spaces/ -- provision a Space. Per the spec the request must be
// authorized by the `controller` DID in the body: the authorizer verified
// the invocation against the DID that signed it, and that DID must be the
// stated controller. This server additionally requires a coupon. The id is
// server-assigned (also the bucket name); the bucket is created with its
// metadata object and the Space registered.
//
// The registry row (the wallet-spaces table, keyed by space URL without a
// trailing slash, with a by-did index) holds authorization and lookup data
// only: the controller DID, the type array, the name (mirrored for
// listings) and the creation time.

const dynamo = new DynamoDBClient({});
const SPACES_TABLE = process.env.SPACES_TABLE_NAME ?? "wallet-spaces";
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
  await dynamo.send(
    new PutItemCommand({
      TableName: SPACES_TABLE,
      Item: {
        spaceURL: { S: url },
        did: { S: controller },
        type: { L: type.map((entry) => ({ S: entry })) },
        ...(name !== undefined && { name: { S: name } }),
        CreatedAt: { S: createdAt },
      },
    })
  );
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
  if (id !== undefined) {
    throw invalidRequestBody('Space ids are assigned by this server; omit "id".');
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

  if (!(await redeemCoupon(coupon))) {
    throw couponRequired();
  }

  const spaceId = `dcc-was-${randomUUID()}`;
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
  await s3.send(new CreateBucketCommand({ Bucket: spaceId }));
  const written = await writeSpaceMeta(req, spaceId, doc);
  await registerSpace({ url: `${SPACE_URL_BASE}/${spaceId}`, controller: controllerDid, type, name, createdAt: stamp });

  return json(req, 201, written.doc, {
    ...NO_STORE,
    Location: spaceUrl(req, spaceId),
    ETag: written.etag,
  });
});
