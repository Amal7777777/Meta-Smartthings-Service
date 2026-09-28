import type Anthropic from "@anthropic-ai/sdk";
import {
  ConflictException,
  CreateScheduleCommand,
  DeleteScheduleCommand,
  GetScheduleCommand,
  ListSchedulesCommand,
  ResourceNotFoundException,
  SchedulerClient,
} from "@aws-sdk/client-scheduler";
import { config } from "../config.js";
import type { ToolContext, ToolOutcome, ToolProvider } from "../orchestrator/types.js";
import type { QueuedMessage } from "../whatsapp/types.js";

// Reminders and timed tasks use EventBridge Scheduler one-time schedules. Each schedule drops a
// QueuedMessage (with `scheduled` set) onto the same SQS queue as WhatsApp messages at the due time,
// and deletes itself afterwards. Schedule names start with the sender's number, which scopes
// listing and cancelling to that person.

const scheduler = new SchedulerClient({});
const MAX_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;

const INSTRUCTIONS = `Reminders and scheduled tasks:
- Use set_reminder when the user wants to be reminded of something ("remind me at 6pm to call mum"). The message is sent to them word for word, so write it as the reminder itself ("Call mum").
- Use schedule_task when the user wants you to do something later ("turn off the AC in 2 hours", "at 7am tell me the weather"). The instruction is carried out by you at that time with all your tools, so write it as a clear instruction ("Turn off the bedroom AC").
- Give times either as in_minutes, or as a local date and time (at) in the user's time zone. Work out dates like "tomorrow" from the current time given above.
- Never schedule unlocking doors, opening garage doors or gates, or disarming security; say that has to be done live.
- WhatsApp only lets the bot message someone within 24 hours of their last message. When a reminder is more than 24 hours away, mention in a few words that it only arrives if they've messaged the bot in the 24 hours before.
- After scheduling, confirm the time in plain words. Use list_reminders and cancel_reminder when asked what's scheduled or to cancel something.`;

const whenProperties = {
  at: {
    type: "string",
    description: "Local date and time, format YYYY-MM-DDTHH:MM, e.g. 2026-09-26T18:00. Use this or in_minutes.",
  },
  in_minutes: { type: "integer", minimum: 1, description: "Minutes from now. Use this or at." },
  timezone: { type: "string", description: `IANA time zone for 'at'. Defaults to ${config.defaultTimezone}.` },
} as const;

const tools: Anthropic.Tool[] = [
  {
    name: "set_reminder",
    description: "Send the user a WhatsApp reminder message at a later time.",
    input_schema: {
      type: "object",
      properties: { message: { type: "string", description: "Reminder text sent to the user." }, ...whenProperties },
      required: ["message"],
      additionalProperties: false,
    },
  },
  {
    name: "schedule_task",
    description:
      "Have the assistant carry out an instruction at a later time using its tools, e.g. control a device " +
      "or look something up, then message the user the result.",
    input_schema: {
      type: "object",
      properties: {
        instruction: { type: "string", description: "What to do at that time, e.g. 'Turn off the bedroom AC'." },
        ...whenProperties,
      },
      required: ["instruction"],
      additionalProperties: false,
    },
  },
  {
    name: "list_reminders",
    description: "List the user's upcoming reminders and scheduled tasks with their ids and times.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "cancel_reminder",
    description: "Cancel an upcoming reminder or scheduled task by id (from list_reminders).",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
];

export class RemindersProvider implements ToolProvider {
  readonly id = "reminders";
  readonly instructions = INSTRUCTIONS;
  readonly tools = tools;

  async execute(toolName: string, input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
    const args = (input ?? {}) as Record<string, unknown>;
    try {
      switch (toolName) {
        case "set_reminder":
          return ok(await create(ctx.userId, "reminder", str(args.message), args));
        case "schedule_task":
          return ok(await create(ctx.userId, "task", str(args.instruction), args));
        case "list_reminders":
          return ok(await list(ctx.userId));
        case "cancel_reminder":
          return ok(await cancel(ctx.userId, str(args.id)));
        default:
          return { content: `Unknown tool: ${toolName}`, isError: true };
      }
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  }
}

async function create(
  userId: string,
  type: "reminder" | "task",
  text: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (!text) throw new Error(type === "reminder" ? "message is required" : "instruction is required");
  if (!config.scheduleGroup || !config.queueArn || !config.schedulerRoleArn) {
    throw new Error("Reminders are not set up in this deployment");
  }

  const due = resolveDueTime(args);
  const name = `${userId}-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
  const payload: QueuedMessage = {
    messageId: `sched-${name}`,
    from: userId,
    phoneNumberId: config.whatsappPhoneNumberId,
    text,
    scheduled: { type, createdAt: new Date().toISOString() },
  };

  try {
    await scheduler.send(
      new CreateScheduleCommand({
        Name: name,
        GroupName: config.scheduleGroup,
        ScheduleExpression: `at(${due.expression})`,
        ScheduleExpressionTimezone: due.timezone,
        FlexibleTimeWindow: { Mode: "OFF" },
        ActionAfterCompletion: "DELETE",
        Description: `${type}: ${text}`.slice(0, 512),
        Target: {
          Arn: config.queueArn,
          RoleArn: config.schedulerRoleArn,
          Input: JSON.stringify(payload),
          SqsParameters: { MessageGroupId: userId },
          RetryPolicy: { MaximumRetryAttempts: 3, MaximumEventAgeInSeconds: 3600 },
        },
      }),
    );
  } catch (err) {
    if (err instanceof ConflictException) throw new Error("Please try again");
    throw err;
  }

  return { id: name, type, text, due_local: due.display, timezone: due.displayTimezone };
}

async function list(userId: string): Promise<unknown> {
  const items: unknown[] = [];
  let nextToken: string | undefined;
  do {
    const page = await scheduler.send(
      new ListSchedulesCommand({ GroupName: config.scheduleGroup, NamePrefix: `${userId}-`, NextToken: nextToken }),
    );
    for (const s of page.Schedules ?? []) {
      if (!s.Name) continue;
      const detail = await scheduler.send(new GetScheduleCommand({ Name: s.Name, GroupName: config.scheduleGroup }));
      const payload = JSON.parse(detail.Target?.Input ?? "{}") as Partial<QueuedMessage>;
      // Schedules are created in UTC (see resolveDueTime); show them in the user's zone.
      const at = detail.ScheduleExpression?.replace(/^at\((.*)\)$/, "$1");
      items.push({
        id: s.Name,
        type: payload.scheduled?.type,
        text: payload.text,
        due_local: at ? formatLocal(new Date(`${at}Z`), config.defaultTimezone) : undefined,
        timezone: config.defaultTimezone,
      });
    }
    nextToken = page.NextToken;
  } while (nextToken);
  return { count: items.length, items };
}

async function cancel(userId: string, id: string): Promise<unknown> {
  if (!id.startsWith(`${userId}-`)) throw new Error("No reminder with that id");
  try {
    await scheduler.send(new DeleteScheduleCommand({ Name: id, GroupName: config.scheduleGroup }));
  } catch (err) {
    if (err instanceof ResourceNotFoundException) throw new Error("No reminder with that id (it may have already fired)");
    throw err;
  }
  return { cancelled: id };
}

interface DueTime {
  /** yyyy-mm-ddThh:mm:ss for the at() expression, in `timezone`. */
  expression: string;
  timezone: string;
  display: string;
  displayTimezone: string;
}

/** Turns { in_minutes } or { at, timezone } into a Scheduler at() time, checking it's in the future. */
export function resolveDueTime(args: Record<string, unknown>, now = new Date()): DueTime {
  const inMinutes = typeof args.in_minutes === "number" ? args.in_minutes : undefined;
  const at = str(args.at);
  const tz = str(args.timezone) || config.defaultTimezone;

  let dueUtc: Date;
  if (inMinutes !== undefined) {
    if (!(inMinutes >= 1)) throw new Error("in_minutes must be at least 1");
    dueUtc = new Date(now.getTime() + Math.round(inMinutes) * 60_000);
  } else if (at) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(at);
    if (!m) throw new Error("at must look like YYYY-MM-DDTHH:MM");
    const [y, mo, d, h, mi, s] = m.slice(1).map((v) => Number(v ?? 0)) as [number, number, number, number, number, number];
    dueUtc = zonedTimeToUtc(y, mo, d, h, mi, s, tz);
    if (Number.isNaN(dueUtc.getTime())) throw new Error("at is not a valid date");
  } else {
    throw new Error("Give either at or in_minutes");
  }

  if (dueUtc.getTime() < now.getTime() + 30_000) throw new Error("That time is in the past");
  if (dueUtc.getTime() > now.getTime() + MAX_AHEAD_MS) throw new Error("Reminders can be at most a year ahead");

  // Scheduler resolves at() in the given zone; always passing UTC avoids DST ambiguity.
  return {
    expression: dueUtc.toISOString().slice(0, 19),
    timezone: "UTC",
    display: formatLocal(dueUtc, tz),
    displayTimezone: tz,
  };
}

/** The UTC instant for a wall-clock time in an IANA zone. */
function zonedTimeToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): Date {
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  let guess = asUtc - offsetMs(new Date(asUtc), tz);
  guess = asUtc - offsetMs(new Date(guess), tz); // second pass settles DST edges
  return new Date(guess);
}

/** How far the zone's wall clock is ahead of UTC at that instant. */
function offsetMs(instant: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return wall - Math.floor(instant.getTime() / 1000) * 1000;
}

function formatLocal(instant: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(instant);
}

function ok(value: unknown): ToolOutcome {
  return { content: JSON.stringify(value), isError: false };
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
