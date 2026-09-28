import type Anthropic from "@anthropic-ai/sdk";
import { GeneralProvider } from "../general/provider.js";
import { ListsProvider } from "../lists/provider.js";
import { RemindersProvider } from "../reminders/provider.js";
import { createTokenProvider } from "../smartthings/auth.js";
import { SmartThingsProvider } from "../smartthings/provider.js";
import type { ToolContext, ToolOutcome, ToolProvider } from "./types.js";

/** Holds every registered provider and routes each tool call to the provider that owns it. */
export class ToolRegistry {
  private readonly byToolName = new Map<string, ToolProvider>();

  constructor(private readonly providers: ToolProvider[]) {
    for (const provider of providers) {
      for (const tool of provider.tools) {
        if (this.byToolName.has(tool.name)) {
          throw new Error(`Tool name "${tool.name}" is registered by two providers`);
        }
        this.byToolName.set(tool.name, provider);
      }
    }
  }

  get tools(): Anthropic.Tool[] {
    return this.providers.flatMap((p) => p.tools);
  }

  get instructions(): string[] {
    return this.providers.flatMap((p) => (p.instructions ? [p.instructions] : []));
  }

  async execute(toolName: string, input: unknown, ctx: ToolContext): Promise<ToolOutcome & { providerId: string }> {
    const provider = this.byToolName.get(toolName);
    if (!provider) return { providerId: "none", content: `Unknown tool: ${toolName}`, isError: true };
    try {
      return { providerId: provider.id, ...(await provider.execute(toolName, input, ctx)) };
    } catch (err) {
      return { providerId: provider.id, content: err instanceof Error ? err.message : String(err), isError: true };
    }
  }
}

/** The providers this deployment uses. Register new integrations here. */
export function createDefaultRegistry(): ToolRegistry {
  return new ToolRegistry([
    new GeneralProvider(),
    new RemindersProvider(),
    new ListsProvider(),
    new SmartThingsProvider(createTokenProvider()),
  ]);
}
