import type Anthropic from "@anthropic-ai/sdk";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { config } from "../config.js";
import type { ToolContext, ToolOutcome, ToolProvider } from "../orchestrator/types.js";

// Notes and lists ("shopping", "todo", "movies to watch"), kept per sender in the conversation table
// as one item: pk = "LISTS#<waId>", lists = { name: string[] }. No TTL, so they persist.
// Each sender's messages are processed one at a time (FIFO), so read-modify-write is safe.

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const INSTRUCTIONS = `Notes and lists:
- Use the list tools when the user wants to save, see or change a list or note ("add milk to my shopping list", "what's on my todo list?", "note that the wifi password is on the fridge"). Plain notes go in a list called "notes".
- Use short lowercase list names ("shopping", "todo"). Call show_lists first if unsure which list they mean.`;

const tools: Anthropic.Tool[] = [
  {
    name: "add_to_list",
    description: "Add one or more items to a list, creating the list if needed.",
    input_schema: {
      type: "object",
      properties: {
        list: { type: "string", description: "List name, e.g. 'shopping'." },
        items: { type: "array", items: { type: "string" }, minItems: 1 },
      },
      required: ["list", "items"],
      additionalProperties: false,
    },
  },
  {
    name: "remove_from_list",
    description: "Remove items from a list (matched case-insensitively), e.g. when bought or done.",
    input_schema: {
      type: "object",
      properties: {
        list: { type: "string" },
        items: { type: "array", items: { type: "string" }, minItems: 1 },
      },
      required: ["list", "items"],
      additionalProperties: false,
    },
  },
  {
    name: "get_list",
    description: "Show the items in one list.",
    input_schema: {
      type: "object",
      properties: { list: { type: "string" } },
      required: ["list"],
      additionalProperties: false,
    },
  },
  {
    name: "show_lists",
    description: "Show all of the user's lists with their item counts.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "delete_list",
    description: "Delete a whole list. Only when the user clearly asks to delete or clear it.",
    input_schema: {
      type: "object",
      properties: { list: { type: "string" } },
      required: ["list"],
      additionalProperties: false,
    },
  },
];

type Lists = Record<string, string[]>;

export class ListsProvider implements ToolProvider {
  readonly id = "lists";
  readonly instructions = INSTRUCTIONS;
  readonly tools = tools;

  async execute(toolName: string, input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
    const args = (input ?? {}) as { list?: string; items?: unknown };
    const name = normalise(args.list ?? "");
    const items = Array.isArray(args.items)
      ? args.items.filter((i): i is string => typeof i === "string").map((i) => i.trim()).filter(Boolean)
      : [];
    try {
      const lists = await load(ctx.userId);
      switch (toolName) {
        case "add_to_list": {
          if (!name || items.length === 0) throw new Error("list and items are required");
          const current = lists[name] ?? [];
          const existing = new Set(current.map((i) => i.toLowerCase()));
          const added = items.filter((i) => !existing.has(i.toLowerCase()));
          lists[name] = [...current, ...added];
          await save(ctx.userId, lists);
          return ok({ list: name, added, already_there: items.filter((i) => !added.includes(i)), items: lists[name] });
        }
        case "remove_from_list": {
          const current = lists[name];
          if (!current) throw new Error(`No list called "${name}"`);
          const remove = new Set(items.map((i) => i.toLowerCase()));
          lists[name] = current.filter((i) => !remove.has(i.toLowerCase()));
          const removed = current.filter((i) => remove.has(i.toLowerCase()));
          await save(ctx.userId, lists);
          return ok({ list: name, removed, not_found: items.filter((i) => !removed.some((r) => r.toLowerCase() === i.toLowerCase())), items: lists[name] });
        }
        case "get_list": {
          const current = lists[name];
          if (!current) return ok({ list: name, exists: false, other_lists: Object.keys(lists) });
          return ok({ list: name, items: current });
        }
        case "show_lists":
          return ok(Object.fromEntries(Object.entries(lists).map(([n, i]) => [n, i.length])));
        case "delete_list": {
          if (!lists[name]) throw new Error(`No list called "${name}"`);
          delete lists[name];
          await save(ctx.userId, lists);
          return ok({ deleted: name });
        }
        default:
          return { content: `Unknown tool: ${toolName}`, isError: true };
      }
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  }
}

async function load(userId: string): Promise<Lists> {
  const res = await doc.send(new GetCommand({ TableName: config.tableName, Key: { pk: `LISTS#${userId}` } }));
  return ((res.Item as { lists?: Lists } | undefined)?.lists ?? {}) as Lists;
}

async function save(userId: string, lists: Lists): Promise<void> {
  await doc.send(new PutCommand({ TableName: config.tableName, Item: { pk: `LISTS#${userId}`, lists } }));
}

function normalise(name: string): string {
  return name.trim().toLowerCase().replace(/\s+list$/, "").replace(/\s+/g, " ");
}

function ok(value: unknown): ToolOutcome {
  return { content: JSON.stringify(value), isError: false };
}
