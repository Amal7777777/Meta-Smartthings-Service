# Deploy guide

This gets the bot live on AWS and answering general questions on WhatsApp. The SmartThings token isn't needed yet: you put a placeholder in its slot (step 5) and swap in the real token later, with no code change.

Region used throughout: **us-east-1 (N. Virginia)**. It has the widest Claude availability on Bedrock. If you pick another region, use it everywhere below.

---

## What you'll collect

| # | Credential / value | Where you get it | Where it goes |
|---|---|---|---|
| 1 | AWS access key id + secret key | AWS console → IAM (step 1) | Your computer, via `aws configure` |
| 2 | Phone number ID | Meta dashboard → WhatsApp → API Setup | `sam deploy` prompt `WhatsAppPhoneNumberId` |
| 3 | Your own WhatsApp number | Your phone | `sam deploy` prompt `AllowedSenders` |
| 4 | App secret | Meta dashboard → App settings → Basic | Secrets Manager, key `WHATSAPP_APP_SECRET` |
| 5 | WhatsApp access token | Meta Business settings → System users (or the temporary token on API Setup) | Secrets Manager, key `WHATSAPP_ACCESS_TOKEN` |
| 6 | Verify token | **You make it up** (any random string) | Secrets Manager `WHATSAPP_VERIFY_TOKEN` **and** Meta webhook settings |
| 7 | SmartThings PAT | Later | Secrets Manager `SMARTTHINGS_PAT` (placeholder `not-set-yet` for now) |

Nothing secret goes in the code or in `template.yaml`.

---

## Step 1: AWS account and tools on your computer

1. **Install** (once):
   - Node.js 22 or newer: https://nodejs.org
   - AWS CLI v2: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html
   - AWS SAM CLI: https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html
   Check them: `node -v`, `aws --version`, `sam --version`.

2. **Create deploy credentials** in the AWS console:
   IAM → Users → Create user (e.g. `sam-deployer`) → Attach policies directly → `AdministratorAccess` (fine for a personal account; tighten later) → Create.
   Open the user → Security credentials → Create access key → "Command Line Interface (CLI)" → copy the **Access key ID** and **Secret access key**.

3. **Configure the CLI**:
   ```bash
   aws configure
   # AWS Access Key ID:     <from step 2>
   # AWS Secret Access Key: <from step 2>
   # Default region name:   us-east-1
   # Default output format: json
   ```
   Check: `aws sts get-caller-identity` prints your account id.

## Step 2: Enable Claude on Amazon Bedrock

1. AWS console → switch region to **us-east-1** → open **Amazon Bedrock**.
2. Left menu → **Model catalog** → search **Claude Opus 5** → open it.
3. If it asks for access or a use case form (first time using Anthropic models on the account), fill it in and submit. Approval is usually immediate.
4. Optional check: open the model's playground and send "hi". If it answers, Bedrock is ready.

If you'd rather start cheaper, enable **Claude Sonnet 5** or **Claude Haiku 4.5** instead and set `BedrockModelId` accordingly in step 4.

## Step 3: Meta / WhatsApp app

You said you have a WhatsApp Business account. You also need a Meta **app** with the WhatsApp product.

1. https://developers.facebook.com → My Apps → **Create app** → use case "Other" → type **Business** → link your business portfolio.
2. In the app dashboard, add the **WhatsApp** product → **API Setup**.
3. On **API Setup**, copy:
   - **Phone number ID** (a long number, *not* the phone number itself) → credential #2.
   - While testing with Meta's test number: under "To", **add your own WhatsApp number** as a recipient and confirm the code WhatsApp sends you.
   - To use your real business number instead: "Add phone number" on the same page and follow the steps; then use *its* Phone number ID.
4. **App secret**: App settings → **Basic** → App secret → Show → copy → credential #4.
5. **Access token** (credential #5):
   - Quick test: the "Temporary access token" on API Setup works but **expires in 24 hours**.
   - Permanent (do this before relying on it): business.facebook.com → Settings → Users → **System users** → Add (role Admin) → **Assign assets**: your app (full control) and your WhatsApp account (full control) → **Generate token** → select the app, expiry **Never**, permissions `whatsapp_business_messaging` and `whatsapp_business_management` → copy.
6. **Verify token** (credential #6): make one up, e.g. run `openssl rand -hex 16`, or type a long random string. Keep it for steps 5 and 6.

Leave the Meta tab open; you'll come back for the webhook in step 6.

## Step 4: Deploy the stack

Unzip the project, then in its folder:

```bash
npm install
npm run build
sam deploy --guided
```

Answer the prompts:

| Prompt | Answer |
|---|---|
| Stack Name | `whatsapp-orchestrator` |
| AWS Region | `us-east-1` |
| Parameter WhatsAppPhoneNumberId | Phone number ID from step 3 |
| Parameter AllowedSenders | Your WhatsApp number with country code, no `+` or spaces, e.g. `919876543210`. Several: comma-separated |
| Parameter BedrockModelId | For Claude Haiku 4.5: `us.anthropic.claude-haiku-4-5-20251001-v1:0` (the console's Model ID with `us.` in front, the US cross-region inference profile). Enter keeps `anthropic.claude-opus-5` |
| Parameter ModelEffort | Enter to keep `medium` (ignored for Haiku) |
| Parameter WhatsAppGraphApiVersion | Enter to keep the default |
| Confirm changes before deploy | `y` |
| Allow SAM CLI IAM role creation | `y` |
| Disable rollback | `n` |
| WebhookFunction has no authentication. Is this okay? | `y` (Meta can't send auth headers; the code checks Meta's signature instead) |
| Save arguments to configuration file | `y` |

Confirm the changeset with `y`. When it finishes, note the **Outputs**:
- `WebhookUrl` → e.g. `https://abc123.execute-api.us-east-1.amazonaws.com/webhook`
- `AppSecretArn`

Later redeploys are just `npm run build && sam deploy`.

## Step 5: Put the credentials in Secrets Manager

Console (easiest): AWS console → **Secrets Manager** (us-east-1) → open the secret whose name starts with `AppSecret` → **Retrieve secret value** → **Edit** → **Plaintext** → replace everything with:

```json
{
  "WHATSAPP_VERIFY_TOKEN": "<your made-up verify token>",
  "WHATSAPP_APP_SECRET": "<app secret from step 3.4>",
  "WHATSAPP_ACCESS_TOKEN": "<access token from step 3.5>",
  "SMARTTHINGS_PAT": "not-set-yet"
}
```

`SMARTTHINGS_PAT` must not be empty, so keep the placeholder until you have the real token.

→ Save.

Or with the CLI (macOS/Linux shell):
```bash
aws secretsmanager put-secret-value --secret-id <AppSecretArn> --secret-string '{"WHATSAPP_VERIFY_TOKEN":"...","WHATSAPP_APP_SECRET":"...","WHATSAPP_ACCESS_TOKEN":"...","SMARTTHINGS_PAT":"not-set-yet"}'
```

The Lambdas re-read the secret every 5 minutes, so a changed token is picked up within 5 minutes without redeploying.

## Step 6: Connect Meta's webhook to AWS

Meta app dashboard → WhatsApp → **Configuration** → Webhook → **Edit**:
- **Callback URL**: the `WebhookUrl` output
- **Verify token**: the same made-up verify token
- **Verify and save**. A green check means AWS answered Meta's handshake.

Then under **Webhook fields** → **Manage** → subscribe to **messages**.

## Step 7: Test end to end

1. From the WhatsApp number you put in `AllowedSenders`, send **"hi"** to the business (or test) number.
2. Within a few seconds you should see blue ticks and a typing indicator, then a reply from Claude.
3. Ask a general follow-up, e.g. **"what did I just ask you?"**. It should remember the earlier message (it keeps 24 hours of history per person).

Watch the logs while testing:
```bash
sam logs --stack-name whatsapp-orchestrator --tail
```

### If it doesn't work

| Symptom | Likely cause | Fix |
|---|---|---|
| Meta says "callback URL couldn't be validated" | Secret not filled yet, or verify token differs | Redo step 5, make both tokens identical, redeploy, retry |
| No reply, logs show `bad signature` | Wrong app secret | Re-copy App secret (step 3.4) into the secret |
| No reply, logs show `ignored sender not on allow list` | Number format | Use country code without `+`, exactly as shown in the log line's `from` |
| No reply, logs show `WhatsApp Graph API 401` | Token expired (temporary token lasts 24h) | Create the permanent system-user token (step 3.5) |
| Reply "Sorry, something went wrong", logs mention Bedrock / AccessDenied / model | Model not enabled in us-east-1 | Step 2; or set `BedrockModelId` to a model you've enabled |
| Nothing in logs at all | Webhook field not subscribed | Step 6, subscribe to **messages** |

## Later: turn on SmartThings

1. https://account.smartthings.com/tokens → Generate new token → scopes: Devices (list, see, control), Locations (see), Scenes (see, control) → copy.
2. Replace `not-set-yet` with it in the secret (step 5) and redeploy.
3. Ask on WhatsApp: "turn off the bedroom light".
