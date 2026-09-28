import type Anthropic from "@anthropic-ai/sdk";
import { config, getSecrets } from "../config.js";
import type { ToolContext, ToolOutcome, ToolProvider } from "../orchestrator/types.js";

// General-purpose skills that don't depend on SmartThings. All use free public APIs with no key,
// except web_search, which needs TAVILY_API_KEY in the app secret (it reports "not configured" otherwise).

const INSTRUCTIONS = `General skills:
- For the current date or time, call get_current_time; never guess it. Assume the user's time zone is ${config.defaultTimezone} unless they say otherwise.
- For weather or forecasts, call get_weather with the place name.
- For currency conversion, call convert_currency (rates are daily reference rates, so say they are approximate).
- For facts about people, places, events or topics where accuracy matters, call wikipedia_lookup.
- Use web_search for news, prices, scores and anything recent that your own knowledge may not cover.`;

const baseTools: Anthropic.Tool[] = [
  {
    name: "get_current_time",
    description: "Current date, time and weekday in a time zone.",
    input_schema: {
      type: "object",
      properties: {
        timezone: {
          type: "string",
          description: `IANA time zone, e.g. 'Asia/Kolkata', 'America/New_York'. Defaults to ${config.defaultTimezone}.`,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_weather",
    description: "Current weather and a short daily forecast for a place.",
    input_schema: {
      type: "object",
      properties: {
        location: { type: "string", description: "City or place name, e.g. 'Noida' or 'Paris, France'." },
        days: { type: "integer", minimum: 1, maximum: 7, description: "Forecast days including today. Default 3." },
      },
      required: ["location"],
      additionalProperties: false,
    },
  },
  {
    name: "convert_currency",
    description: "Convert an amount between currencies using the latest daily reference rates.",
    input_schema: {
      type: "object",
      properties: {
        amount: { type: "number", description: "Amount to convert. Default 1." },
        from: { type: "string", description: "ISO currency code, e.g. 'USD'." },
        to: { type: "string", description: "ISO currency code, e.g. 'INR'." },
      },
      required: ["from", "to"],
      additionalProperties: false,
    },
  },
  {
    name: "wikipedia_lookup",
    description: "Search English Wikipedia and return the summary of the best matching article.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "What to look up, e.g. 'Qutub Minar'." } },
      required: ["query"],
      additionalProperties: false,
    },
  },
];

const webSearchTool: Anthropic.Tool = {
  name: "web_search",
  description: "Search the web for current information. Returns a short answer and the top results with their URLs.",
  input_schema: {
    type: "object",
    properties: { query: { type: "string", description: "Search query." } },
    required: ["query"],
    additionalProperties: false,
  },
};

const USER_AGENT = "whatsapp-orchestrator/1.0 (personal assistant bot)";

/** Time, weather, currency, Wikipedia and (optionally) web search. */
export class GeneralProvider implements ToolProvider {
  readonly id = "general";
  readonly instructions = INSTRUCTIONS;
  readonly tools = [...baseTools, webSearchTool];

  async execute(toolName: string, input: unknown, _ctx: ToolContext): Promise<ToolOutcome> {
    const args = (input ?? {}) as Record<string, unknown>;
    try {
      switch (toolName) {
        case "get_current_time":
          return ok(currentTime(str(args.timezone) || config.defaultTimezone));
        case "get_weather":
          return ok(await weather(str(args.location), num(args.days) ?? 3));
        case "convert_currency":
          return ok(await convertCurrency(num(args.amount) ?? 1, str(args.from), str(args.to)));
        case "wikipedia_lookup":
          return ok(await wikipedia(str(args.query)));
        case "web_search":
          return ok(await webSearch(str(args.query)));
        default:
          return { content: `Unknown tool: ${toolName}`, isError: true };
      }
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  }
}

function currentTime(timezone: string): unknown {
  const now = new Date();
  const formatted = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, // throws RangeError for an unknown zone, which becomes a tool error
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(now);
  return { timezone, local_time: formatted, utc: now.toISOString() };
}

// WMO weather interpretation codes used by Open-Meteo.
const WEATHER_CODES: Record<number, string> = {
  0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "freezing fog",
  51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 56: "freezing drizzle", 57: "heavy freezing drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "heavy freezing rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
  80: "light showers", 81: "showers", 82: "violent showers", 85: "snow showers", 86: "heavy snow showers",
  95: "thunderstorm", 96: "thunderstorm with hail", 99: "thunderstorm with heavy hail",
};

async function weather(location: string, days: number): Promise<unknown> {
  if (!location) throw new Error("location is required");
  // Geocoding matches on the place name alone, so drop any ", country" suffix and prefer a result in that country.
  const [name = "", ...rest] = location.split(",").map((s) => s.trim());
  const hint = rest.join(" ").toLowerCase();
  const geo = await getJson<{ results?: GeoResult[] }>(
    `https://geocoding-api.open-meteo.com/v1/search?count=5&language=en&format=json&name=${encodeURIComponent(name)}`,
  );
  const results = geo.results ?? [];
  const place =
    (hint && results.find((r) => [r.country, r.admin1, r.country_code].some((v) => v?.toLowerCase().includes(hint)))) ||
    results[0];
  if (!place) throw new Error(`Couldn't find a place called "${location}"`);

  const forecastDays = Math.min(Math.max(Math.round(days), 1), 7);
  const f = await getJson<Forecast>(
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
      "&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m" +
      "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max" +
      `&timezone=auto&forecast_days=${forecastDays}`,
  );

  return {
    place: [place.name, place.admin1, place.country].filter(Boolean).join(", "),
    current: {
      time: f.current.time,
      condition: describe(f.current.weather_code),
      temperature_c: f.current.temperature_2m,
      feels_like_c: f.current.apparent_temperature,
      humidity_pct: f.current.relative_humidity_2m,
      precipitation_mm: f.current.precipitation,
      wind_kmh: f.current.wind_speed_10m,
    },
    daily: f.daily.time.map((date, i) => ({
      date,
      condition: describe(f.daily.weather_code[i]),
      max_c: f.daily.temperature_2m_max[i],
      min_c: f.daily.temperature_2m_min[i],
      rain_chance_pct: f.daily.precipitation_probability_max?.[i] ?? null,
    })),
  };
}

function describe(code: number | undefined): string {
  if (code === undefined) return "unknown";
  return WEATHER_CODES[code] ?? `code ${code}`;
}

interface GeoResult {
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  country_code?: string;
  admin1?: string;
}

interface Forecast {
  current: {
    time: string;
    temperature_2m: number;
    apparent_temperature: number;
    relative_humidity_2m: number;
    precipitation: number;
    weather_code: number;
    wind_speed_10m: number;
  };
  daily: {
    time: string[];
    weather_code: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    precipitation_probability_max?: (number | null)[];
  };
}

async function convertCurrency(amount: number, from: string, to: string): Promise<unknown> {
  const base = from.toUpperCase();
  const target = to.toUpperCase();
  if (!/^[A-Z]{3}$/.test(base) || !/^[A-Z]{3}$/.test(target)) throw new Error("Use 3-letter currency codes, e.g. USD, INR");
  if (base === target) return { amount, from: base, to: target, rate: 1, result: amount };
  const res = await getJson<{ date: string; rates: Record<string, number> }>(
    `https://api.frankfurter.dev/v1/latest?base=${base}&symbols=${target}`,
  );
  const rate = res.rates[target];
  if (rate === undefined) throw new Error(`No rate available for ${base} to ${target}`);
  return { amount, from: base, to: target, rate, result: Math.round(amount * rate * 100) / 100, rate_date: res.date };
}

async function wikipedia(query: string): Promise<unknown> {
  if (!query) throw new Error("query is required");
  const search = await getJson<{ pages?: { key: string; title: string; description?: string }[] }>(
    `https://en.wikipedia.org/w/rest.php/v1/search/page?limit=3&q=${encodeURIComponent(query)}`,
  );
  const top = search.pages?.[0];
  if (!top) return { found: false, query };
  const summary = await getJson<{ title: string; extract: string; content_urls?: { desktop?: { page?: string } } }>(
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(top.key)}`,
  );
  return {
    title: summary.title,
    summary: summary.extract,
    url: summary.content_urls?.desktop?.page,
    other_matches: (search.pages ?? []).slice(1).map((p) => p.title),
  };
}

async function webSearch(query: string): Promise<unknown> {
  if (!query) throw new Error("query is required");
  const { TAVILY_API_KEY } = await getSecrets();
  if (!TAVILY_API_KEY) throw new Error("Web search is not configured (no TAVILY_API_KEY in the app secret). Answer from your own knowledge and say it may be out of date.");
  const res = await getJson<{ answer?: string; results?: { title: string; url: string; content: string }[] }>(
    "https://api.tavily.com/search",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${TAVILY_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, max_results: 5, include_answer: true }),
    },
  );
  return {
    answer: res.answer,
    results: (res.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content.slice(0, 500) })),
  };
}

async function getJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...(init.headers as Record<string, string>) },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${new URL(url).hostname} returned ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

function ok(value: unknown): ToolOutcome {
  return { content: JSON.stringify(value), isError: false };
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
