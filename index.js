#!/usr/bin/env node
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

if (!SERVICE_ACCOUNT_FILE || !PACKAGE_NAME) {
  console.error("Missing required environment variables: GOOGLE_APPLICATION_CREDENTIALS or ANDROID_PACKAGE_NAME");
  process.exit(1);
}

// Authenticate and Initialize API Client
const auth = new google.auth.GoogleAuth({
  keyFile: SERVICE_ACCOUNT_FILE,
  scopes: ["https://www.googleapis.com/auth/playdeveloperreporting"],
});

const reporting = google.playdeveloperreporting({
  version: "v1beta1",
  auth: auth,
});

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
  console.error("Android Vitals MCP server running on stdio");
}

run().catch(console.error);