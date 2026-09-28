// Subset of the WhatsApp Cloud API webhook payload that this service reads.
// https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/components

export interface WebhookPayload {
  object: string; // "whatsapp_business_account"
  entry?: WebhookEntry[];
}

export interface WebhookEntry {
  id: string;
  changes?: WebhookChange[];
}

export interface WebhookChange {
  field: string; // "messages"
  value: {
    messaging_product: "whatsapp";
    metadata: { display_phone_number: string; phone_number_id: string };
    contacts?: { wa_id: string; profile?: { name?: string } }[];
    messages?: InboundMessage[];
    statuses?: unknown[]; // delivery/read receipts, ignored
  };
}

export interface InboundMessage {
  id: string; // wamid.…
  from: string; // sender's WhatsApp id (phone number, no "+")
  timestamp: string;
  type: "text" | "image" | "audio" | "video" | "document" | "sticker" | "location" | "interactive" | "button" | "reaction" | string;
  text?: { body: string };
  image?: { id: string; mime_type?: string; caption?: string };
  audio?: { id: string; mime_type?: string; voice?: boolean };
  button?: { text: string; payload?: string };
  interactive?: {
    type: "button_reply" | "list_reply";
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string };
  };
}

/** What goes on the SQS queue for the processor: a WhatsApp message, or a reminder coming due. */
export interface QueuedMessage {
  /** WhatsApp message id, or the schedule name for scheduled items. Used for dedupe. */
  messageId: string;
  from: string;
  senderName?: string;
  phoneNumberId: string;
  /** Message text, or an image's caption. "" for types we don't read. */
  text: string;
  /** Set when the message carries a voice note or image to download. */
  media?: { type: "audio" | "image"; id: string; mimeType?: string };
  /** WhatsApp message type as received (text, image, audio, video, ...). */
  messageType?: string;
  /** Set by EventBridge Scheduler: a reminder to send, or a task for the assistant to carry out now. */
  scheduled?: { type: "reminder" | "task"; createdAt: string };
}
