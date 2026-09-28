import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

/**
 * Secrets the service needs. In AWS they live in one Secrets Manager secret (JSON),
 * named by APP_SECRET_ARN. Locally, each can be set as an environment variable instead.
 */
export interface Secrets {
  /** Token you type into the Meta dashboard when registering the callback URL. */
  WHATSAPP_VERIFY_TOKEN: string;
  /** Meta app secret, used to verify the X-Hub-Signature-256 header. */
  WHATSAPP_APP_SECRET: string;
  /** System-user (permanent) access token for the WhatsApp Cloud API. */
  WHATSAPP_ACCESS_TOKEN: string;
  /** SmartThings Personal Access Token. Replaced by per-user OAuth tokens later. */
  SMARTTHINGS_PAT: string;
  /** Optional Tavily API key for the web_search tool. Web search is off without it. */
  TAVILY_API_KEY?: string;
}

const SECRET_KEYS: (keyof Secrets)[] = [
  "WHATSAPP_VERIFY_TOKEN",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_ACCESS_TOKEN",
  "SMARTTHINGS_PAT",
];

// Re-read the secret every few minutes so rotated tokens are picked up without a redeploy.
const SECRETS_TTL_MS = 5 * 60 * 1000;
let cachedSecrets: Promise<Secrets> | undefined;
let cachedAt = 0;

export function getSecrets(): Promise<Secrets> {
  if (!cachedSecrets || Date.now() - cachedAt > SECRETS_TTL_MS) {
    cachedAt = Date.now();
    cachedSecrets = loadSecrets().catch((err) => {
      cachedSecrets = undefined; // retry on the next invocation
      throw err;
    });
  }
  return cachedSecrets;
}

async function loadSecrets(): Promise<Secrets> {
  let fromSecretsManager: Partial<Secrets> = {};
  const arn = process.env.APP_SECRET_ARN;
  if (arn) {
    const sm = new SecretsManagerClient({});
    const res = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
    if (!res.SecretString) throw new Error(`Secret ${arn} has no SecretString`);
    fromSecretsManager = JSON.parse(res.SecretString) as Partial<Secrets>;
  }

  const secrets = {} as Secrets;
  for (const key of SECRET_KEYS) {
    const value = fromSecretsManager[key] ?? process.env[key];
    if (!value) throw new Error(`Missing secret ${key} (set it in APP_SECRET_ARN or the environment)`);
    secrets[key] = value;
  }
  secrets.TAVILY_API_KEY = fromSecretsManager.TAVILY_API_KEY ?? process.env.TAVILY_API_KEY;
  return secrets;
}

function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.length > 0 ? value : fallback;
}

export const config = {
  /** Bedrock model id. Opus 5 by default; set to e.g. anthropic.claude-sonnet-5 for lower cost. */
  bedrockModelId: optionalEnv("BEDROCK_MODEL_ID", "anthropic.claude-opus-5"),
  /**
   * low | medium | high, or "off" to not send it. Haiku 4.5 rejects the effort setting,
   * so it is never sent for Haiku models regardless of this value.
   */
  modelEffort: optionalEnv("MODEL_EFFORT", "medium") as "low" | "medium" | "high" | "off",
  awsRegion: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION,

  whatsappGraphVersion: optionalEnv("WHATSAPP_GRAPH_API_VERSION", "v23.0"),
  /** Phone number id of the business number (from the WhatsApp > API Setup page). */
  whatsappPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? "",

  /**
   * Comma-separated E.164 numbers without "+", e.g. "919876543210,14155550100".
   * Only these senders may control devices. Empty means nobody (fail closed).
   */
  allowedSenders: new Set(
    (process.env.ALLOWED_SENDERS ?? "")
      .split(",")
      .map((s) => s.trim().replace(/^\+/, ""))
      .filter(Boolean),
  ),

  smartthingsApiBase: optionalEnv("SMARTTHINGS_API_BASE", "https://api.smartthings.com/v1"),

  queueUrl: process.env.QUEUE_URL ?? "",
  tableName: process.env.TABLE_NAME ?? "",

  /** Reminders: EventBridge Scheduler group, the queue schedules deliver to, and the role they use. */
  scheduleGroup: process.env.SCHEDULE_GROUP ?? "",
  queueArn: process.env.QUEUE_ARN ?? "",
  schedulerRoleArn: process.env.SCHEDULER_ROLE_ARN ?? "",
  /** S3 bucket where voice notes are staged for Amazon Transcribe. */
  mediaBucket: process.env.MEDIA_BUCKET ?? "",
  /** How many previous user/assistant turns to send back to the model. */
  historyTurns: Number(optionalEnv("HISTORY_TURNS", "10")),
  /** Time zone the assistant assumes for dates and times unless the user names another. */
  defaultTimezone: optionalEnv("DEFAULT_TIMEZONE", "Asia/Kolkata"),
};
