# WhatsApp AI orchestrator (Bedrock + SmartThings)

A WhatsApp Business number backed by Claude on Amazon Bedrock. The model acts as an orchestrator: it reads the user's message, decides which tools to call (listing devices, checking state, sending commands, running scenes), chains them as needed, and replies on WhatsApp.

```
WhatsApp user
   │
Meta Cloud API ──POST /webhook──▶ API Gateway ─▶ Webhook Lambda  (verify signature, return 200 fast)
                                                    │
                                                    ▼
                                             SQS FIFO queue  (per-sender ordering, dedupe)
                                                    │
                                                    ▼
                                            Processor Lambda
                                             ├─ allow-list check + DynamoDB dedupe
                                             ├─ Orchestrator ──▶ Claude on Bedrock (tool use loop)
                                             │      └─ ToolRegistry ─▶ SmartThingsProvider ─▶ SmartThings API
                                             ├─ conversation history (DynamoDB, 24h TTL)
                                             └─ reply ─▶ WhatsApp Graph API
```

## Layout

| Path | What it does |
|---|---|
| `src/handlers/webhook.ts` | Meta callback: GET verification handshake, POST signature check, enqueue to SQS |
| `src/handlers/processor.ts` | SQS consumer: allow-list, dedupe, run the orchestrator, send the reply |
| `src/orchestrator/orchestrator.ts` | The Bedrock tool-use loop (system prompt, parallel tool calls, stop reasons) |
| `src/orchestrator/registry.ts` | Registers tool providers and routes each tool call to its owner |
| `src/orchestrator/types.ts` | `ToolProvider` interface: implement it to add a new integration |
| `src/general/provider.ts` | General tools: `get_current_time`, `get_weather` (Open-Meteo), `convert_currency` (Frankfurter), `wikipedia_lookup`, `web_search` (Tavily, optional) |
| `src/reminders/provider.ts` | `set_reminder`, `schedule_task` (e.g. "turn off the AC in 2 hours"), `list_reminders`, `cancel_reminder` via EventBridge Scheduler |
| `src/lists/provider.ts` | Notes and lists (`add_to_list`, `remove_from_list`, `get_list`, `show_lists`, `delete_list`) in DynamoDB |
| `src/media/transcribe.ts` | Voice notes to text with Amazon Transcribe (auto-detects en-IN, hi-IN, en-US) |
| `src/whatsapp/media.ts` | Downloads inbound voice notes and photos from WhatsApp; photos go to Claude as images |
| `src/smartthings/provider.ts` | SmartThings tools: `list_devices`, `get_device_status`, `send_device_command`, `list_scenes`, `execute_scene` |
| `src/smartthings/auth.ts` | `SmartThingsTokenProvider`: PAT today, swap in OAuth later |
| `src/smartthings/client.ts` | Typed SmartThings REST client |
| `src/whatsapp/*` | Webhook types, signature check, Graph API send/mark-read |
| `src/store/conversation.ts` | DynamoDB history and message dedupe |
| `src/local/chat.ts` | Terminal chat for testing the orchestrator without WhatsApp |
| `template.yaml` | AWS SAM stack: HTTP API, 2 Lambdas, SQS FIFO + DLQ, DynamoDB, Secrets Manager, Scheduler group + role, S3 media bucket |

## Adding another integration

Implement `ToolProvider` (an `id`, optional `instructions` for the system prompt, `tools`, and `execute`) and add it to `createDefaultRegistry()` in `src/orchestrator/registry.ts`. The orchestrator picks up its tools automatically.

## Reminders and the 24-hour window

WhatsApp only allows free-form messages to someone within 24 hours of their last message to the bot. A reminder that fires outside that window is rejected by Meta (logged as `send reply failed`). Sending outside the window needs an approved message template, which this service doesn't use yet.

## Web search (optional)

`web_search` needs a Tavily API key (free tier at https://tavily.com). Add `"TAVILY_API_KEY": "tvly-..."` to the app secret; it's picked up within 5 minutes, no redeploy. Without it the tool reports that search isn't configured and the model answers from its own knowledge. The other general tools need no keys.

## Moving from PAT to OAuth

Everything that needs a SmartThings token goes through `SmartThingsTokenProvider.getAccessToken(waUserId)`. Write an `OAuthTokenProvider` that loads the sender's tokens (e.g. from DynamoDB), refreshes them when expired, and return it from `createTokenProvider()`. There is a sketch in `src/smartthings/auth.ts`. You'll also need a small `/oauth/callback` route to complete the SmartThings authorization flow and store tokens per WhatsApp number.

## Develop

```bash
npm install
npm run typecheck
npm run build          # bundles to dist/webhook, dist/processor, dist/local

# Talk to the orchestrator locally (uses your AWS credentials for Bedrock):
export AWS_REGION=us-east-1 SMARTTHINGS_PAT=...
npm run chat
```

## Deploy (AWS SAM)

Prerequisites: AWS CLI + SAM CLI, and Claude model access enabled in the Bedrock console for your region.

```bash
npm run build
sam deploy --guided      # asks for WhatsAppPhoneNumberId, AllowedSenders, etc.
```

Then put your credentials in the secret the stack created (`AppSecretArn` output):

```bash
aws secretsmanager put-secret-value --secret-id <AppSecretArn> --secret-string '{
  "WHATSAPP_VERIFY_TOKEN": "any-random-string-you-choose",
  "WHATSAPP_APP_SECRET": "<Meta app secret>",
  "WHATSAPP_ACCESS_TOKEN": "<system user access token>",
  "SMARTTHINGS_PAT": "<SmartThings personal access token>"
}'
```

Finally in the Meta developer dashboard (WhatsApp > Configuration): set the callback URL to the `WebhookUrl` output, the verify token to your `WHATSAPP_VERIFY_TOKEN`, and subscribe to the `messages` field.

## Notes

- **Allow list**: anyone can message a business number, so only numbers in `AllowedSenders` are served; everyone else is ignored and logged.
- **Security-sensitive actions** (unlock, open garage, disarm) require the user's confirmation in the chat first; this is in the SmartThings provider's instructions.
- **Retries**: Meta resends webhooks it thinks failed. SQS FIFO dedupe plus a DynamoDB claim per message id make sure a command never runs twice.
- **Model**: `BedrockModelId` defaults to `anthropic.claude-opus-5`; set `anthropic.claude-sonnet-5` or `anthropic.claude-haiku-4-5` for lower cost. `ModelEffort` (`low`/`medium`/`high`) trades depth for speed and tokens; it is not sent for Haiku models, which don't support it.
- **IAM**: the processor's Bedrock permission uses `Resource: "*"`; scope it to your model once chosen.
- Only text (plus button/list replies) is understood today; images and voice notes get a polite "text only" reply.
