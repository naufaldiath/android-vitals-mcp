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

const ERROR_ISSUE_TYPES = ["CRASH", "ANR", "NON_FATAL"];
const ERROR_ORDER_FIELDS = ["distinctUsers", "errorReportCount"];

// Error search only accepts UTC intervals. Error data is fresher than the daily metric sets,
// so the window covers complete UTC days up to the start of today.
function errorInterval(days) {
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days);
  const lastDay = new Date(end);
  lastDay.setUTCDate(lastDay.getUTCDate() - 1);

  const params = {};
  for (const [key, date] of [["startTime", start], ["endTime", end]]) {
    params[`interval.${key}.year`] = date.getUTCFullYear();
    params[`interval.${key}.month`] = date.getUTCMonth() + 1;
    params[`interval.${key}.day`] = date.getUTCDate();
    params[`interval.${key}.hours`] = 0;
    params[`interval.${key}.timeZone.id`] = "UTC";
  }
  const isoDate = (date) => date.toISOString().slice(0, 10);
  return { params, window: { from: isoDate(start), to: isoDate(lastDay), timeZone: "UTC" } };
}

function enumValue(value, allowed, name) {
  if (isBlank(value)) return null;
  const upper = String(value).toUpperCase();
  if (!allowed.includes(upper)) {
    throw new InputError(`"${name}" must be one of ${allowed.join(", ")}, got ${JSON.stringify(value)}.`);
  }
  return upper;
}

function booleanArg(value, name) {
  if (isBlank(value)) return false;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new InputError(`"${name}" must be true or false, got ${JSON.stringify(value)}.`);
}

function cappedInt(value, fallback, max, name) {
  return Math.min(positiveInt(value, fallback, name), max);
}

// Filters shared by search_error_issues and get_error_reports.
function parseErrorFilters(args) {
  const issueId = isBlank(args.issueId) ? null : String(args.issueId).trim();
  // Issue ids are interpolated into the filter, so only letters and digits are accepted.
  if (issueId !== null && !/^[A-Za-z0-9]{1,64}$/.test(issueId)) {
    throw new InputError(`"issueId" accepts only letters and digits, got ${JSON.stringify(args.issueId)}.`);
  }
  return {
    days: positiveInt(args.days, 7, "days"),
    type: enumValue(args.type, ERROR_ISSUE_TYPES, "type"),
    userPerceivedOnly: booleanArg(args.userPerceivedOnly, "userPerceivedOnly"),
    versionCodes: numericList(args.versionCodes, "versionCodes"),
    apiLevels: numericList(args.apiLevels, "apiLevels"),
    issueId,
  };
}

function buildErrorFilter({ type, userPerceivedOnly, versionCodes, apiLevels, issueId }) {
  const clauses = [];
  if (issueId) clauses.push(`errorIssueId = "${issueId}"`);
  if (type) clauses.push(`errorIssueType = ${type}`);
  if (userPerceivedOnly) clauses.push("isUserPerceived");
  if (versionCodes.length > 0) clauses.push(anyOf("versionCode", versionCodes));
  if (apiLevels.length > 0) clauses.push(anyOf("apiLevel", apiLevels));
  return clauses.length > 0 ? clauses.join(" AND ") : undefined;
}

const lastSegment = (name) => (name ? name.split("/").pop() : null);
const truncate = (text, max) => (text && text.length > max ? `${text.slice(0, max)}…` : text);

async function searchErrorIssues(args) {
  const filters = parseErrorFilters(args);
  if (filters.issueId) throw new InputError('"issueId" only applies to get_error_reports.');
  const orderField = isBlank(args.orderBy) ? "distinctUsers" : String(args.orderBy);
  if (!ERROR_ORDER_FIELDS.includes(orderField)) {
    throw new InputError(`"orderBy" must be one of ${ERROR_ORDER_FIELDS.join(", ")}, got ${JSON.stringify(args.orderBy)}.`);
  }
  // About 1 KB per issue: the API allows 1000, which would flood the agent's context.
  const limit = cappedInt(args.limit, 10, 100, "limit");
  const includeSampleReport = booleanArg(args.includeSampleReport, "includeSampleReport");

  const { params, window } = errorInterval(filters.days);
  const filter = buildErrorFilter(filters);
  const data = await apiRequest(`apps/${PACKAGE_NAME}/errorIssues:search`, {
    params: {
      ...params,
      pageSize: limit,
      orderBy: `${orderField} desc`,
      ...(filter ? { filter } : {}),
      ...(includeSampleReport ? { sampleErrorReportLimit: 1 } : {}),
    },
  });

  const issues = (data.errorIssues ?? []).map((issue) => ({
    issueId: lastSegment(issue.name),
    type: issue.type,
    cause: issue.cause,
    location: issue.location,
    distinctUsers: toNumber(issue.distinctUsers),
    distinctUsersPercent: issue.distinctUsersPercent?.value != null
      ? Math.round(Number(issue.distinctUsersPercent.value) * 100) / 100
      : null,
    errorReportCount: toNumber(issue.errorReportCount),
    appVersions: { first: issue.firstAppVersion?.versionCode ?? null, last: issue.lastAppVersion?.versionCode ?? null },
    apiLevels: { first: issue.firstOsVersion?.apiLevel ?? null, last: issue.lastOsVersion?.apiLevel ?? null },
    lastErrorReportTime: issue.lastErrorReportTime ?? null,
    ...(issue.annotations?.length
      ? { annotations: issue.annotations.map((a) => ({ category: a.category, title: a.title, body: truncate(a.body, 300) })) }
      : {}),
    ...(issue.sampleErrorReports?.length ? { sampleReportId: lastSegment(issue.sampleErrorReports[0]) } : {}),
    consoleUrl: issue.issueUri ?? null,
  }));

  return {
    app: PACKAGE_NAME,
    window,
    filter: filter ?? null,
    orderBy: `${orderField} desc`,
    note:
      "distinctUsersPercent is the share of users affected by any error issue who hit this one. " +
      "Pass issueId to get_error_reports for stack traces, or to get_error_counts " +
      '(dimensions: ["issueId"]) for a daily trend. Google documents cause as the exception / ANR ' +
      "type and location as the method / activity, but the API can return them the other way " +
      "round — read both.",
    issuesShown: issues.length,
    moreAvailable: Boolean(data.nextPageToken),
    issues,
  };
}

async function getErrorReports(args) {
  const filters = parseErrorFilters(args);
  const limit = cappedInt(args.limit, 3, 100, "limit");
  const maxChars = positiveInt(args.maxChars, 4000, "maxChars");

  const { params, window } = errorInterval(filters.days);
  const filter = buildErrorFilter(filters);
  const data = await apiRequest(`apps/${PACKAGE_NAME}/errorReports:search`, {
    params: { ...params, pageSize: limit, ...(filter ? { filter } : {}) },
  });

  const reports = (data.errorReports ?? []).map((report) => {
    const text = report.reportText ?? "";
    return {
      reportId: lastSegment(report.name),
      issueId: lastSegment(report.issue),
      type: report.type,
      eventTime: report.eventTime ?? null,
      appVersionCode: report.appVersion?.versionCode ?? null,
      apiLevel: report.osVersion?.apiLevel ?? null,
      device: {
        brand: report.deviceModel?.deviceId?.buildBrand ?? null,
        device: report.deviceModel?.deviceId?.buildDevice ?? null,
        marketingName: report.deviceModel?.marketingName ?? null,
      },
      ...(report.vcsInformation ? { vcsInformation: truncate(report.vcsInformation.trim(), 1000) } : {}),
      reportTextTotalChars: text.length,
      reportTextTruncated: text.length > maxChars,
      reportText: text.slice(0, maxChars),
    };
  });

  return {
    app: PACKAGE_NAME,
    window,
    filter: filter ?? null,
    note:
      "Report text is produced by Android and sanitized by Google before it is served. Each report " +
      "is cut to maxChars; raise maxChars to read further.",
    reportsShown: reports.length,
    moreAvailable: Boolean(data.nextPageToken),
    reports,
  };
}

function formatDateTime(time) {
  if (!time) return null;
  const date = formatDate(time);
  const clock = time.hours !== undefined ? `T${String(time.hours).padStart(2, "0")}:00` : "";
  return `${date}${clock} ${time.timeZone?.id ?? ""}`.trim();
}

async function listAnomalies(args) {
  const days = positiveInt(args.days, 90, "days");
  const limit = cappedInt(args.limit, 10, 100, "limit");
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - days);

  const data = await apiRequest(`apps/${PACKAGE_NAME}/anomalies`, {
    params: { pageSize: limit, filter: `activeBetween("${since.toISOString()}", UNBOUNDED)` },
  });

  const anomalies = (data.anomalies ?? []).map((anomaly) => ({
    metricSet: lastSegment(anomaly.metricSet),
    metric: anomaly.metric?.metric ?? null,
    value: toNumber(anomaly.metric?.decimalValue?.value),
    ...(anomaly.metric?.decimalValueConfidenceInterval
      ? {
          confidenceInterval: {
            lower: toNumber(anomaly.metric.decimalValueConfidenceInterval.lowerBound?.value),
            upper: toNumber(anomaly.metric.decimalValueConfidenceInterval.upperBound?.value),
          },
        }
      : {}),
    dimensions: Object.fromEntries(
      (anomaly.dimensions ?? []).map((d) => [d.dimension, d.stringValue ?? d.int64Value ?? null])
    ),
    aggregationPeriod: anomaly.timelineSpec?.aggregationPeriod ?? null,
    start: formatDateTime(anomaly.timelineSpec?.startTime),
    end: formatDateTime(anomaly.timelineSpec?.endTime),
  }));

  return {
    app: PACKAGE_NAME,
    activeSince: since.toISOString().slice(0, 10),
    note:
      "Anomalies Google Play detected in this app's vitals. Values are returned as-is: unlike the " +
      "metric-set tools, rate anomalies already appear to be percentages (3.0 = 3 %).",
    anomaliesShown: anomalies.length,
    moreAvailable: Boolean(data.nextPageToken),
    anomalies,
  };
}

async function getDataFreshness() {
  const names = Object.keys(METRIC_SETS);
  const results = await Promise.all(names.map(async (name) => {
    try {
      const data = await apiRequest(`apps/${PACKAGE_NAME}/${name}`);
      return Object.fromEntries(
        (data.freshnessInfo?.freshnesses ?? []).map((f) => [f.aggregationPeriod, formatDateTime(f.latestEndTime)])
      );
    } catch (error) {
      return `unavailable: ${error.message}`;
    }
  }));
  return {
    app: PACKAGE_NAME,
    note:
      "latestEndTime per aggregation period; it is exclusive, so DAILY 2026-10-10 means data " +
      "through 2026-10-09. The metric-set tools end their window 2 days before today.",
    metricSets: Object.fromEntries(names.map((name, i) => [name, results[i]])),
  };
}

async function listReleases() {
  const data = await apiRequest(`apps/${PACKAGE_NAME}:fetchReleaseFilterOptions`);
  const tracks = data.tracks ?? [];
  return {
    app: PACKAGE_NAME,
    note: "Releases currently serving on each track, with the versionCodes that belong to them.",
    tracks: tracks
      .filter((track) => track.servingReleases?.length)
      .map((track) => ({
        track: track.displayName,
        type: track.type,
        releases: track.servingReleases.map((release) => ({ name: release.displayName, versionCodes: release.versionCodes ?? [] })),
      })),
    tracksWithoutServingReleases: tracks.filter((track) => !track.servingReleases?.length).map((track) => track.displayName),
  };
}

const ERROR_FILTER_PROPERTIES = {
  days: {
    type: "integer",
    minimum: 1,
    default: 7,
    description: "Number of complete UTC days to search, ending at the start of today. Default 7.",
  },
  type: { type: "string", enum: ERROR_ISSUE_TYPES, description: "Only this error type." },
  userPerceivedOnly: {
    type: "boolean",
    default: false,
    description: "Only errors users perceived (the ones Play's bad-behavior thresholds count).",
  },
  versionCodes: {
    type: "array",
    items: { type: "string", pattern: "^\\d+$" },
    description: "Only these versionCodes.",
  },
  apiLevels: {
    type: "array",
    items: { type: "string", pattern: "^\\d+$" },
    description: "Only these Android API levels.",
  },
};

// Tools for the Reporting API endpoints that aren't metric sets.
const ENDPOINT_TOOLS = {
  search_error_issues: {
    description:
      "Lists error issues (crash / ANR clusters Google Play groups by likely root cause), ranked by " +
      "affected users or report count: type, cause, location, affected users and their share, " +
      "report count, first and last app version and API level, and a Play Console link.",
    inputSchema: {
      type: "object",
      properties: {
        ...ERROR_FILTER_PROPERTIES,
        orderBy: { type: "string", enum: ERROR_ORDER_FIELDS, default: "distinctUsers", description: "Rank by affected users or by report count (descending)." },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 10, description: "Maximum issues returned (about 1 KB each; capped at 100)." },
        includeSampleReport: { type: "boolean", default: false, description: "Add one sample reportId per issue." },
      },
    },
    run: searchErrorIssues,
  },
  get_error_reports: {
    description:
      "Fetches individual error reports with the Android-generated stack trace / ANR dump, device, " +
      "API level, app version and version-control info. Pass issueId from search_error_issues to " +
      "get reports for one issue. Report text is cut to maxChars (a single ANR dump can exceed 100K characters).",
    inputSchema: {
      type: "object",
      properties: {
        issueId: { type: "string", pattern: "^[A-Za-z0-9]{1,64}$", description: "Only reports for this error issue (from search_error_issues)." },
        ...ERROR_FILTER_PROPERTIES,
        limit: { type: "integer", minimum: 1, maximum: 100, default: 3, description: "Maximum reports returned." },
        maxChars: { type: "integer", minimum: 1, default: 4000, description: "Characters of report text kept per report." },
      },
    },
    run: getErrorReports,
  },
  list_anomalies: {
    description:
      "Lists anomalies Google Play detected in the app's vitals (metric set, metric, anomalous " +
      "value, dimensions, and period) that were active within the last `days` days.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "integer", minimum: 1, default: 90, description: "Only anomalies active within this many days. Default 90." },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 10, description: "Maximum anomalies returned." },
      },
    },
    run: listAnomalies,
  },
  get_data_freshness: {
    description:
      "Shows the latest date (and hour, where available) each vitals metric set has data for, per " +
      "aggregation period. Metric sets the app can't access are reported as unavailable.",
    inputSchema: { type: "object", properties: {} },
    run: getDataFreshness,
  },
  list_releases: {
    description:
      "Lists the releases currently serving on each Play track with their versionCodes — use it " +
      "to map versionCodes in other tools' output to release names.",
    inputSchema: { type: "object", properties: {} },
    run: listReleases,
  },
};

function errorResult(text) {
  return { isError: true, content: [{ type: "text", text }] };
}

// Define Tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    ...Object.entries(TOOLS).map(([name, tool]) => ({
      name,
      description: tool.description,
      inputSchema: inputSchemaFor(tool),
    })),
    ...Object.entries(ENDPOINT_TOOLS).map(([name, tool]) => ({
      name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  ],
}));

// Handle Tool Execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (missing.length > 0) {
    return errorResult(`android-vitals-mcp is not configured. Missing: ${missing.join(", ")}\n\n${CONFIG_HINT}`);
  }

  const tool = TOOLS[name];
  const endpointTool = ENDPOINT_TOOLS[name];
  if (!tool && !endpointTool) return errorResult(`Unknown tool: ${name}`);

  try {
    if (endpointTool) {
      const result = await endpointTool.run(args ?? {});
      return { content: [{ type: "text", text: JSON.stringify(result, null, 1) }] };
    }
    const options = parseArgs(tool, args ?? {});
    const result = await runMetricSetTool(tool, options);
    // Raw output is already large; skip indentation there.
    const text = JSON.stringify(result, null, options.format === "raw" ? 0 : 1);
    return { content: [{ type: "text", text }] };
  } catch (error) {
    if (error instanceof InputError) return errorResult(`Invalid arguments: ${error.message}`);
    if (tool && /only accessible to games/i.test(error.message)) {
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
