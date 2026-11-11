import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";

// The spaces registry as the verification stack reads it: a Space's
// controller DID and type array, by Space URL.

const dynamo = new DynamoDBClient({});
const SPACES_TABLE = process.env.SPACES_TABLE_NAME ?? "was-spaces";

export async function getSpace(spaceUrl) {
  const { Item } = await dynamo.send(new GetItemCommand({ TableName: SPACES_TABLE, Key: { spaceURL: { S: spaceUrl } } }));
  if (!Item) {
    return null;
  }
  const type = Item.type?.L
    ? Item.type.L.map((entry) => entry.S)
    : Item.type?.S === "batch"
      ? ["Space", "BatchSpace"]
      : ["Space"];
  return { controller: Item.did?.S?.split("#")[0], type };
}
