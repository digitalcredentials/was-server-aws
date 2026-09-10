// Shared route table and event scaffolding for the test-event tooling.

// `sam local start-api` serves on port 3000 over plain http.
export const HOST = "localhost:3000";
export const PROTO = "http";

export const SPACE_ID = "dcc-was-01011f5b-59ea-4e62-880e-d6ad666e361c";
export const COLLECTION_ID = "credentials";
export const RESOURCE_ID = "credential-1.json";

// Placeholders; API Gateway fills these in for real requests.
export const API_ID = "abcdef1234";
export const REGION = "us-east-1";
export const ACCOUNT_ID = "123456789012";
export const STAGE = "Prod";

export const routes = {
  "space-description-get": {
    resource: "/space/{space_id}",
    path: `/space/${SPACE_ID}`,
    method: "GET",
    pathParameters: { space_id: SPACE_ID },
  },
  "space-collections-list-get": {
    resource: "/space/{space_id}/collections",
    path: `/space/${SPACE_ID}/collections`,
    method: "GET",
    pathParameters: { space_id: SPACE_ID },
  },
  // Trailing slash: lists the collection's member resources.
  "collection-list-get": {
    resource: "/space/{space_id}/{collection_id}",
    path: `/space/${SPACE_ID}/${COLLECTION_ID}/`,
    method: "GET",
    pathParameters: { space_id: SPACE_ID, collection_id: COLLECTION_ID },
  },
  // No trailing slash: returns the collection's own description.json.
  "collection-description-get": {
    resource: "/space/{space_id}/{collection_id}",
    path: `/space/${SPACE_ID}/${COLLECTION_ID}`,
    method: "GET",
    pathParameters: { space_id: SPACE_ID, collection_id: COLLECTION_ID },
  },
  // Update-or-create the collection's description document.
  "collection-put": {
    resource: "/space/{space_id}/{collection_id}",
    path: `/space/${SPACE_ID}/${COLLECTION_ID}`,
    method: "PUT",
    pathParameters: { space_id: SPACE_ID, collection_id: COLLECTION_ID },
    contentType: "application/json",
    body: JSON.stringify({
      id: COLLECTION_ID,
      type: ["Collection"],
      name: "JSON Documents Collection",
    }),
  },
  // Update-or-create a resource in the collection.
  "resource-put": {
    resource: "/space/{space_id}/{collection_id}/{resource_id}",
    path: `/space/${SPACE_ID}/${COLLECTION_ID}/${RESOURCE_ID}`,
    method: "PUT",
    pathParameters: {
      space_id: SPACE_ID,
      collection_id: COLLECTION_ID,
      resource_id: RESOURCE_ID,
    },
    contentType: "application/json",
    body: JSON.stringify({
      name: "A stored credential",
      issuanceDate: "2026-01-01T00:00:00Z",
    }),
  },
  // Read a resource back from the collection.
  "resource-get": {
    resource: "/space/{space_id}/{collection_id}/{resource_id}",
    path: `/space/${SPACE_ID}/${COLLECTION_ID}/${RESOURCE_ID}`,
    method: "GET",
    pathParameters: {
      space_id: SPACE_ID,
      collection_id: COLLECTION_ID,
      resource_id: RESOURCE_ID,
    },
  },
  // Soft-delete a resource: moves it into the space's Trash collection.
  "resource-delete": {
    resource: "/space/{space_id}/{collection_id}/{resource_id}",
    path: `/space/${SPACE_ID}/${COLLECTION_ID}/${RESOURCE_ID}`,
    method: "DELETE",
    pathParameters: {
      space_id: SPACE_ID,
      collection_id: COLLECTION_ID,
      resource_id: RESOURCE_ID,
    },
  },
};

export function routeOrDie(name) {
  const route = routes[name];
  if (!route) {
    const known = Object.keys(routes).join("\n  ");
    throw new Error(`unknown route "${name}". Known routes:\n  ${known}`);
  }
  return route;
}

export function targetUrl({ path }) {
  // The HTTP API serves the $default stage at the root, so the signed URL is
  // simply proto://host+path -- the same locally and deployed.
  return `${PROTO}://${HOST}${path}`;
}

// HTTP API payload v2 requestContext ($default stage serves at the root).
export function requestContext({ method, path }) {
  return {
    accountId: ACCOUNT_ID,
    apiId: API_ID,
    domainName: `${API_ID}.execute-api.${REGION}.amazonaws.com`,
    http: {
      method,
      path,
      protocol: "HTTP/1.1",
      sourceIp: "127.0.0.1",
      userAgent: "was-test-events",
    },
    requestId: "c6af9ac6-7b61-11e6-9a41-93e8deadbeef",
    routeKey: "$default",
    stage: "$default",
  };
}

// An HTTP API REQUEST authorizer event (payload v2), as WASZcapAuthorizerFn
// sees it. Note there is no `requestContext.authorizer` - that is what it
// produces.
export function authorizerEvent(route, headers) {
  const { resource, path, method, pathParameters } = route;
  const authorization =
    headers.authorization ?? headers.Authorization ?? null;
  return {
    version: "2.0",
    type: "REQUEST",
    routeArn: `arn:aws:execute-api:${REGION}:${ACCOUNT_ID}:${API_ID}/$default/${method}${resource}`,
    identitySource: authorization ? [authorization] : [],
    routeKey: `${method} ${resource}`,
    rawPath: path,
    rawQueryString: "",
    headers,
    pathParameters,
    stageVariables: null,
    requestContext: requestContext({ method, path }),
  };
}

// An HTTP API proxy event (payload v2), as a route handler sees it.
export function proxyEvent(route, { controller, capability }) {
  const { resource, path, method, pathParameters, body, contentType } = route;
  return {
    version: "2.0",
    routeKey: `${method} ${resource}`,
    rawPath: path,
    rawQueryString: "",
    headers: {
      host: HOST,
      accept: "application/json",
      "x-forwarded-proto": PROTO,
      ...(contentType && { "content-type": contentType }),
    },
    queryStringParameters: null,
    pathParameters,
    stageVariables: null,
    requestContext: {
      ...requestContext({ method, path }),
      // Produced by WASZcapAuthorizerFn, which has already run by this point.
      // HTTP API nests lambda-authorizer context under `lambda`.
      authorizer: { lambda: { controller, capability, capabilityAction: method } },
    },
    body: body ?? null,
    isBase64Encoded: false,
  };
}
