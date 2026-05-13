# LinkedIn Post — android-vitals-mcp

## Caption

So I've been digging into the Android Vitals numbers for my app lately, and the process was kind of painful.

Every time something looked off — slow startup, high ANR rate, janky rendering — I'd open Play Console, filter by version, switch to a different tab, try to figure out which build caused it, which API level was affected... and by the time I had a clear picture, I'd already lost 30 minutes just gathering context.

The data was always there. I just had to hunt for it manually every single time.

So I built something to fix that.

android-vitals-mcp connects your AI coding assistant directly to the Google Play Developer Reporting API. Instead of clicking through dashboards, you just ask:

"why is the cold start getting slower?"
"which version caused the ANR spike?"
"the app feels janky on Android 14, what happened?"

And your agent actually goes and checks — pulls the real numbers broken down by version code and API level, compares them against Google's thresholds, and walks you through what to fix.

Setup takes two commands:

```
npx android-vitals-mcp setup
npx android-vitals-install-skills
```

The first one is a wizard that connects your Google Service Account and writes the MCP config into every AI CLI it detects (Claude Code, Gemini, Cursor, Kiro). The second installs four skill playbooks that auto-trigger on keywords like "ANR", "jank", or "cold start" — so you don't even have to think about it. It just kicks in when it's relevant.

Then restart your AI CLI and ask: "improve my Android crash rate".

Works with Claude Code, Gemini CLI, Cursor, Copilot, Cline, Kiro, and more.

📦 https://www.npmjs.com/package/android-vitals-mcp

#Android #AndroidDev #MCP #ModelContextProtocol #AI #AgentAI #ClaudeCode #GooglePlay #AndroidVitals #MobilePerformance #MobileEngineering #OpenSource
