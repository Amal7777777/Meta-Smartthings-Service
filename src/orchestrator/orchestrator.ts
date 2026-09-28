import { AnthropicBedrock, AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import type Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import type { ToolRegistry } from "./registry.js";
import type { ToolContext } from "./types.js";

const BASE_PROMPT = `You are an AI assistant that people talk to over WhatsApp. You orchestrate the tools you've been given to get things done for them: work out what they want, call whichever tools are needed (several in a row, or in parallel when they are independent), and report back.

You are a general assistant, not only a smart-home controller. Answer general questions (explanations, advice, writing, maths, translations, recommendations and so on) directly from your own knowledge. Use tools when a request needs live or personal data, such as the weather, exchange rates, recent events, the user's lists and reminders, or their devices. Users can also send voice notes (you receive the transcript) and photos (you see the image). If something truly needs a tool you don't have, say so plainly instead of guessing.

Reply style: this is WhatsApp. Keep replies short and conversational. Use plain text; *single asterisks* for bold is fine, but no Markdown headings, tables or links.`;

const MAX_TOOL_ROUNDS = 10;

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

export class Orchestrator {
  private readonly systemPrompt: string;
  private readonly bedrock: AnthropicBedrock | AnthropicBedrockMantle;

  constructor(private readonly registry: ToolRegistry) {
    this.systemPrompt = [BASE_PROMPT, ...registry.instructions].join("\n\n");
    // Both sign requests with the Lambda execution role's credentials (SigV4) in AWS_REGION.
    // Versioned ids from the Bedrock console ("anthropic.claude-haiku-4-5-20251001-v1:0") and
    // inference-profile ids ("us.anthropic…", "global.anthropic…") go through bedrock-runtime;
    // short ids ("anthropic.claude-opus-5") go through the Mantle Messages endpoint.
    this.bedrock = usesBedrockRuntime(config.bedrockModelId)
      ? new AnthropicBedrock({ awsRegion: config.awsRegion })
      : new AnthropicBedrockMantle({ awsRegion: config.awsRegion });
  }

  /**
   * Runs one user message through the model, executing tool calls until it has an answer.
   * Returns the text to send back on WhatsApp.
   */
  async handle(
    history: ChatTurn[],
    userContent: string | Anthropic.ContentBlockParam[],
    ctx: ToolContext,
  ): Promise<string> {
    const messages: Anthropic.MessageParam[] = [
      ...history.map((t): Anthropic.MessageParam => ({ role: t.role, content: t.text })),
      { role: "user", content: userContent },
    ];
    // The model has no clock, so tell it the time; reminders and "tomorrow" depend on it.
    const system = `${this.systemPrompt}\n\nCurrent time: ${nowIn(config.defaultTimezone)} (${config.defaultTimezone}).`;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await this.bedrock.messages.create({
        model: config.bedrockModelId,
        max_tokens: 16000,
        system,
        tools: this.registry.tools,
        ...effortParam(),
        messages,
      });

      if (response.stop_reason === "refusal") {
        return "Sorry, I can't help with that request.";
      }

      const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
        const text = textOf(response);
        if (!text && response.stop_reason === "max_tokens") return "Sorry, that answer got too long. Could you narrow it down?";
        return text || "Done.";
      }

      // Keep the whole assistant turn (thinking blocks included) so the tool loop stays valid.
      messages.push({ role: "assistant", content: response.content });

      // Run this turn's calls concurrently and return every result in a single user message.
      const results = await Promise.all(
        toolUses.map(async (tu): Promise<Anthropic.ToolResultBlockParam> => {
          const outcome = await this.registry.execute(tu.name, tu.input, ctx);
          console.log(
            JSON.stringify({
              msg: "tool_call",
              provider: outcome.providerId,
              tool: tu.name,
              input: tu.input,
              isError: outcome.isError,
              ...(outcome.isError ? { error: outcome.content.slice(0, 500) } : {}),
            }),
          );
          return { type: "tool_result", tool_use_id: tu.id, content: outcome.content, is_error: outcome.isError };
        }),
      );
      messages.push({ role: "user", content: results });
    }

    return "Sorry, that took too many steps. Could you try asking in a simpler way?";
  }
}

function usesBedrockRuntime(modelId: string): boolean {
  return modelId.includes(":") || /^(us|eu|apac|global|jp|au)\./.test(modelId);
}

/** The effort setting, left out for models that don't support it (Haiku 4.5) or when turned off. */
function effortParam(): { output_config?: { effort: "low" | "medium" | "high" } } {
  const effort = config.modelEffort;
  if (effort === "off" || config.bedrockModelId.includes("haiku")) return {};
  return { output_config: { effort } };
}

function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function nowIn(timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
}
