// Shared route table and event scaffolding for the test-event tooling.

// `sam local start-api` serves on port 3000 over plain http.
export const HOST = "localhost:3000";
export const PROTO = "http";

export const SPACE_ID = "dcc-was-01011f5b-59ea-4e62-880e-d6ad666e361c";
export const COLLECTION_ID = "credentials";

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
  return `${PROTO}://${HOST}${path}`;
}

export function requestContext({ resource, method, path }) {
  return {
    accountId: ACCOUNT_ID,
    apiId: API_ID,
    domainName: `${API_ID}.execute-api.${REGION}.amazonaws.com`,
    httpMethod: method,
    path: `/${STAGE}${path}`,
    protocol: "HTTP/1.1",
    requestId: "c6af9ac6-7b61-11e6-9a41-93e8deadbeef",
    resourceId: "abcdef",
    resourcePath: resource,
    stage: STAGE,
  };
}

// An API Gateway REQUEST authorizer event, as WASZcapAuthorizerFn sees it.
// Note there is no `requestContext.authorizer` - that is what it produces.
export function authorizerEvent(route, headers) {
  const { resource, path, method, pathParameters } = route;
  return {
    type: "REQUEST",
    methodArn: `arn:aws:execute-api:${REGION}:${ACCOUNT_ID}:${API_ID}/${STAGE}/${method}${resource}`,
    resource,
    path,
    httpMethod: method,
    headers,
    queryStringParameters: null,
    pathParameters,
    stageVariables: null,
    requestContext: requestContext({ resource, method, path }),
  };
}

// An API Gateway REST proxy-integration event, as a route handler sees it.
export function proxyEvent(route, { controller, capability }) {
  const { resource, path, method, pathParameters } = route;
  return {
    resource,
    path,
    httpMethod: method,
    headers: {
      host: HOST,
      accept: "application/json",
      "X-Forwarded-Proto": PROTO,
    },
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    pathParameters,
    stageVariables: null,
    requestContext: {
      ...requestContext({ resource, method, path }),
      // Produced by WASZcapAuthorizerFn, which has already run by this point.
      authorizer: { controller, capability, capabilityAction: method },
    },
    body: null,
    isBase64Encoded: false,
  };
}
