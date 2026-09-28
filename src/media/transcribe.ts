import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  DeleteTranscriptionJobCommand,
  GetTranscriptionJobCommand,
  StartTranscriptionJobCommand,
  TranscribeClient,
  type LanguageCode,
  type MediaFormat,
} from "@aws-sdk/client-transcribe";
import { config } from "../config.js";

// Voice notes -> text with Amazon Transcribe. Transcribe reads from S3, so the audio is staged in the
// media bucket, transcribed with automatic language detection, then deleted.

const s3 = new S3Client({});
const transcribe = new TranscribeClient({});

/** Languages Transcribe chooses between. It needs at least two; add yours (e.g. "ta-IN", "te-IN"). */
const LANGUAGE_OPTIONS: LanguageCode[] = ["en-IN", "hi-IN", "en-US"];
const POLL_MS = 1500;
const MAX_WAIT_MS = 90_000;

export async function transcribeVoiceNote(audio: Buffer, mimeType: string, messageId: string): Promise<string> {
  if (!config.mediaBucket) throw new Error("MEDIA_BUCKET is not set");
  const jobName = `vn-${Date.now()}-${messageId.replace(/[^0-9a-zA-Z._-]/g, "").slice(-40)}`;
  const key = `voice/${jobName}.${extensionOf(mimeType)}`;

  await s3.send(new PutObjectCommand({ Bucket: config.mediaBucket, Key: key, Body: audio, ContentType: mimeType }));
  try {
    await transcribe.send(
      new StartTranscriptionJobCommand({
        TranscriptionJobName: jobName,
        Media: { MediaFileUri: `s3://${config.mediaBucket}/${key}` },
        MediaFormat: extensionOf(mimeType) as MediaFormat,
        IdentifyLanguage: true,
        LanguageOptions: LANGUAGE_OPTIONS,
      }),
    );

    const deadline = Date.now() + MAX_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const { TranscriptionJob: job } = await transcribe.send(
        new GetTranscriptionJobCommand({ TranscriptionJobName: jobName }),
      );
      if (job?.TranscriptionJobStatus === "FAILED") throw new Error(`Transcription failed: ${job.FailureReason}`);
      if (job?.TranscriptionJobStatus === "COMPLETED" && job.Transcript?.TranscriptFileUri) {
        // Without an output bucket, Transcribe keeps the result and hands back a short-lived link to it.
        const res = await fetch(job.Transcript.TranscriptFileUri, { signal: AbortSignal.timeout(15_000) });
        const json = (await res.json()) as { results?: { transcripts?: { transcript: string }[] } };
        return (json.results?.transcripts ?? []).map((t) => t.transcript).join(" ").trim();
      }
    }
    throw new Error("Transcription timed out");
  } finally {
    await s3.send(new DeleteObjectCommand({ Bucket: config.mediaBucket, Key: key })).catch(() => {});
    await transcribe.send(new DeleteTranscriptionJobCommand({ TranscriptionJobName: jobName })).catch(() => {});
  }
}

/** WhatsApp voice notes are "audio/ogg; codecs=opus"; other audio can arrive as mp4/aac/mpeg/amr. */
function extensionOf(mimeType: string): string {
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  switch (base) {
    case "audio/ogg":
      return "ogg";
    case "audio/mpeg":
      return "mp3";
    case "audio/mp4":
    case "audio/aac":
      return "mp4";
    case "audio/amr":
      return "amr";
    case "audio/wav":
    case "audio/x-wav":
      return "wav";
    case "audio/webm":
      return "webm";
    default:
      return "ogg";
  }
}
