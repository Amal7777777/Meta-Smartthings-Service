import { config } from "../config.js";

// Minimal typed client for the SmartThings REST API.
// https://developer.smartthings.com/docs/api/public

export interface StDevice {
  deviceId: string;
  name?: string;
  label?: string;
  locationId?: string;
  roomId?: string;
  components?: { id: string; capabilities?: { id: string; version?: number }[] }[];
}

export interface StLocation {
  locationId: string;
  name: string;
}

export interface StRoom {
  roomId: string;
  locationId: string;
  name: string;
}

export interface StScene {
  sceneId: string;
  sceneName: string;
  locationId?: string;
}

export interface StCommand {
  component?: string;
  capability: string;
  command: string;
  arguments?: unknown[];
}

interface Paged<T> {
  items: T[];
  _links?: { next?: { href?: string } | null };
}

export class SmartThingsError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`SmartThings API ${status}: ${body.slice(0, 500)}`);
  }
}

export class SmartThingsClient {
  constructor(
    private readonly token: string,
    private readonly baseUrl = config.smartthingsApiBase,
  ) {}

  private async request<T>(method: string, pathOrUrl: string, body?: unknown): Promise<T> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${this.baseUrl}${pathOrUrl}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new SmartThingsError(res.status, text);
    return (text ? JSON.parse(text) : {}) as T;
  }

  private async listAll<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    let next: string | undefined = path;
    while (next) {
      const page: Paged<T> = await this.request<Paged<T>>("GET", next);
      out.push(...(page.items ?? []));
      next = page._links?.next?.href ?? undefined;
    }
    return out;
  }

  listDevices(): Promise<StDevice[]> {
    return this.listAll<StDevice>("/devices");
  }

  getDevice(deviceId: string): Promise<StDevice> {
    return this.request("GET", `/devices/${encodeURIComponent(deviceId)}`);
  }

  /** Full status: { components: { main: { switch: { switch: { value: "on" } } } } } */
  getDeviceStatus(deviceId: string): Promise<{ components: Record<string, Record<string, Record<string, { value: unknown; unit?: string }>>> }> {
    return this.request("GET", `/devices/${encodeURIComponent(deviceId)}/status`);
  }

  executeCommands(deviceId: string, commands: StCommand[]): Promise<{ results?: { id: string; status: string }[] }> {
    const normalized = commands.map((c) => ({
      component: c.component ?? "main",
      capability: c.capability,
      command: c.command,
      arguments: c.arguments ?? [],
    }));
    return this.request("POST", `/devices/${encodeURIComponent(deviceId)}/commands`, { commands: normalized });
  }

  listLocations(): Promise<StLocation[]> {
    return this.listAll<StLocation>("/locations");
  }

  listRooms(locationId: string): Promise<StRoom[]> {
    return this.listAll<StRoom>(`/locations/${encodeURIComponent(locationId)}/rooms`);
  }

  listScenes(): Promise<StScene[]> {
    return this.listAll<StScene>("/scenes");
  }

  executeScene(sceneId: string): Promise<{ status?: string }> {
    return this.request("POST", `/scenes/${encodeURIComponent(sceneId)}/execute`);
  }
}
