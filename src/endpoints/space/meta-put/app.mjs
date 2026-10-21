import { DynamoDBClient, PutItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { CreateBucketCommand } from "@aws-sdk/client-s3";
import * as webvhDriver from "@interop/did-method-webvh";
import { handler } from "was-lib/handler.mjs";
import { json, parseJsonBody, preconditions, NO_STORE } from "was-lib/http.mjs";
import { readSpaceMeta, writeSpaceMeta, now, stripServerManaged, typesOf } from "was-lib/meta.mjs";
import { s3, bucketOf } from "was-lib/store.mjs";
import { isSelfProvisionedSpaceId } from "was-lib/ids.mjs";
import { controllerMismatch, invalidRequestBody, notFound } from "was-lib/problems.mjs";
import { deriveSpaceId, invokerKeyListed, isWebvhDid, resolveWebvhDocument } from "was-lib/webvh.mjs";

// PUT /space/{s}/meta -- a full replacement of the writable members, under
// If-Match / If-None-Match. `type` is write-once, and the name is mirrored
// to the registry row so listings can show it. Root capability only (the
// container rule).
//
// Two cases beyond the plain replacement:
//
//   - Provisioning an unlock Space. A PUT on a Space the registry does not
//     hold, whose id is was-client's `deriveSpaceId` over the signing did:key
//     and whose body names that did:key as controller with `UnlockSpace` in
//     its type, creates the Space (bucket, metadata, registry row). No
//     coupon: the id is bound to the key, so nothing else can be claimed.
//   - Promoting the controller. A body naming a did:webvh as controller,
//     where the Space's controller is a did:key, is accepted when the
//     did:webvh's current document lists the invoking key under
//     capabilityInvocation. From then on only keys in that document may
//     invoke. Any other controller change is refused.

const dynamo = new DynamoDBClient({});
const SPACES_TABLE = process.env.SPACES_TABLE_NAME ?? "wallet-spaces";
const SPACE_URL_BASE = (process.env.SPACE_URL_BASE ?? "https://was.example.org/space").replace(/\/+$/, "");
const UNLOCK_TYPE = "UnlockSpace";

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

async function setController(registryUrl, controller) {
  await dynamo.send(
    new UpdateItemCommand({
      TableName: SPACES_TABLE,
      Key: { spaceURL: { S: registryUrl } },
      UpdateExpression: "SET did = :did",
      ExpressionAttributeValues: { ":did": { S: controller } },
    })
  );
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

function validateBody(req, spaceId) {
  const body = parseJsonBody(req, { problem: invalidRequestBody });
  if (body.id !== undefined && body.id !== spaceId) {
    throw invalidRequestBody('"id" does not match the Space addressed by the URL.');
  }
  if (body.name !== undefined && typeof body.name !== "string") {
    throw invalidRequestBody('"name" must be a string.');
  }
  if (body.controller !== undefined && typeof body.controller !== "string") {
    throw invalidRequestBody('"controller" must be a DID.');
  }
  return body;
}

async function provisionUnlockSpace(req, { spaceId }, body) {
  const invoker = req.auth.controller;
  const controller = body.controller?.split("#")[0];
  if (!isSelfProvisionedSpaceId(spaceId) || spaceId !== deriveSpaceId(invoker)) {
    throw notFound();
  }
  if (controller !== invoker) {
    throw controllerMismatch("An unlock Space's controller is the DID its id is derived from.");
  }
  const type = typesOf(body, "Space");
  if (!type.includes(UNLOCK_TYPE)) {
    throw invalidRequestBody(`A self-provisioned Space must carry "${UNLOCK_TYPE}" in its type.`);
  }
  const stamp = now();
  const doc = {
    ...stripServerManaged(body),
    id: spaceId,
    type,
    controller,
    createdBy: controller,
    createdAt: stamp,
    updatedAt: stamp,
  };
  await s3.send(new CreateBucketCommand({ Bucket: bucketOf(spaceId) }));
  const written = await writeSpaceMeta(req, spaceId, doc, preconditions(req));
  await registerSpace({ url: `${SPACE_URL_BASE}/${spaceId}`, controller, type, name: doc.name, createdAt: stamp });
  return json(req, 201, written.doc, { ...NO_STORE, ETag: written.etag });
}

// The controller the written document carries: unchanged, or promoted.
async function resolveController(req, body) {
  const current = req.auth.spaceController;
  const requested = body.controller?.split("#")[0];
  if (requested === undefined || requested === current) {
    return current;
  }
  if (!isWebvhDid(requested) || isWebvhDid(current)) {
    throw controllerMismatch("The controller of a Space can only be promoted from a did:key to a did:webvh.");
  }
  const doc = await resolveWebvhDocument(requested, { driver: webvhDriver });
  if (!doc) {
    throw controllerMismatch(`${requested} does not resolve.`);
  }
  if (!invokerKeyListed(doc, req.auth.controller)) {
    throw controllerMismatch("The invoking key is not a capability key of the requested controller.");
  }
  return requested;
}

export const lambdaHandler = handler(
  async (req, route) => {
    const { spaceId, registryUrl } = route;
    const body = validateBody(req, spaceId);
    if (route.unregistered) {
      return provisionUnlockSpace(req, route, body);
    }
    const controller = await resolveController(req, body);
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
      controller,
      createdBy: current?.doc?.createdBy ?? req.auth.spaceController,
      createdAt: current?.doc?.createdAt ?? stamp,
      updatedAt: stamp,
    };
    const written = await writeSpaceMeta(req, spaceId, doc, preconditions(req));
    if (controller !== req.auth.spaceController) {
      await setController(registryUrl, controller);
    }
    await mirrorName(registryUrl, doc.name);
    return json(req, current === null ? 201 : 200, written.doc, { ...NO_STORE, ETag: written.etag });
  },
  { scope: "space-meta", rootOnly: true, selfProvision: true }
);
