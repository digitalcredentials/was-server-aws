import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import { plainHandler } from "was-lib/handler.mjs";
import { json } from "was-lib/http.mjs";
import { spaceUrl } from "was-lib/meta.mjs";
import { invalidCursor, notFound } from "was-lib/problems.mjs";
import { pageLimit, nextLink } from "was-lib/ops/listing.mjs";

// GET /spaces/ -- the Spaces registered to the DID that signed the request
// (the authorizer verified the invocation against it), from the registry's
// by-did index, paged. Per the spec a listing never errors on
// authorization: an unsigned or unverifiable caller gets the subset it may
// see, which is nothing.

const dynamo = new DynamoDBClient({});
const SPACES_TABLE = process.env.SPACES_TABLE_NAME ?? "wallet-spaces";

// Older rows carry the string 'credential' or 'batch'; they read as
// ['Space'] / ['Space', 'BatchSpace'].
function typesFromItem(item) {
  if (item.type?.L) {
    return item.type.L.map((entry) => entry.S).filter(Boolean);
  }
  if (item.type?.S === "batch") {
    return ["Space", "BatchSpace"];
  }
  return ["Space"];
}

// The cursor is the page's last evaluated key, encoded.
const encodeCursor = (key) => Buffer.from(JSON.stringify(key)).toString("base64url");

function decodeCursor(cursor) {
  try {
    const key = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof key !== "object" || key === null) {
      throw new Error("not an object");
    }
    return key;
  } catch {
    throw invalidCursor("The cursor was not issued by this listing.");
  }
}

export const lambdaHandler = plainHandler(async (req) => {
  if (req.ids.length !== 1 || req.ids[0] !== "spaces") {
    throw notFound();
  }
  const url = `${req.base}/spaces/`;
  if (req.auth.verified !== "true" || !req.auth.controller) {
    return json(req, 200, { url, totalItems: 0, items: [] });
  }
  const limit = pageLimit(req);
  const { Items = [], LastEvaluatedKey } = await dynamo.send(
    new QueryCommand({
      TableName: SPACES_TABLE,
      IndexName: "by-did",
      KeyConditionExpression: "did = :did",
      ExpressionAttributeValues: { ":did": { S: req.auth.controller } },
      Limit: limit,
      ...(req.query.cursor !== undefined && { ExclusiveStartKey: decodeCursor(req.query.cursor) }),
    })
  );
  const items = Items.map((item) => {
    const id = item.spaceURL?.S?.split("/").pop();
    return {
      id,
      url: spaceUrl(req, id),
      ...(item.name?.S !== undefined && { name: item.name.S }),
      type: typesFromItem(item),
      ...(item.CreatedAt?.S && { createdAt: item.CreatedAt.S }),
    };
  });
  return json(req, 200, {
    url,
    totalItems: items.length,
    items,
    ...(LastEvaluatedKey && { next: nextLink(url, encodeCursor(LastEvaluatedKey), limit) }),
  });
});
