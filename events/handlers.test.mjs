// In-process tests for every route handler, driven by the same proxy events
// the static fixtures are generated from. No Docker, no AWS: S3Client's send
// is stubbed per test.
//
//   cd events && npm test
//
// In Lambda the nodejs runtime provides @aws-sdk/client-s3; locally the
// handlers resolve it from the repo root node_modules (a devDependency of the
// root package.json). This file resolves that same copy, so replacing
// S3Client.prototype.send intercepts every handler's S3 traffic.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

import {
  proxyEvent,
  routes,
  SPACE_ID,
  COLLECTION_ID,
  RESOURCE_ID,
} from "./routes.mjs";

import { lambdaHandler as spaceDescriptionGet } from "../src/spaces/description/get/app.mjs";
import { lambdaHandler as spaceCollectionsListGet } from "../src/spaces/get/app.mjs";
import { lambdaHandler as collectionGet } from "../src/collections/get/app.mjs";
import { lambdaHandler as collectionPut } from "../src/collections/put/app.mjs";
import { lambdaHandler as resourcePut } from "../src/resources/put/app.mjs";
import { lambdaHandler as resourceGet } from "../src/resources/get/app.mjs";
import { lambdaHandler as resourceDelete } from "../src/resources/delete/app.mjs";

const AUTH = {
  controller: "did:key:z6MkuoW15WTT6ty3coLfS294WKdndim1fteTWK76dMGVUUxk",
  capability: "urn:zcap:root:test",
};

// Each test assigns onSend; a handler that touches S3 when the test expects
// none trips the default.
let onSend;
beforeEach(() => {
  onSend = (command) => {
    throw new Error(`unexpected S3 call: ${command.constructor.name}`);
  };
});
S3Client.prototype.send = async (command) => onSend(command);

function s3Error(name) {
  const err = new Error(name);
  err.name = name;
  return err;
}

// A GetObject result the way the SDK shapes it.
function s3Object(content, { ContentType, ETag } = {}) {
  return {
    Body: { transformToString: async () => content },
    ...(ContentType && { ContentType }),
    ...(ETag && { ETag }),
  };
}

function event(name, overrides = {}) {
  return { ...proxyEvent(routes[name], AUTH), ...overrides };
}

// GET /space/{space_id} - space description

test("space description GET: merges stored description with derived fields", async () => {
  onSend = (command) => {
    assert.ok(command instanceof GetObjectCommand);
    assert.equal(command.input.Bucket, SPACE_ID);
    assert.equal(command.input.Key, "metadata/description.json");
    return s3Object(JSON.stringify({ name: "My space", id: "stale", url: "stale" }));
  };
  const res = await spaceDescriptionGet(event("space-description-get"));
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.name, "My space");
  assert.equal(body.id, SPACE_ID);
  assert.equal(body.url, `/space/${SPACE_ID}`);
  assert.deepEqual(body.type, ["Space"]);
  assert.equal(body.linkset, `/space/${SPACE_ID}/linkset`);
});

test("space description GET: 404 when the space bucket does not exist", async () => {
  onSend = () => {
    throw s3Error("NoSuchBucket");
  };
  const res = await spaceDescriptionGet(event("space-description-get"));
  assert.equal(res.statusCode, 404);
});

// GET /space/{space_id}/collections - collections list

test("space collections list GET: lists collection prefixes", async () => {
  onSend = (command) => {
    assert.ok(command instanceof ListObjectsV2Command);
    assert.equal(command.input.Bucket, SPACE_ID);
    assert.equal(command.input.Prefix, "collections/");
    assert.equal(command.input.Delimiter, "/");
    return {
      CommonPrefixes: [
        { Prefix: "collections/credentials/" },
        { Prefix: "collections/keys/" },
      ],
    };
  };
  const res = await spaceCollectionsListGet(event("space-collections-list-get"));
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.totalItems, 2);
  assert.deepEqual(
    body.items.map(({ id }) => id),
    ["credentials", "keys"]
  );
  assert.equal(body.items[0].url, `/space/${SPACE_ID}/credentials`);
});

test("space collections list GET: empty list when the space has no collections", async () => {
  onSend = () => ({});
  const res = await spaceCollectionsListGet(event("space-collections-list-get"));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).totalItems, 0);
});

test("space collections list GET: 404 when the space bucket does not exist", async () => {
  onSend = () => {
    throw s3Error("NoSuchBucket");
  };
  const res = await spaceCollectionsListGet(event("space-collections-list-get"));
  assert.equal(res.statusCode, 404);
});

// GET /space/{space_id}/{collection_id} - collection description and listing

test("collection GET without trailing slash: returns the stored description", async () => {
  const description = { id: COLLECTION_ID, type: ["Collection"] };
  onSend = (command) => {
    assert.ok(command instanceof GetObjectCommand);
    assert.equal(command.input.Bucket, SPACE_ID);
    assert.equal(command.input.Key, `collections/${COLLECTION_ID}/description.json`);
    return s3Object(JSON.stringify(description));
  };
  const res = await collectionGet(event("collection-description-get"));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), description);
});

test("collection GET with trailing slash: lists members, skipping reserved keys", async () => {
  const prefix = `collections/${COLLECTION_ID}/`;
  onSend = (command) => {
    assert.ok(command instanceof ListObjectsV2Command);
    assert.equal(command.input.Prefix, prefix);
    return {
      Contents: [
        { Key: prefix }, // the folder marker
        { Key: `${prefix}description.json` }, // collection metadata
        { Key: `${prefix}${RESOURCE_ID}` },
      ],
    };
  };
  const res = await collectionGet(event("collection-list-get"));
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.totalItems, 1);
  assert.equal(body.items[0].id, RESOURCE_ID);
  assert.equal(
    body.items[0].url,
    `/space/${SPACE_ID}/${COLLECTION_ID}/${RESOURCE_ID}`
  );
});

test("collection GET: 404 when the description does not exist", async () => {
  onSend = () => {
    throw s3Error("NoSuchKey");
  };
  const res = await collectionGet(event("collection-description-get"));
  assert.equal(res.statusCode, 404);
});

// PUT /space/{space_id}/{collection_id} - update-or-create collection

test("collection PUT: 201 with Location and stamped description on create", async () => {
  let stored;
  onSend = (command) => {
    if (command instanceof HeadObjectCommand) throw s3Error("NotFound");
    assert.ok(command instanceof PutObjectCommand);
    assert.equal(command.input.Bucket, SPACE_ID);
    assert.equal(command.input.Key, `collections/${COLLECTION_ID}/description.json`);
    assert.equal(command.input.ContentType, "application/json");
    stored = JSON.parse(command.input.Body);
    return {};
  };
  const res = await collectionPut(event("collection-put"));
  assert.equal(res.statusCode, 201);
  assert.equal(res.headers.Location, `/space/${SPACE_ID}/${COLLECTION_ID}`);
  // The server owns id and url, whatever the client sent.
  assert.equal(stored.id, COLLECTION_ID);
  assert.equal(stored.url, `/space/${SPACE_ID}/${COLLECTION_ID}`);
  assert.deepEqual(JSON.parse(res.body), stored);
});

test("collection PUT: 204 with no body on update", async () => {
  onSend = (command) => {
    if (command instanceof HeadObjectCommand) return {};
    assert.ok(command instanceof PutObjectCommand);
    return {};
  };
  const res = await collectionPut(event("collection-put"));
  assert.equal(res.statusCode, 204);
  assert.equal(res.body, "");
});

test("collection PUT: 400 when the body is not JSON", async () => {
  const res = await collectionPut(event("collection-put", { body: "not json" }));
  assert.equal(res.statusCode, 400);
});

test('collection PUT: 400 when type does not include "Collection"', async () => {
  const res = await collectionPut(
    event("collection-put", { body: JSON.stringify({ type: ["Space"] }) })
  );
  assert.equal(res.statusCode, 400);
});

test("collection PUT: 404 when the space bucket does not exist", async () => {
  onSend = () => {
    throw s3Error("NoSuchBucket");
  };
  const res = await collectionPut(event("collection-put"));
  assert.equal(res.statusCode, 404);
});

// PUT /space/{space_id}/{collection_id}/{resource_id} - update-or-create resource

test("resource PUT: 201 with Location and ETag on create", async () => {
  let stored;
  onSend = (command) => {
    if (command instanceof HeadObjectCommand) throw s3Error("NotFound");
    assert.ok(command instanceof PutObjectCommand);
    assert.equal(command.input.Bucket, SPACE_ID);
    assert.equal(command.input.Key, `collections/${COLLECTION_ID}/${RESOURCE_ID}`);
    assert.equal(command.input.ContentType, "application/json");
    stored = command.input.Body;
    return { ETag: '"etag-1"' };
  };
  const res = await resourcePut(event("resource-put"));
  assert.equal(res.statusCode, 201);
  assert.equal(
    res.headers.Location,
    `/space/${SPACE_ID}/${COLLECTION_ID}/${RESOURCE_ID}`
  );
  assert.equal(res.headers.ETag, '"etag-1"');
  assert.equal(stored, routes["resource-put"].body);
});

test("resource PUT: 200 with ETag and a JSON body on update", async () => {
  onSend = (command) => {
    if (command instanceof HeadObjectCommand) return {};
    return { ETag: '"etag-2"' };
  };
  const res = await resourcePut(event("resource-put"));
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers.ETag, '"etag-2"');
  // API Gateway defaults the Content-Type to application/json, so the body
  // must actually be JSON or clients that trust the header fail to parse it
  assert.equal(res.headers["Content-Type"], "application/json");
  assert.ok(JSON.parse(res.body).url);
});

test("resource PUT: decodes a base64 body before storing it", async () => {
  let stored;
  onSend = (command) => {
    if (command instanceof HeadObjectCommand) throw s3Error("NotFound");
    stored = command.input.Body;
    return {};
  };
  const res = await resourcePut(
    event("resource-put", {
      body: Buffer.from("hello, was").toString("base64"),
      isBase64Encoded: true,
    })
  );
  assert.equal(res.statusCode, 201);
  assert.ok(Buffer.isBuffer(stored));
  assert.equal(stored.toString(), "hello, was");
});

test("resource PUT: refuses to overwrite the collection description", async () => {
  const route = routes["resource-put"];
  const res = await resourcePut(
    event("resource-put", {
      pathParameters: { ...route.pathParameters, resource_id: "description.json" },
    })
  );
  assert.equal(res.statusCode, 404);
});

test("resource PUT: 404 when the space bucket does not exist", async () => {
  onSend = () => {
    throw s3Error("NoSuchBucket");
  };
  const res = await resourcePut(event("resource-put"));
  assert.equal(res.statusCode, 404);
});

// GET /space/{space_id}/{collection_id}/{resource_id} - read resource

test("resource GET: returns content with stored Content-Type and ETag", async () => {
  onSend = (command) => {
    assert.ok(command instanceof GetObjectCommand);
    assert.equal(command.input.Bucket, SPACE_ID);
    assert.equal(command.input.Key, `collections/${COLLECTION_ID}/${RESOURCE_ID}`);
    return s3Object("stored bytes", { ContentType: "text/plain", ETag: '"etag-3"' });
  };
  const res = await resourceGet(event("resource-get"));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, "stored bytes");
  assert.equal(res.headers["Content-Type"], "text/plain");
  assert.equal(res.headers.ETag, '"etag-3"');
});

test("resource GET: defaults Content-Type to application/json", async () => {
  onSend = () => s3Object("{}");
  const res = await resourceGet(event("resource-get"));
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Content-Type"], "application/json");
});

test("resource GET: 404 when the resource does not exist", async () => {
  onSend = () => {
    throw s3Error("NoSuchKey");
  };
  const res = await resourceGet(event("resource-get"));
  assert.equal(res.statusCode, 404);
});

test("resource GET: refuses to serve the collection description", async () => {
  const route = routes["resource-get"];
  const res = await resourceGet(
    event("resource-get", {
      pathParameters: { ...route.pathParameters, resource_id: "description.json" },
    })
  );
  assert.equal(res.statusCode, 404);
});

test("resource DELETE: copies into Trash then removes the original", async () => {
  const calls = [];
  onSend = (command) => {
    calls.push(command);
    return {};
  };
  const res = await resourceDelete(event("resource-delete"));
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Content-Type"], "application/json");
  const body = JSON.parse(res.body);
  assert.equal(body.deleted, true);
  assert.match(body.trash, /\/Trash\//);

  assert.equal(calls.length, 2);
  assert.ok(calls[0] instanceof CopyObjectCommand);
  assert.equal(calls[0].input.Key, `collections/Trash/${RESOURCE_ID}`);
  assert.ok(calls[1] instanceof DeleteObjectCommand);
  assert.equal(
    calls[1].input.Key,
    `collections/${COLLECTION_ID}/${RESOURCE_ID}`
  );
});

test("resource DELETE from Trash: removes permanently without copying", async () => {
  const calls = [];
  onSend = (command) => {
    calls.push(command);
    return {};
  };
  const route = routes["resource-delete"];
  const res = await resourceDelete(
    event("resource-delete", {
      pathParameters: { ...route.pathParameters, collection_id: "Trash" },
    })
  );
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).deleted, true);
  assert.equal(calls.length, 1);
  assert.ok(calls[0] instanceof DeleteObjectCommand);
  assert.equal(calls[0].input.Key, `collections/Trash/${RESOURCE_ID}`);
});

test("resource DELETE: 404 when the resource does not exist", async () => {
  onSend = () => {
    throw s3Error("NoSuchKey");
  };
  const res = await resourceDelete(event("resource-delete"));
  assert.equal(res.statusCode, 404);
});

test("resource DELETE: refuses to remove the collection description", async () => {
  const route = routes["resource-delete"];
  const res = await resourceDelete(
    event("resource-delete", {
      pathParameters: { ...route.pathParameters, resource_id: "description.json" },
    })
  );
  assert.equal(res.statusCode, 404);
});

// Deployed, an HTTP API routes a trailing-slash list URL to the resource
// route with an empty resource_id (sam local collapses the slash instead, so
// the collection handler's own listing branch covers local runs).
test("resource GET with empty resource_id: lists the collection's members", async () => {
  const prefix = `collections/${COLLECTION_ID}/`;
  onSend = (command) => {
    assert.ok(command instanceof ListObjectsV2Command);
    assert.equal(command.input.Prefix, prefix);
    return {
      Contents: [
        { Key: prefix },
        { Key: `${prefix}description.json` },
        { Key: `${prefix}${RESOURCE_ID}` },
      ],
    };
  };
  const route = routes["resource-get"];
  const res = await resourceGet(
    event("resource-get", {
      pathParameters: { ...route.pathParameters, resource_id: "" },
    })
  );
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.totalItems, 1);
  assert.equal(body.items[0].id, RESOURCE_ID);
});

test("resource GET with empty resource_id under 'collections': lists the space's collections", async () => {
  onSend = (command) => {
    assert.ok(command instanceof ListObjectsV2Command);
    assert.equal(command.input.Prefix, "collections/");
    return {
      CommonPrefixes: [
        { Prefix: "collections/credentials/" },
        { Prefix: "collections/Trash/" },
      ],
    };
  };
  const route = routes["resource-get"];
  const res = await resourceGet(
    event("resource-get", {
      pathParameters: {
        space_id: route.pathParameters.space_id,
        collection_id: "collections",
        resource_id: "",
      },
    })
  );
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.totalItems, 2);
  assert.deepEqual(body.items.map((i) => i.id), ["credentials", "Trash"]);
});
