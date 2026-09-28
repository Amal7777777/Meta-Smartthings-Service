import type Anthropic from "@anthropic-ai/sdk";

/** Who the orchestrator is acting for on this request. */
export interface ToolContext {
  /** WhatsApp id (phone number) of the sender. Providers use it to pick that user's credentials. */
  userId: string;
}

export interface ToolOutcome {
  content: string;
  isError: boolean;
}

/**
 * A capability the orchestrator can use: a set of tools plus the code that runs them.
 * SmartThings is the first provider; add others (weather, calendar, another smart-home API)
 * by implementing this interface and registering it in orchestrator/registry.ts.
 */
export interface ToolProvider {
  /** Short id, used in logs. */
  readonly id: string;
  /** Extra guidance for the model about when and how to use these tools. Appended to the system prompt. */
  readonly instructions?: string;
  /** Tool definitions shown to the model. Names must be unique across all providers. */
  readonly tools: Anthropic.Tool[];
  /** Runs one tool call. Should not throw: return { isError: true } so the model can recover. */
  execute(toolName: string, input: unknown, ctx: ToolContext): Promise<ToolOutcome>;
}
