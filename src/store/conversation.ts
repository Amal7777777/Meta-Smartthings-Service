import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { ChatTurn } from "../orchestrator/orchestrator.js";
import { config } from "../config.js";

// One DynamoDB table, two item kinds:
//   pk = "CONV#<waId>"   -> recent chat turns for that sender (text only)
//   pk = "MSG#<wamid>"   -> marker that an inbound message was already handled (Meta retries webhooks)
// Both expire via the table's TTL attribute "expiresAt".

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const HISTORY_TTL_SECONDS = 24 * 60 * 60; // forget a conversation after a day of silence
const DEDUPE_TTL_SECONDS = 3 * 24 * 60 * 60;

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Returns true the first time a WhatsApp message id is seen, false for duplicates. */
export async function claimMessage(messageId: string): Promise<boolean> {
  try {
    await doc.send(
      new PutCommand({
        TableName: config.tableName,
        Item: { pk: `MSG#${messageId}`, expiresAt: nowSeconds() + DEDUPE_TTL_SECONDS },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return false;
    throw err;
  }
}

export async function loadHistory(waId: string): Promise<ChatTurn[]> {
  const res = await doc.send(new GetCommand({ TableName: config.tableName, Key: { pk: `CONV#${waId}` } }));
  const item = res.Item as { turns?: ChatTurn[]; expiresAt?: number } | undefined;
  if (!item?.turns || (item.expiresAt ?? 0) < nowSeconds()) return [];
  return item.turns;
}

export async function saveHistory(waId: string, turns: ChatTurn[]): Promise<void> {
  // Keep the last N user/assistant pairs, and always start on a user turn.
  let recent = turns.slice(-config.historyTurns * 2);
  while (recent.length > 0 && recent[0]?.role !== "user") recent = recent.slice(1);
  await doc.send(
    new PutCommand({
      TableName: config.tableName,
      Item: { pk: `CONV#${waId}`, turns: recent, expiresAt: nowSeconds() + HISTORY_TTL_SECONDS },
    }),
  );
}
