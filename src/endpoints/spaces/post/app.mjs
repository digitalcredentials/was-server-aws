import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { plainHandler } from "was-lib/handler.mjs";
import { json, parseJsonBody, NO_STORE } from "was-lib/http.mjs";
import { verifyDigest } from "was-lib/auth.mjs";
import { spaceUrl } from "was-lib/meta.mjs";
import { HttpProblem, invalidRequestBody, notFound } from "was-lib/problems.mjs";
import { chooseSpaceId, provisionSpace, spaceRequestOf } from "was-lib/provision.mjs";

// POST /spaces/ -- provision an account Space. Per the spec the request must
// be authorized by the `controller` DID in the body: the authorizer verified
// the invocation against the DID that signed it, and that DID must be the
// stated controller. This server additionally requires a coupon (a
// registration code), and the Space it creates is an account Space: the
// one Space of an account that a code is spent on. Every further Space of
// the account is created under it, at POST /space/{s}/spaces, with no
// coupon (src/endpoints/space/spaces-post).
//
// The id is server-assigned (`dcc-pws-{uuid}`, also the bucket name) unless
// the body names one: a wallet built on wallet-core mints its account
// Space's id before genesis, redeems the coupon here with that id, and
// genesis then finds the Space in place (its provisioning step is an
// ensure). A client id maps to its bucket through `bucketOf`, and an id
// already in use is a conflict. The bucket is created with its metadata
// object and the Space registered (was-lib/provision.mjs).
//
// The registry row (the pws-spaces table, keyed by space URL without a
// trailing slash, with a by-did index) holds authorization and lookup data
// only: the controller DID, the type array, the name (mirrored for
// listings), the creation time and how the Space was provisioned
// (`coupon` here, which is what makes it an account Space).

const dynamo = new DynamoDBClient({});
const COUPONS_TABLE = process.env.COUPONS_TABLE_NAME ?? "pws-coupons";

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
// concurrent redemptions cannot overspend it. One use is one account.
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

export const lambdaHandler = plainHandler(async (req) => {
  // The gateway routes /spaces/{anything} here too; only /spaces/ is the
  // repository.
  if (req.ids.length !== 1 || req.ids[0] !== "spaces") {
    throw notFound();
  }
  const body = parseJsonBody(req, { problem: invalidRequestBody });
  const { controller, name, type, id } = spaceRequestOf(body);

  if (req.auth.verified !== "true" || req.auth.controller !== controller) {
    throw invalidRequestBody("The request is not authorized by the stated controller.");
  }
  verifyDigest(req);

  // The id is settled before the coupon is spent, so a conflict costs
  // nothing
  const { spaceId, chosen } = await chooseSpaceId(id);
  if (!(await redeemCoupon(body.coupon))) {
    throw couponRequired();
  }

  // A coupon was spent: an account Space, outside the cap on coupon-less
  // Spaces
  const written = await provisionSpace(req, { spaceId, chosen, controller, name, type, provisioning: "coupon" });

  return json(req, 201, written.doc, {
    ...NO_STORE,
    Location: spaceUrl(req, spaceId),
    ETag: written.etag,
  });
});
