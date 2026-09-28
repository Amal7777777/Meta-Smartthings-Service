import { SendMessageBatchCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { config, getSecrets } from "../config.js";
import { isValidSignature } from "../whatsapp/signature.js";
import type { InboundMessage, QueuedMessage, WebhookPayload } from "../whatsapp/types.js";

// Public callback URL registered in the Meta developer dashboard (WhatsApp > Configuration).
//   GET  -> one-time verification handshake
//   POST -> message notifications. We verify the signature, queue the work and return 200 at once,
//           because Meta retries (and eventually disables) webhooks that answer slowly.

const sqs = new SQSClient({});

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method;
  console.log(
    JSON.stringify({
      msg: "webhook request",
      method,
      sourceIp: event.requestContext.http.sourceIp,
      userAgent: event.requestContext.http.userAgent,
      hubMode: event.queryStringParameters?.["hub.mode"],
      bodyBytes: event.body?.length ?? 0,
    }),
  );
  if (method === "GET") return verify(event);
  if (method === "POST") return receive(event);
  return { statusCode: 405, body: "Method not allowed" };
}

async function verify(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const q = event.queryStringParameters ?? {};
  const { WHATSAPP_VERIFY_TOKEN } = await getSecrets();
  if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] === WHATSAPP_VERIFY_TOKEN && q["hub.challenge"]) {
    return { statusCode: 200, headers: { "Content-Type": "text/plain" }, body: q["hub.challenge"] };
  }
  return { statusCode: 403, body: "Verification failed" };
}

async function receive(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const rawBody = Buffer.from(event.body ?? "", event.isBase64Encoded ? "base64" : "utf8");
  const { WHATSAPP_APP_SECRET } = await getSecrets();
  const signature = event.headers["x-hub-signature-256"] ?? event.headers["X-Hub-Signature-256"];
  if (!isValidSignature(rawBody, signature, WHATSAPP_APP_SECRET)) {
    console.warn(JSON.stringify({ msg: "rejected webhook: bad signature" }));
    return { statusCode: 401, body: "Invalid signature" };
  }

  let payload: WebhookPayload;
  try {
    payload = JSON.parse(rawBody.toString("utf8")) as WebhookPayload;
  } catch {
    return { statusCode: 400, body: "Invalid JSON" };
  }

  const queued = extractMessages(payload);
  // SQS batches hold at most 10 entries.
  for (let i = 0; i < queued.length; i += 10) {
    const batch = queued.slice(i, i + 10);
    const res = await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: config.queueUrl,
        Entries: batch.map((m, j) => ({
          Id: String(j),
          MessageBody: JSON.stringify(m),
          MessageGroupId: m.from, // FIFO: one sender's messages are handled in order
          MessageDeduplicationId: m.messageId, // FIFO: drops Meta's retries within 5 minutes
        })),
      }),
    );
    if (res.Failed?.length) {
      // Returning 500 makes Meta retry the whole notification; duplicates are dropped downstream.
      console.error(JSON.stringify({ msg: "failed to enqueue", failed: res.Failed }));
      return { statusCode: 500, body: "Enqueue failed" };
    }
  }

  console.log(JSON.stringify({ msg: "webhook accepted", queued: queued.length }));
  return { statusCode: 200, body: "OK" };
}

function extractMessages(payload: WebhookPayload): QueuedMessage[] {
  if (payload.object !== "whatsapp_business_account") return [];
  const out: QueuedMessage[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;
      const value = change.value;
      for (const msg of value.messages ?? []) {
        const senderName = value.contacts?.find((c) => c.wa_id === msg.from)?.profile?.name;
        out.push({
          messageId: msg.id,
          from: msg.from,
          senderName,
          phoneNumberId: value.metadata.phone_number_id,
          text: textOf(msg),
          messageType: msg.type,
          media: mediaOf(msg),
        });
      }
    }
  }
  return out;
}

/** Text the user sent (or an image's caption), or "" for other message types. */
function textOf(msg: InboundMessage): string {
  switch (msg.type) {
    case "text":
      return msg.text?.body ?? "";
    case "image":
      return msg.image?.caption ?? "";
    case "button":
      return msg.button?.text ?? "";
    case "interactive":
      return msg.interactive?.button_reply?.title ?? msg.interactive?.list_reply?.title ?? "";
    default:
      return "";
  }
}

/** Voice notes and images are downloaded and read by the processor. */
function mediaOf(msg: InboundMessage): QueuedMessage["media"] {
  if (msg.type === "audio" && msg.audio) return { type: "audio", id: msg.audio.id, mimeType: msg.audio.mime_type };
  if (msg.type === "image" && msg.image) return { type: "image", id: msg.image.id, mimeType: msg.image.mime_type };
  return undefined;
}
