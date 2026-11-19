import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { handler } from "was-lib/handler.mjs";
import { json, parseJsonBody, NO_STORE } from "was-lib/http.mjs";
import { spaceUrl } from "was-lib/meta.mjs";
import { HttpProblem, invalidRequestBody } from "was-lib/problems.mjs";
import { chooseSpaceId, provisionSpace, spaceRequestOf } from "was-lib/provision.mjs";
import { isAccountRow } from "was-lib/quota.mjs";

// POST /space/{s}/spaces -- create a further Space under an account Space.
//
// An account Space is one a coupon (a registration code) was spent on at
// POST /spaces/. The code is spent once, there; every further Space of the
// account is created here, and what authorizes it is a capability on the
// account Space: its root capability, invoked by the account Space's
// controller, or a delegated capability whose tail targets exactly this URL
// and allows exactly POST (the authorizer's container rule,
// src/authorizer/container.mjs). No coupon is read.
//
// The body is that of POST /spaces/ without the coupon: `{controller,
// name?, type?, id?}`. As there, the stated controller is a did:key and is
// the DID that signed the request, so a Space is only ever created under a
// controller that signed for it. An account whose own controller is not
// the key the new Space is for (a wallet account, a did:webvh, creating a
// sign-in method's unlock Space) therefore delegates the POST-only
// capability to that key, which invokes it.
//
// The new Space is not an account Space: its registry row records
// `provisioning: "account"` and the account Space it was created under
// (`account`), and nothing can be created under it.

const dynamo = new DynamoDBClient({});
const SPACES_TABLE = process.env.SPACES_TABLE_NAME ?? "pws-spaces";

const accountRequired = () =>
  new HttpProblem({
    status: 403,
    type: "https://github.com/digitalcredentials/was-server-aws#account-required",
    title: "Account Space required",
    detail: "Spaces are created only under a Space that was itself created with a coupon.",
  });

export const lambdaHandler = handler(
  async (req, { registryUrl, invoker }) => {
    const { Item: account } = await dynamo.send(new GetItemCommand({ TableName: SPACES_TABLE, Key: { spaceURL: { S: registryUrl } } }));
    if (!isAccountRow(account)) {
      throw accountRequired();
    }
    const body = parseJsonBody(req, { problem: invalidRequestBody });
    const { controller, name, type, id } = spaceRequestOf(body);
    if (invoker !== controller) {
      throw invalidRequestBody("The request is not authorized by the stated controller.");
    }

    const { spaceId, chosen } = await chooseSpaceId(id);
    const written = await provisionSpace(req, { spaceId, chosen, controller, name, type, provisioning: "account", account: registryUrl });

    return json(req, 201, written.doc, {
      ...NO_STORE,
      Location: spaceUrl(req, spaceId),
      ETag: written.etag,
    });
  },
  { scope: "space-spaces" }
);
