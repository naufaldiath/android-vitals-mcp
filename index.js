#!/usr/bin/env node

// Subcommand dispatch — must come before any MCP server code
if (process.argv[2] === "setup") {
  const { default: setup } = await import("./bin/setup-mcp.js");
  process.exit(await setup() ?? 0);
}

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { google } from "googleapis";

// Environment variables
const SERVICE_ACCOUNT_FILE = process.env.GOOGLE_APPLICATION_CREDENTIALS;
const PACKAGE_NAME = process.env.ANDROID_PACKAGE_NAME;

const missing = [
  !SERVICE_ACCOUNT_FILE && "GOOGLE_APPLICATION_CREDENTIALS",
  !PACKAGE_NAME         && "ANDROID_PACKAGE_NAME",
].filter(Boolean);

// Lazy-initialized auth — only created when env vars are present
let auth = null;
if (SERVICE_ACCOUNT_FILE && PACKAGE_NAME) {
  auth = new google.auth.GoogleAuth({
    keyFile: SERVICE_ACCOUNT_FILE,
    scopes: ["https://www.googleapis.com/auth/playdeveloperreporting"],
  });
}

// Calls the REST API directly: the bundled googleapis client has no methods for
// newer metric sets (LMK, memory). Queries are read-only, so POSTs are retried too.
const API_ROOT = "https://playdeveloperreporting.googleapis.com/v1beta1";
async function apiRequest(path, { method = "GET", params, data } = {}) {
  const client = await auth.getClient();
  const response = await client.request({
    url: `${API_ROOT}/${path}`,
    method,
    params,
    data,
    retryConfig: { retry: 2, httpMethodsToRetry: ["GET", "POST"] },
  });
  return response.data;
}

const CONFIG_HINT = `\
To fix this, add the missing value(s) to your MCP host config and restart.

Example entry in ~/.claude.json (or ~/.gemini/mcp.json):

  {
    "mcpServers": {
      "android-vitals": {
        "command": "npx",
        "args": ["-y", "android-vitals-mcp"],
        "env": {
          "GOOGLE_APPLICATION_CREDENTIALS": "/absolute/path/to/service-account-key.json",
          "ANDROID_PACKAGE_NAME": "com.your.company.app"
        }
      }
    }
  }

Where to get each value:

  GOOGLE_APPLICATION_CREDENTIALS
    Path to a Google Service Account JSON key.
    1. Google Cloud Console → IAM & Admin → Service Accounts
       https://console.cloud.google.com/iam-admin/serviceaccounts
    2. Create a service account, add a JSON key, download it.
    3. Google Play Console → Setup → API access → grant that account
       "View app information (read-only)".

  ANDROID_PACKAGE_NAME
    Your app's package ID (e.g. com.example.myapp).
    Find it in Google Play Console → All apps → select your app.`;

// Breakdown dimensions the rate metric sets accept (Play Developer Reporting API v1beta1).
const BREAKDOWN_DIMENSIONS = [
  "versionCode", "apiLevel", "deviceModel", "deviceBrand", "deviceType", "countryCode",
  "deviceRamBucket", "deviceSocMake", "deviceSocModel", "deviceCpuMake", "deviceCpuModel",
  "deviceGpuMake", "deviceGpuModel", "deviceGpuVersion", "deviceVulkanVersion",
  "deviceGlEsVersion", "deviceScreenSize", "deviceScreenDpi",
];
const MEMORY_DIMENSIONS = [...BREAKDOWN_DIMENSIONS, "processName", "appState"];
// errorCountMetricSet has no countryCode / deviceBrand, but can break down by error issue.
const ERROR_COUNT_DIMENSIONS = [
  ...BREAKDOWN_DIMENSIONS.filter((d) => d !== "countryCode" && d !== "deviceBrand"),
  "issueId",
];
const START_TYPES = ["COLD", "WARM", "HOT"];
const REPORT_TYPES = ["CRASH", "ANR"];
// Display order for `overall` entries split by a required dimension.
const REQUIRED_DIMENSION_ORDER = { startType: START_TYPES, reportType: REPORT_TYPES };
const DEFAULT_DIMENSIONS = ["versionCode"];
const DEFAULT_LIMIT = 10;
const PAGE_SIZE = 10000;
const MAX_PAGES = 10;

const rateSet = (metrics, requiredDimensions = []) =>
  ({ kind: "rate", metrics, requiredDimensions, dimensions: BREAKDOWN_DIMENSIONS });
const memorySet = (prefix) => ({
  kind: "memory",
  metrics: ["P50", "P75", "P90", "P95", "P99"].map((p) => `${prefix}${p}`).concat("distinctUsers"),
  requiredDimensions: [],
  dimensions: MEMORY_DIMENSIONS,
});

// `kind` decides how values are presented (see KINDS). `requiredDimensions` go into every
// query because the API rejects the metric set without them.
const METRIC_SETS = {
  crashRateMetricSet: rateSet([
    "userPerceivedCrashRate", "userPerceivedCrashRate7dUserWeighted",
    "userPerceivedCrashRate28dUserWeighted", "crashRate", "distinctUsers",
  ]),
  anrRateMetricSet: rateSet([
    "userPerceivedAnrRate", "userPerceivedAnrRate7dUserWeighted",
    "userPerceivedAnrRate28dUserWeighted", "anrRate", "distinctUsers",
  ]),
  slowRenderingRateMetricSet: rateSet(["slowRenderingRate20Fps", "slowRenderingRate30Fps", "distinctUsers"]),
  slowStartRateMetricSet: rateSet(
    ["slowStartRate", "slowStartRate7dUserWeighted", "slowStartRate28dUserWeighted", "distinctUsers"],
    ["startType"]
  ),
  lmkRateMetricSet: rateSet([
    "userPerceivedLmkRate", "userPerceivedLmkRate7dUserWeighted",
    "userPerceivedLmkRate28dUserWeighted", "distinctUsers",
  ]),
  excessiveWakeupRateMetricSet: rateSet([
    "excessiveWakeupRate", "excessiveWakeupRate7dUserWeighted",
    "excessiveWakeupRate28dUserWeighted", "distinctUsers",
  ]),
  stuckBackgroundWakelockRateMetricSet: rateSet([
    "stuckBgWakelockRate", "stuckBgWakelockRate7dUserWeighted",
    "stuckBgWakelockRate28dUserWeighted", "distinctUsers",
  ]),
  anonRssAndSwapMemoryUsageMetricSet: memorySet("anonRssAndSwapMemoryUsage"),
  bitmapMemoryUsageMetricSet: memorySet("bitmapMemoryUsage"),
  errorCountMetricSet: {
    kind: "count",
    metrics: ["errorReportCount", "distinctUsers"],
    requiredDimensions: ["reportType"],
    dimensions: ERROR_COUNT_DIMENSIONS,
  },
};

const percent = (fraction) => Math.round(fraction * 100 * 1000) / 1000;

const KINDS = {
  rate: {
    format: percent,
    aggregate: "avg",
    unit: { rateUnit: "percent" },
    legend:
      "Rates are percentages of distinct users per day (America/Los_Angeles). latest = most recent " +
      "day in the window; *7dUserWeighted / *28dUserWeighted are Play's rolling averages as of that " +
      "day; windowAvg = daily rate averaged across the window, weighted by distinctUsers. " +
      "distinctUsers is rounded by Google, so groups with few users are noisy.",
    rankedBy: "avgDailyUsers",
    rankDescription: "average daily distinctUsers",
    formatDescription:
      "summary (default): overall figures plus the top groups, rates in percent. raw: every daily " +
      "row from the API as fractions (0–1) — large; use only to debug.",
  },
  memory: {
    format: Math.round,
    aggregate: "avg",
    unit: {
      valueUnit:
        "KiB (not documented by Google; read as KiB, the values match Play Console's MB figures). " +
        "Play Console's anon RSS + swap figure tracks foreground use: compare it with the " +
        'APP_STATE_FOREGROUND group from dimensions ["appState"]. The overall figure here also ' +
        "covers cached and background processes, so it is lower.",
    },
    legend:
      "Values are daily memory-usage percentiles (America/Los_Angeles) as returned by the API. " +
      "latest = most recent day in the window; windowAvg = mean of the daily values over the " +
      "window, weighted by distinctUsers (not itself a percentile). distinctUsers is rounded by " +
      "Google, so groups with few users are noisy.",
    rankedBy: "avgDailyUsers",
    rankDescription: "average daily distinctUsers",
    formatDescription:
      "summary (default): overall figures plus the top groups. raw: every daily row from the API — " +
      "large; use only to debug.",
  },
  count: {
    format: Math.round,
    aggregate: "sum",
    unit: {},
    legend:
      "errorReportCount is the absolute number of error reports per day (America/Los_Angeles). " +
      "latest = most recent day in the window; windowTotal = sum over the window. distinctUsers " +
      "can't be summed across days, so avgDailyUsers is its daily average.",
    rankedBy: "windowTotal.errorReportCount",
    rankDescription: "total error reports in the window",
    formatDescription:
      "summary (default): overall figures plus the top groups. raw: every daily row from the API — " +
      "large; use only to debug.",
  },
};

// Metric-set tools. Every set in one tool shares a kind and its breakdown dimensions.
const TOOLS = {
  get_crash_metrics: {
    description:
      "Fetches Android vitals crash rates from Google Play: user-perceived crash rate (daily, " +
      "7-day and 28-day user-weighted — the rate Play's bad-behavior threshold applies to), " +
      "plain crashRate (includes background crashes), and distinctUsers.",
    metricSets: ["crashRateMetricSet"],
  },
  get_anr_metrics: {
    description:
      "Fetches Android vitals ANR rates from Google Play: user-perceived ANR rate (daily, " +
      "7-day and 28-day user-weighted — the rate Play's bad-behavior threshold applies to), " +
      "plain anrRate (includes background ANRs), and distinctUsers.",
    metricSets: ["anrRateMetricSet"],
  },
  get_slow_rendering_metrics: {
    description:
      "Fetches slow rendering (jank) rates at the 20 fps and 30 fps thresholds. Google Play " +
      "only exposes this metric set for games; other apps get an explanatory error.",
    metricSets: ["slowRenderingRateMetricSet"],
  },
  get_startup_time_metrics: {
    description:
      "Fetches slow app start rates per startType (COLD / WARM / HOT): daily, 7-day and " +
      "28-day user-weighted slowStartRate, and distinctUsers.",
    metricSets: ["slowStartRateMetricSet"],
  },
  get_lmk_metrics: {
    description:
      "Fetches the user-perceived low memory kill (LMK) rate — users whose app process was killed " +
      "for memory while in active use (showing an activity or running a foreground service): " +
      "daily, 7-day and 28-day user-weighted, and distinctUsers.",
    metricSets: ["lmkRateMetricSet"],
  },
  get_memory_metrics: {
    description:
      "Fetches memory usage percentiles (P50, P75, P90, P95, P99) for anonymous RSS + swap and " +
      "for bitmaps, one section per metric set. Supports the extra breakdowns processName and " +
      "appState.",
    metricSets: ["anonRssAndSwapMemoryUsageMetricSet", "bitmapMemoryUsageMetricSet"],
    dimensionsHint:
      ' Memory also supports "processName" and "appState"; use ["appState"] to compare with ' +
      "Play Console, whose memory figures track foreground use.",
  },
  get_battery_metrics: {
    description:
      "Fetches battery vitals, one section per metric set: excessive wakeup rate (users with more " +
      "than 10 AlarmManager wakeups per hour) and stuck background wake lock rate (users with a " +
      "wake lock held in the background for over 1 hour); daily, 7-day and 28-day user-weighted.",
    metricSets: ["excessiveWakeupRateMetricSet", "stuckBackgroundWakelockRateMetricSet"],
  },
  get_error_counts: {
    description:
      "Fetches absolute error report counts and affected users per reportType (CRASH / ANR), " +
      'summed over the window. Add "issueId" to dimensions to count per error issue (ids come ' +
      "from search_error_issues).",
    metricSets: ["errorCountMetricSet"],
    dimensionsHint: ' Use ["issueId"] to count per error issue.',
  },
};

for (const tool of Object.values(TOOLS)) {
  tool.sets = tool.metricSets.map((name) => ({ name, ...METRIC_SETS[name] }));
  tool.kind = tool.sets[0].kind;
  tool.requiredDimensions = [...new Set(tool.sets.flatMap((set) => set.requiredDimensions))];
  tool.dimensions = tool.sets[0].dimensions.filter((d) => tool.sets.every((set) => set.dimensions.includes(d)));
}

class InputError extends Error {}

// Initialize MCP Server
const server = new Server(
  { name: "android-vitals-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// Helper for UTC hour-aligned time ranges
function getTimeRange(days) {
  const endDate = new Date();
  // Adjust for Google Play Developer API data freshness (typically 1-2 days delayed)
  endDate.setUTCDate(endDate.getUTCDate() - 2);
  endDate.setUTCHours(0, 0, 0, 0);
  const startDate = new Date(endDate);
  startDate.setUTCDate(startDate.getUTCDate() - days);

  return {
    startTime: {
      year: startDate.getUTCFullYear(),
      month: startDate.getUTCMonth() + 1,
      day: startDate.getUTCDate(),
      hours: 0
    },
    endTime: {
      year: endDate.getUTCFullYear(),
      month: endDate.getUTCMonth() + 1,
      day: endDate.getUTCDate(),
      hours: 0
    }
  };
}

function formatDate({ year, month, day }) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// endTime is exclusive, so the last day covered is the day before it.
function lastDayBefore({ year, month, day }) {
  const date = new Date(Date.UTC(year, month - 1, day - 1));
  return formatDate({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() });
}

// MCP hosts sometimes send arrays as a single (comma-separated) string.
function toList(value) {
  if (value === undefined || value === null || value === "") return [];
  const list = Array.isArray(value) ? value : String(value).split(",");
  return list.map((v) => String(v).trim()).filter(Boolean);
}

function positiveInt(value, fallback, name) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InputError(`"${name}" must be a positive integer, got ${JSON.stringify(value)}.`);
  }
  return parsed;
}

// Values end up inside an AIP-160 filter string, so only plain integers are accepted.
function numericList(value, name) {
  const list = toList(value);
  const invalid = list.filter((v) => !/^\d+$/.test(v));
  if (invalid.length > 0) {
    throw new InputError(`"${name}" accepts only integers, got ${JSON.stringify(invalid)}.`);
  }
  return list;
}

const isBlank = (value) => value === undefined || value === null || value === "";

// Parses an enum argument that only applies to tools with the matching required dimension.
function requiredDimensionValue(tool, args, name, allowed, owner) {
  if (isBlank(args[name])) return null;
  if (!tool.requiredDimensions.includes(name)) {
    throw new InputError(`"${name}" only applies to ${owner}.`);
  }
  const value = String(args[name]).toUpperCase();
  if (!allowed.includes(value)) {
    throw new InputError(`"${name}" must be one of ${allowed.join(", ")}, got ${JSON.stringify(args[name])}.`);
  }
  return value;
}

function parseArgs(tool, args = {}) {
  const days = positiveInt(args.days, 7, "days");
  const limit = positiveInt(args.limit, DEFAULT_LIMIT, "limit");

  // Some hosts send null for omitted optional args; only an explicit [] means "overall only".
  const dimensions = (args.dimensions == null ? DEFAULT_DIMENSIONS : toList(args.dimensions))
    .filter((d) => !tool.requiredDimensions.includes(d));
  const unknown = dimensions.filter((d) => !tool.dimensions.includes(d));
  if (unknown.length > 0) {
    throw new InputError(`Unknown dimension(s) ${JSON.stringify(unknown)}. Valid: ${tool.dimensions.join(", ")}.`);
  }

  const versionCodes = numericList(args.versionCodes, "versionCodes");
  const apiLevels = numericList(args.apiLevels, "apiLevels");
  const startType = requiredDimensionValue(tool, args, "startType", START_TYPES, "get_startup_time_metrics");
  const reportType = requiredDimensionValue(tool, args, "reportType", REPORT_TYPES, "get_error_counts");

  const format = args.format ?? "summary";
  if (!["summary", "raw"].includes(format)) {
    throw new InputError(`"format" must be "summary" or "raw", got ${JSON.stringify(args.format)}.`);
  }

  return { days, limit, dimensions: [...new Set(dimensions)], versionCodes, apiLevels, startType, reportType, format };
}

const anyOf = (field, values) =>
  values.length === 1
    ? `${field} = ${values[0]}`
    : `(${values.map((v) => `${field} = ${v}`).join(" OR ")})`;

function buildFilter({ versionCodes, apiLevels, startType, reportType }) {
  const clauses = [];
  if (versionCodes.length > 0) clauses.push(anyOf("versionCode", versionCodes));
  if (apiLevels.length > 0) clauses.push(anyOf("apiLevel", apiLevels));
  if (startType) clauses.push(`startType = ${startType}`);
  if (reportType) clauses.push(`reportType = ${reportType}`);
  return clauses.length > 0 ? clauses.join(" AND ") : undefined;
}

// Follows nextPageToken; the API returns at most 1000 rows per page by default.
async function queryAllPages(metricSet, requestBody) {
  const rows = [];
  let pageToken;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await apiRequest(`apps/${PACKAGE_NAME}/${metricSet}:query`, {
      method: "POST",
      data: { ...requestBody, pageSize: PAGE_SIZE, pageToken },
    });
    rows.push(...(data.rows ?? []));
    pageToken = data.nextPageToken;
    if (!pageToken) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

function toNumber(value) {
  if (value === undefined || value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const isDailyMetric = (metric) => metric !== "distinctUsers" && !metric.endsWith("UserWeighted");

function summarizeGroup({ dimensions, days }, set) {
  const { format, aggregate } = KINDS[set.kind];
  days.sort((a, b) => a.date.localeCompare(b.date));
  const last = days[days.length - 1];

  const latest = {};
  for (const metric of set.metrics) {
    const value = last.metrics[metric];
    if (metric !== "distinctUsers" && value !== null && value !== undefined) latest[metric] = format(value);
  }

  // Averages need more than one day to say anything; totals are always shown (they rank groups).
  const windowValues = {};
  if (aggregate === "sum" || days.length > 1) {
    for (const metric of set.metrics.filter(isDailyMetric)) {
      let total = 0;
      let weighted = 0;
      let users = 0;
      for (const { metrics } of days) {
        if (metrics[metric] === null || metrics[metric] === undefined) continue;
        total += metrics[metric];
        if (!metrics.distinctUsers) continue;
        weighted += metrics[metric] * metrics.distinctUsers;
        users += metrics.distinctUsers;
      }
      if (aggregate === "sum") windowValues[metric] = format(total);
      else if (users > 0) windowValues[metric] = format(weighted / users);
    }
  }

  const userCounts = days.map((d) => d.metrics.distinctUsers).filter((n) => n !== null && n !== undefined);
  return {
    ...(Object.keys(dimensions).length > 0 ? { dimensions } : {}),
    latestDate: last.date,
    daysWithData: days.length,
    avgDailyUsers: userCounts.length > 0
      ? Math.round(userCounts.reduce((sum, n) => sum + n, 0) / userCounts.length)
      : null,
    latest,
    ...(Object.keys(windowValues).length > 0
      ? { [aggregate === "sum" ? "windowTotal" : "windowAvg"]: windowValues }
      : {}),
  };
}

// Groups daily rows by their dimension values, then ranks groups (see KINDS.rankedBy).
function summarize(rows, set) {
  const groups = new Map();
  for (const row of rows) {
    const dimensions = Object.fromEntries(
      (row.dimensions ?? []).map((d) => [d.dimension, d.stringValue ?? d.int64Value ?? null])
    );
    const metrics = Object.fromEntries(
      (row.metrics ?? []).map((m) => [m.metric, toNumber(m.decimalValue?.value ?? m.int64Value)])
    );
    const key = JSON.stringify(dimensions);
    if (!groups.has(key)) groups.set(key, { dimensions, days: [] });
    groups.get(key).days.push({ date: formatDate(row.startTime), metrics });
  }
  const rank = set.kind === "count"
    ? (g) => g.windowTotal?.errorReportCount ?? 0
    : (g) => g.avgDailyUsers ?? 0;
  return [...groups.values()]
    .map((group) => summarizeGroup(group, set))
    .sort((a, b) => rank(b) - rank(a));
}

// Orders `overall` entries by the set's required dimension (COLD, WARM, HOT / CRASH, ANR).
function byRequiredDimension(set) {
  const [dimension] = set.requiredDimensions;
  const order = REQUIRED_DIMENSION_ORDER[dimension];
  if (!order) return () => 0;
  const position = (entry) => {
    const i = order.indexOf(entry.dimensions?.[dimension]);
    return i === -1 ? order.length : i;
  };
  return (a, b) => position(a) - position(b);
}

async function summarizeMetricSet(set, timelineSpec, filter, options) {
  const request = (dimensions) => ({
    timelineSpec,
    metrics: set.metrics,
    dimensions: [...set.requiredDimensions, ...dimensions],
    ...(filter ? { filter } : {}),
  });

  // The headline comes from its own query: summing per-group rows would double-count users.
  const [overall, breakdown] = await Promise.all([
    queryAllPages(set.name, request([])),
    options.dimensions.length > 0 ? queryAllPages(set.name, request(options.dimensions)) : null,
  ]);

  const section = { overall: summarize(overall.rows, set).sort(byRequiredDimension(set)) };
  if (breakdown) {
    const groups = summarize(breakdown.rows, set);
    section.breakdown = {
      dimensions: [...set.requiredDimensions, ...options.dimensions],
      groupsTotal: groups.length,
      groupsShown: Math.min(groups.length, options.limit),
      rankedBy: KINDS[set.kind].rankedBy,
      groups: groups.slice(0, options.limit),
    };
  }
  if (overall.truncated || breakdown?.truncated) section.truncated = true;
  if (section.overall.length === 0) section.note = "No data returned for this window and filter.";
  return section;
}

async function runMetricSetTool(tool, options) {
  const timeRange = getTimeRange(options.days);
  const timelineSpec = {
    aggregationPeriod: "DAILY",
    startTime: timeRange.startTime,
    endTime: timeRange.endTime,
  };
  const filter = buildFilter(options);

  if (options.format === "raw") {
    const results = await Promise.all(tool.sets.map((set) => queryAllPages(set.name, {
      timelineSpec,
      metrics: set.metrics,
      dimensions: [...set.requiredDimensions, ...options.dimensions],
      ...(filter ? { filter } : {}),
    })));
    const raw = ({ rows, truncated }) => ({ rows, ...(truncated ? { truncated: true } : {}) });
    if (tool.sets.length === 1) return raw(results[0]);
    return { sections: Object.fromEntries(tool.sets.map((set, i) => [set.name, raw(results[i])])) };
  }

  const sections = await Promise.all(
    tool.sets.map((set) => summarizeMetricSet(set, timelineSpec, filter, options))
  );
  const kind = KINDS[tool.kind];
  const header = {
    app: PACKAGE_NAME,
    ...(tool.sets.length === 1 ? { metricSet: tool.sets[0].name } : {}),
    window: {
      from: formatDate(timeRange.startTime),
      to: lastDayBefore(timeRange.endTime),
      timeZone: "America/Los_Angeles",
    },
    filter: filter ?? null,
    ...kind.unit,
    legend: kind.legend,
  };
  if (tool.sets.length === 1) return { ...header, ...sections[0] };
  return { ...header, sections: Object.fromEntries(tool.sets.map((set, i) => [set.name, sections[i]])) };
}

function inputSchemaFor(tool) {
  const kind = KINDS[tool.kind];
  const properties = {
    days: {
      type: "integer",
      minimum: 1,
      default: 7,
      description: "Number of days to fetch, ending 2 days ago (Play data lags). Default 7.",
    },
    dimensions: {
      type: "array",
      items: { type: "string", enum: tool.dimensions },
      default: DEFAULT_DIMENSIONS,
      description:
        'Breakdown for the per-group section. Default ["versionCode"]. Use ["versionCode", "apiLevel"] ' +
        "to find OS-specific regressions, or [] for the overall figures only." + (tool.dimensionsHint ?? ""),
    },
    versionCodes: {
      type: "array",
      items: { type: "string", pattern: "^\\d+$" },
      description: "Only include these versionCodes (e.g. the latest two builds).",
    },
    apiLevels: {
      type: "array",
      items: { type: "string", pattern: "^\\d+$" },
      description: 'Only include these Android API levels, e.g. ["34", "35"].',
    },
    format: {
      type: "string",
      enum: ["summary", "raw"],
      default: "summary",
      description: kind.formatDescription,
    },
    limit: {
      type: "integer",
      minimum: 1,
      default: DEFAULT_LIMIT,
      description: `summary only: maximum groups returned, ranked by ${kind.rankDescription}.`,
    },
  };
  if (tool.requiredDimensions.includes("startType")) {
    properties.startType = {
      type: "string",
      enum: START_TYPES,
      description: "Only include this start type. Omit to get COLD, WARM and HOT.",
    };
  }
  if (tool.requiredDimensions.includes("reportType")) {
    properties.reportType = {
      type: "string",
      enum: REPORT_TYPES,
      description: "Only include this report type. Omit to get CRASH and ANR.",
    };
  }
  return { type: "object", properties };
}

function errorResult(text) {
  return { isError: true, content: [{ type: "text", text }] };
}

// Define Tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: Object.entries(TOOLS).map(([name, tool]) => ({
    name,
    description: tool.description,
    inputSchema: inputSchemaFor(tool),
  })),
}));

// Handle Tool Execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (missing.length > 0) {
    return errorResult(`android-vitals-mcp is not configured. Missing: ${missing.join(", ")}\n\n${CONFIG_HINT}`);
  }

  const tool = TOOLS[name];
  if (!tool) return errorResult(`Unknown tool: ${name}`);

  try {
    const options = parseArgs(tool, args ?? {});
    const result = await runMetricSetTool(tool, options);
    // Raw output is already large; skip indentation there.
    const text = JSON.stringify(result, null, options.format === "raw" ? 0 : 1);
    return { content: [{ type: "text", text }] };
  } catch (error) {
    if (error instanceof InputError) return errorResult(`Invalid arguments: ${error.message}`);
    if (/only accessible to games/i.test(error.message)) {
      return errorResult(
        `Google Play returned: "${error.message}". The Reporting API exposes ${tool.metricSets.join(", ")} only ` +
        `for apps categorized as games, so it is not available for ${PACKAGE_NAME}. Check Play Console → ` +
        "Android vitals for this app's rendering data, or measure jank locally (Macrobenchmark " +
        "FrameTimingMetric, JankStats)."
      );
    }
    return errorResult(`API Error: ${error.message}`);
  }
});

// Start Server
async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  if (missing.length > 0) {
    console.error(`android-vitals-mcp: server started but missing env var(s): ${missing.join(", ")} — tools will return setup instructions until configured.`);
  } else {
    console.error("Android Vitals MCP server running on stdio");
  }
}

run().catch(console.error);
