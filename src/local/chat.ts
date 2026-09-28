// Local test console: talk to the orchestrator in your terminal, without WhatsApp or DynamoDB.
// Needs AWS credentials with Bedrock access, AWS_REGION and SMARTTHINGS_PAT in the environment.
//   npm run chat

import { createInterface } from "node:readline/promises";
import { Orchestrator, type ChatTurn } from "../orchestrator/orchestrator.js";
import { createDefaultRegistry } from "../orchestrator/registry.js";

// Only the SmartThings token is used locally; placeholders satisfy the secrets loader.
for (const key of ["WHATSAPP_VERIFY_TOKEN", "WHATSAPP_APP_SECRET", "WHATSAPP_ACCESS_TOKEN"]) {
  process.env[key] ??= "unused-locally";
}

async function main() {
  const orchestrator = new Orchestrator(createDefaultRegistry());
  const history: ChatTurn[] = [];
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log("Type a message (Ctrl+C to quit).");
  for (;;) {
    const text = (await rl.question("you> ")).trim();
    if (!text) continue;
    const reply = await orchestrator.handle(history, text, { userId: "local" });
    console.log(`bot> ${reply}\n`);
    history.push({ role: "user", text }, { role: "assistant", text: reply });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
