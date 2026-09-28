import { config, getSecrets } from "../config.js";

// WhatsApp caps a text message body at 4096 characters.
const MAX_BODY = 4000;

async function graphPost(phoneNumberId: string, body: unknown): Promise<void> {
  const { WHATSAPP_ACCESS_TOKEN } = await getSecrets();
  const url = `https://graph.facebook.com/${config.whatsappGraphVersion}/${phoneNumberId}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`WhatsApp Graph API ${res.status}: ${await res.text()}`);
  }
}

/** Sends a plain text reply, splitting it into several messages if it is too long. */
export async function sendText(phoneNumberId: string, to: string, text: string): Promise<void> {
  for (const chunk of splitText(text, MAX_BODY)) {
    await graphPost(phoneNumberId, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: false, body: chunk },
    });
  }
}

/** Marks the inbound message as read (blue ticks) and shows the typing indicator. */
export async function markReadWithTyping(phoneNumberId: string, messageId: string): Promise<void> {
  await graphPost(phoneNumberId, {
    messaging_product: "whatsapp",
    status: "read",
    message_id: messageId,
    typing_indicator: { type: "text" },
  });
}

function splitText(text: string, max: number): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
