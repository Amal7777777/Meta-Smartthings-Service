import type Anthropic from "@anthropic-ai/sdk";
import type { ToolContext, ToolOutcome, ToolProvider } from "../orchestrator/types.js";
import type { SmartThingsTokenProvider } from "./auth.js";
import { SmartThingsClient, SmartThingsError, type StCommand } from "./client.js";

const INSTRUCTIONS = `Smart home (Samsung SmartThings):
- To act on a device the user names ("bedroom light", "the AC"), look it up with list_devices first and use its device_id. Never guess or invent a device_id; only use ids returned by list_devices. If several devices could match, ask which one.
- After sending a command, confirm in one short sentence what you did. If it fails, say what failed in plain words.
- For questions about state ("is the door locked?", "what's the temperature?"), use get_device_status and answer directly.
- Ask for confirmation before anything that affects safety or security: unlocking a door, opening a garage door or gate, or disarming a security system. Only act once the user has confirmed in their latest message.`;

const tools: Anthropic.Tool[] = [
  {
    name: "list_devices",
    description:
      "List the user's SmartThings devices with their id, name, room and capabilities. " +
      "Call this first to find the device id for anything the user mentions by name or room. " +
      "Optionally filter by room name or capability id (e.g. 'switch', 'switchLevel', 'lock', 'thermostatCoolingSetpoint').",
    input_schema: {
      type: "object",
      properties: {
        room: { type: "string", description: "Case-insensitive room name filter, e.g. 'Bedroom'." },
        capability: { type: "string", description: "Only return devices that have this capability id." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_device_status",
    description:
      "Get the current state of one device (on/off, level, temperature, lock state, battery, etc.) " +
      "for every component and capability.",
    input_schema: {
      type: "object",
      properties: { device_id: { type: "string", description: "Device id from list_devices." } },
      required: ["device_id"],
      additionalProperties: false,
    },
  },
  {
    name: "send_device_command",
    description:
      "Send one or more commands to a device. Use capability and command ids exactly as SmartThings defines them. " +
      "Examples: switch/on, switch/off, switchLevel/setLevel [50], colorControl/setColor [{hue:..,saturation:..}], " +
      "colorTemperature/setColorTemperature [2700], thermostatCoolingSetpoint/setCoolingSetpoint [24], " +
      "lock/lock, lock/unlock, airConditionerMode/setAirConditionerMode ['cool'], fanSpeed/setFanSpeed [2]. " +
      "Only use capabilities the device lists.",
    input_schema: {
      type: "object",
      properties: {
        device_id: { type: "string", description: "Device id from list_devices." },
        commands: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              component: { type: "string", description: "Component id, usually 'main'." },
              capability: { type: "string" },
              command: { type: "string" },
              arguments: { type: "array", description: "Positional command arguments, if any.", items: {} },
            },
            required: ["capability", "command"],
            additionalProperties: false,
          },
        },
      },
      required: ["device_id", "commands"],
      additionalProperties: false,
    },
  },
  {
    name: "list_scenes",
    description: "List the user's SmartThings scenes (id and name).",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "execute_scene",
    description: "Run a SmartThings scene by id (from list_scenes).",
    input_schema: {
      type: "object",
      properties: { scene_id: { type: "string" } },
      required: ["scene_id"],
      additionalProperties: false,
    },
  },
];

/** Exposes SmartThings devices and scenes to the orchestrator. */
export class SmartThingsProvider implements ToolProvider {
  readonly id = "smartthings";
  readonly instructions = INSTRUCTIONS;
  readonly tools = tools;

  constructor(private readonly tokens: SmartThingsTokenProvider) {}

  async execute(toolName: string, input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
    const st = new SmartThingsClient(await this.tokens.getAccessToken(ctx.userId));
    return runTool(st, toolName, input);
  }
}

/** Runs one tool call. Never throws: failures come back as an error result the model can read. */
async function runTool(st: SmartThingsClient, name: string, input: unknown): Promise<ToolOutcome> {
  try {
    const args = (input ?? {}) as Record<string, unknown>;
    const result = await dispatch(st, name, args);
    return { content: JSON.stringify(result), isError: false };
  } catch (err) {
    const message =
      err instanceof SmartThingsError
        ? `SmartThings returned ${err.status}: ${err.body.slice(0, 1000)}`
        : err instanceof Error
          ? err.message
          : String(err);
    return { content: message, isError: true };
  }
}

async function dispatch(st: SmartThingsClient, name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "list_devices":
      return listDevices(st, optionalString(args, "room"), optionalString(args, "capability"));
    case "get_device_status":
      return getDeviceStatus(st, requireString(args, "device_id"));
    case "send_device_command": {
      const deviceId = requireString(args, "device_id");
      const commands = parseCommands(args.commands);
      const res = await st.executeCommands(deviceId, commands);
      return { ok: true, results: res.results ?? [] };
    }
    case "list_scenes": {
      const scenes = await st.listScenes();
      return scenes.map((s) => ({ scene_id: s.sceneId, name: s.sceneName }));
    }
    case "execute_scene": {
      const res = await st.executeScene(requireString(args, "scene_id"));
      return { ok: true, status: res.status ?? "success" };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function listDevices(st: SmartThingsClient, room?: string, capability?: string) {
  const [devices, roomNames] = await Promise.all([st.listDevices(), roomNameMap(st)]);
  return devices
    .map((d) => {
      const capabilities = [
        ...new Set((d.components ?? []).flatMap((c) => (c.capabilities ?? []).map((cap) => cap.id))),
      ].filter((id) => id !== "healthCheck" && id !== "refresh");
      const components = (d.components ?? []).map((c) => c.id);
      return {
        device_id: d.deviceId,
        name: d.label || d.name || d.deviceId,
        room: d.roomId ? roomNames.get(d.roomId) ?? null : null,
        capabilities,
        ...(components.length > 1 ? { components } : {}),
      };
    })
    .filter((d) => !room || d.room?.toLowerCase() === room.toLowerCase())
    .filter((d) => !capability || d.capabilities.includes(capability));
}

async function roomNameMap(st: SmartThingsClient): Promise<Map<string, string>> {
  const locations = await st.listLocations();
  const rooms = (await Promise.all(locations.map((l) => st.listRooms(l.locationId)))).flat();
  return new Map(rooms.map((r) => [r.roomId, r.name]));
}

async function getDeviceStatus(st: SmartThingsClient, deviceId: string) {
  const status = await st.getDeviceStatus(deviceId);
  // Flatten to { "main.switch.switch": "on", "main.temperatureMeasurement.temperature": "23 C" }
  const flat: Record<string, unknown> = {};
  for (const [component, caps] of Object.entries(status.components ?? {})) {
    for (const [capability, attrs] of Object.entries(caps)) {
      if (capability === "healthCheck") continue;
      for (const [attribute, state] of Object.entries(attrs)) {
        if (state?.value === null || state?.value === undefined) continue;
        flat[`${component}.${capability}.${attribute}`] = state.unit ? `${String(state.value)} ${state.unit}` : state.value;
      }
    }
  }
  return { device_id: deviceId, state: flat };
}

function parseCommands(value: unknown): StCommand[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("commands must be a non-empty array");
  return value.map((raw, i) => {
    const c = (raw ?? {}) as Record<string, unknown>;
    if (typeof c.capability !== "string" || typeof c.command !== "string") {
      throw new Error(`commands[${i}] needs string capability and command`);
    }
    if (c.arguments !== undefined && !Array.isArray(c.arguments)) {
      throw new Error(`commands[${i}].arguments must be an array`);
    }
    return {
      component: typeof c.component === "string" ? c.component : "main",
      capability: c.capability,
      command: c.command,
      arguments: (c.arguments as unknown[] | undefined) ?? [],
    };
  });
}

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) throw new Error(`${key} is required`);
  return v;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
