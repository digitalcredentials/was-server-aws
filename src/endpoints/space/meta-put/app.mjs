import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { handler } from "was-lib/handler.mjs";
import { json, parseJsonBody, preconditions, NO_STORE } from "was-lib/http.mjs";
import { readSpaceMeta, writeSpaceMeta, now, stripServerManaged } from "was-lib/meta.mjs";
import { controllerMismatch, invalidRequestBody } from "was-lib/problems.mjs";

// PUT /space/{s}/meta -- a full replacement of the writable members, under
// If-Match / If-None-Match. The controller is fixed, `type` is write-once,
// and the name is mirrored to the registry row so listings can show it.
// Root capability only (the container rule).

const dynamo = new DynamoDBClient({});
const SPACES_TABLE = process.env.SPACES_TABLE_NAME ?? "wallet-spaces";

async function mirrorName(registryUrl, name) {
  await dynamo.send(
    new UpdateItemCommand({
      TableName: SPACES_TABLE,
      Key: { spaceURL: { S: registryUrl } },
      ...(name === undefined
        ? { UpdateExpression: "REMOVE #name" }
        : {
            UpdateExpression: "SET #name = :name",
            ExpressionAttributeValues: { ":name": { S: name } },
          }),
      ExpressionAttributeNames: { "#name": "name" },
    })
  );
}

export const lambdaHandler = handler(
  async (req, { spaceId, registryUrl }) => {
    const spaceController = req.auth.spaceController;
    const body = parseJsonBody(req, { problem: invalidRequestBody });
    if (body.id !== undefined && body.id !== spaceId) {
      throw invalidRequestBody('"id" does not match the Space addressed by the URL.');
    }
    if (body.controller !== undefined && body.controller.split("#")[0] !== spaceController) {
      throw controllerMismatch("The controller of a Space cannot be changed on this server.");
    }
    if (body.name !== undefined && typeof body.name !== "string") {
      throw invalidRequestBody('"name" must be a string.');
    }
    const current = await readSpaceMeta(req, spaceId);
    const storedType = current?.doc?.type ?? JSON.parse(req.auth.spaceType || '["Space"]');
    if (body.type !== undefined) {
      const given = Array.isArray(body.type) ? body.type : [body.type];
      if (JSON.stringify(given) !== JSON.stringify(storedType)) {
        throw invalidRequestBody('"type" is write-once and cannot be changed.');
      }
    }
    const stamp = now();
    const fields = stripServerManaged(body);
    delete fields.controller;
    const doc = {
      ...fields,
      id: spaceId,
      type: storedType,
      controller: spaceController,
      createdBy: current?.doc?.createdBy ?? spaceController,
      createdAt: current?.doc?.createdAt ?? stamp,
      updatedAt: stamp,
    };
    const written = await writeSpaceMeta(req, spaceId, doc, preconditions(req));
    await mirrorName(registryUrl, doc.name);
    return json(req, current === null ? 201 : 200, written.doc, { ...NO_STORE, ETag: written.etag });
  },
  { scope: "space-meta", rootOnly: true }
);
