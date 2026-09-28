import type Anthropic from "@anthropic-ai/sdk";
import type { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";
import { config } from "../config.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { createDefaultRegistry } from "../orchestrator/registry.js";
import { claimMessage, loadHistory, saveHistory } from "../store/conversation.js";
import { transcribeVoiceNote } from "../media/transcribe.js";
import { markReadWithTyping, sendText } from "../whatsapp/client.js";
import { downloadMedia } from "../whatsapp/media.js";
import type { QueuedMessage } from "../whatsapp/types.js";

// Consumes queued WhatsApp messages: runs each through the orchestrator and sends the reply.

const orchestrator = new Orchestrator(createDefaultRegistry());

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchResponse["batchItemFailures"] = [];
  // FIFO: records arrive in order per sender, so process sequentially. After a failure, fail the
  // rest of the batch too so the sender's later messages are not handled out of order.
  for (const record of event.Records) {
    if (batchItemFailures.length > 0) {
      batchItemFailures.push({ itemIdentifier: record.messageId });
      continue;
    }
    try {
      await processRecord(record);
    } catch (err) {
      console.error(JSON.stringify({ msg: "record failed", id: record.messageId, error: String(err) }));
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}

async function processRecord(record: SQSRecord): Promise<void> {
  const msg = JSON.parse(record.body) as QueuedMessage;

  if (config.whatsappPhoneNumberId && msg.phoneNumberId !== config.whatsappPhoneNumberId) {
    // The Meta app can have several numbers; only serve the one this stack was deployed for.
    console.warn(JSON.stringify({ msg: "ignored message for another business number", phoneNumberId: msg.phoneNumberId }));
    return;
  }

  if (!config.allowedSenders.has(msg.from)) {
    // Anyone can message a business number; only allow-listed people may control the home.
    console.warn(JSON.stringify({ msg: "ignored sender not on allow list", from: msg.from }));
    return;
  }

  // Claim before doing anything, so a retried delivery can never repeat a device command.
  if (!(await claimMessage(msg.messageId))) {
    console.log(JSON.stringify({ msg: "duplicate ignored", messageId: msg.messageId }));
    return;
  }

  if (msg.scheduled) {
    await handleScheduled(msg);
    return;
  }

  await markReadWithTyping(msg.phoneNumberId, msg.messageId).catch((err) =>
    console.warn(JSON.stringify({ msg: "mark read failed", error: String(err) })),
  );

  let input: UserInput;
  try {
    input = await readInput(msg);
  } catch (err) {
    console.error(JSON.stringify({ msg: "reading media failed", messageId: msg.messageId, error: String(err) }));
    await sendReply(msg, "Sorry, I couldn't open that. Could you try again, or type it instead?");
    return;
  }
  if (!input) {
    await sendReply(msg, "I can read text, voice notes and photos for now. What would you like me to do?");
    return;
  }

  const reply = await runOrchestrator(msg.from, input.content, input.historyText);
  await sendReply(msg, input.prefix ? `${input.prefix}\n\n${reply}` : reply);
}

type UserInput =
  | {
      /** What the model sees: text, or an image plus its caption. */
      content: string | Anthropic.ContentBlockParam[];
      /** What goes in the stored history (text only). */
      historyText: string;
      /** Shown above the reply, e.g. what a voice note was heard as. */
      prefix?: string;
    }
  | undefined;

async function readInput(msg: QueuedMessage): Promise<UserInput> {
  if (msg.media?.type === "audio") {
    const audio = await downloadMedia(msg.media.id);
    const transcript = await transcribeVoiceNote(audio.data, audio.mimeType, msg.messageId);
    if (!transcript) return { content: "(The user sent a voice note with no audible speech.)", historyText: "[voice note, no speech]" };
    console.log(JSON.stringify({ msg: "voice note transcribed", chars: transcript.length }));
    return {
      content: `[Voice note, transcribed] ${transcript}`,
      historyText: `[voice note] ${transcript}`,
      prefix: `🎤 _"${transcript.length > 300 ? `${transcript.slice(0, 300)}…` : transcript}"_`,
    };
  }

  if (msg.media?.type === "image") {
    const image = await downloadMedia(msg.media.id);
    const mediaType = image.mimeType.split(";")[0]?.trim() ?? "";
    if (!SUPPORTED_IMAGE_TYPES.has(mediaType)) throw new Error(`Unsupported image type ${mediaType}`);
    const caption = msg.text.trim();
    return {
      content: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
            data: image.data.toString("base64"),
          },
        },
        { type: "text", text: caption || "(The user sent this photo without a caption. Describe it briefly and ask what they'd like.)" },
      ],
      historyText: caption ? `[photo] ${caption}` : "[photo]",
    };
  }

  if (!msg.text.trim()) return undefined;
  return { content: msg.text, historyText: msg.text };
}

const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** A reminder or scheduled task coming due (delivered by EventBridge Scheduler). */
async function handleScheduled(msg: QueuedMessage): Promise<void> {
  console.log(JSON.stringify({ msg: "scheduled item due", type: msg.scheduled?.type, messageId: msg.messageId }));
  if (msg.scheduled?.type === "reminder") {
    await sendReply(msg, `⏰ Reminder: ${msg.text}`);
    return;
  }
  const prompt =
    `[Scheduled task] Earlier (${msg.scheduled?.createdAt}) the user asked you to do this now: "${msg.text}". ` +
    "Do it now without asking for confirmation, then tell them in one or two sentences what you did. " +
    "Exception: never unlock doors, open garage doors or gates, or disarm security on a schedule; tell them instead.";
  const reply = await runOrchestrator(msg.from, prompt, `[scheduled task] ${msg.text}`);
  await sendReply(msg, `⏰ ${reply}`);
}

async function runOrchestrator(
  from: string,
  content: string | Anthropic.ContentBlockParam[],
  historyText: string,
): Promise<string> {
  try {
    const history = await loadHistory(from);
    const reply = await orchestrator.handle(history, content, { userId: from });
    await saveHistory(from, [...history, { role: "user", text: historyText }, { role: "assistant", text: reply }]);
    return reply;
  } catch (err) {
    // The message is already claimed, so don't rethrow (a retry would be skipped anyway); tell the user instead.
    console.error(JSON.stringify({ msg: "orchestrator failed", error: String(err) }));
    return "Sorry, something went wrong on my side. Please try again in a moment.";
  }
}

/**
 * Sends a reply without throwing. The message is already claimed, so a retry would be skipped as a
 * duplicate anyway; rethrowing would only hold the sender's later messages in the FIFO queue until
 * the visibility timeout expires.
 */
async function sendReply(msg: QueuedMessage, text: string): Promise<void> {
  try {
    await sendText(msg.phoneNumberId, msg.from, text);
  } catch (err) {
    console.error(JSON.stringify({ msg: "send reply failed", messageId: msg.messageId, error: String(err) }));
  }
}
