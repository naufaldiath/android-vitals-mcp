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

// Lazy-initialized API client — only created when env vars are present
let reporting = null;
if (SERVICE_ACCOUNT_FILE && PACKAGE_NAME) {
  const auth = new google.auth.GoogleAuth({
    keyFile: SERVICE_ACCOUNT_FILE,
    scopes: ["https://www.googleapis.com/auth/playdeveloperreporting"],
  });
  reporting = google.playdeveloperreporting({ version: "v1beta1", auth });
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

// Define Tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_crash_metrics",
      description: "Fetches crash rate metrics for the Android app.",
      inputSchema: {
        type: "object",
        properties: { days: { type: "number", description: "Days of data to fetch (default 7)", default: 7 } }
      }
    },
    {
      name: "get_anr_metrics",
      description: "Fetches ANR (Application Not Responding) rate metrics.",
      inputSchema: {
        type: "object",
        properties: { days: { type: "number", description: "Days of data to fetch (default 7)", default: 7 } }
      }
    },
    {
      name: "get_slow_rendering_metrics",
      description: "Fetches slow rendering (Jank) rate metrics.",
      inputSchema: {
        type: "object",
        properties: { days: { type: "number", description: "Days of data to fetch (default 7)", default: 7 } }
      }
    },
    {
      name: "get_startup_time_metrics",
      description: "Fetches slow app startup time metrics.",
      inputSchema: {
        type: "object",
        properties: { days: { type: "number", description: "Days of data to fetch (default 7)", default: 7 } }
      }
    }
  ]
}));

// Handle Tool Execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (missing.length > 0) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: `android-vitals-mcp is not configured. Missing: ${missing.join(", ")}\n\n${CONFIG_HINT}`
      }]
    };
  }

  const days = args?.days || 7;
  const timeRange = getTimeRange(days);

  const timelineSpec = {
    aggregationPeriod: "DAILY",
    startTime: timeRange.startTime,
    endTime: timeRange.endTime,
  };

  try {
    let result;
    const baseRequest = { timelineSpec, dimensions: ["apiLevel", "versionCode"] };

    switch (name) {
      case "get_crash_metrics":
        result = await reporting.vitals.crashrate.query({
          name: `apps/${PACKAGE_NAME}/crashRateMetricSet`,
          requestBody: { ...baseRequest, metrics: ["crashRate", "errorReportCount", "distinctUsers"] }
        });
        break;
      case "get_anr_metrics":
        result = await reporting.vitals.anrrate.query({
          name: `apps/${PACKAGE_NAME}/anrRateMetricSet`,
          requestBody: { ...baseRequest, metrics: ["anrRate", "anrRate7dUserWeighted", "distinctUsers"] }
        });
        break;
      case "get_slow_rendering_metrics":
        result = await reporting.vitals.slowrenderingrate.query({
          name: `apps/${PACKAGE_NAME}/slowRenderingRateMetricSet`,
          requestBody: { ...baseRequest, metrics: ["slowRenderingRate20Fps", "slowRenderingRate30Fps"] }
        });
        break;
      case "get_startup_time_metrics":
        result = await reporting.vitals.slowstartrate.query({
          name: `apps/${PACKAGE_NAME}/slowStartRateMetricSet`,
          requestBody: {
            timelineSpec,
            dimensions: ["apiLevel", "versionCode", "startType"],
            metrics: ["slowStartRate"]
          }
        });
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: `API Error: ${error.message}` }],
    };
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
