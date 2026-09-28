import { config, getSecrets } from "../config.js";

// Inbound media (voice notes, images) arrives as an id. Fetching it is two calls:
// the id resolves to a short-lived URL, and that URL returns the bytes (both need the access token).

const MAX_BYTES = 16 * 1024 * 1024; // WhatsApp's own limit for audio

export interface DownloadedMedia {
  data: Buffer;
  mimeType: string;
}

export async function downloadMedia(mediaId: string): Promise<DownloadedMedia> {
  const { WHATSAPP_ACCESS_TOKEN } = await getSecrets();
  const auth = { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}` };

  const metaRes = await fetch(`https://graph.facebook.com/${config.whatsappGraphVersion}/${mediaId}`, {
    headers: auth,
    signal: AbortSignal.timeout(15_000),
  });
  if (!metaRes.ok) throw new Error(`WhatsApp media lookup ${metaRes.status}: ${await metaRes.text()}`);
  const meta = (await metaRes.json()) as { url: string; mime_type: string; file_size?: number };
  if (meta.file_size && meta.file_size > MAX_BYTES) throw new Error(`Media too large (${meta.file_size} bytes)`);

  const fileRes = await fetch(meta.url, { headers: auth, signal: AbortSignal.timeout(30_000) });
  if (!fileRes.ok) throw new Error(`WhatsApp media download ${fileRes.status}`);
  const data = Buffer.from(await fileRes.arrayBuffer());
  return { data, mimeType: meta.mime_type };
}
