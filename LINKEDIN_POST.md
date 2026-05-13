# LinkedIn Post — android-vitals-mcp
# 3-poster carousel series

---

## Caption (text above the carousel)

I got tired of spending 30 minutes in Play Console just to understand *why* my app was crashing.

So I built an MCP server that connects your AI agent directly to Android Vitals — and now I just ask.

Swipe to see how it works 👇

📦 https://www.npmjs.com/package/android-vitals-mcp

#Android #AndroidDev #MCP #ModelContextProtocol #AI #AgentAI #ClaudeCode #GooglePlay #AndroidVitals #MobilePerformance #MobileEngineering #OpenSource

---

## Poster 1 — The Problem

**Headline:**
Every Android dev knows this loop.

**Body:**
Your crash rate spikes.

You open Play Console → filter by version → switch to ANR tab → filter again → copy numbers into a doc → paste into your AI chat for context → wait → still not sure which build caused it.

30 minutes later you've gathered data but haven't written a single line of fix.

The data was always there.
You just had to hunt for it — manually — every single time.

**Hook at the bottom:**
There's a better way →

---

## Poster 2 — The Solution

**Headline:**
What if you just… asked?

**Body:**
android-vitals-mcp connects your AI coding assistant directly to the Google Play Developer Reporting API.

Instead of clicking through dashboards, you ask:

→ "why is the cold start getting slower?"
→ "which version caused the ANR spike?"
→ "the app feels janky on Android 14, what happened?"

Your agent pulls the real numbers — broken down by version code and API level — compares them against Google's thresholds, and walks you through exactly what to fix.

It ships with 4 skills that auto-trigger on keywords like "ANR", "jank", or "cold start". You don't even have to think about it. It just kicks in when it's relevant.

**Metrics it tracks:**
- 💥 Crash rate by version & API level
- 🥶 ANR rate (7-day user-weighted)
- 🖼️ Slow rendering at 20fps & 30fps
- 🚀 Startup time: COLD / WARM / HOT

---

## Poster 3 — Get Started

**Headline:**
Two commands. That's it.

**Body:**
```
npx android-vitals-mcp setup
```
A wizard that connects your Google Service Account and writes the MCP config into every AI CLI it detects — Claude Code, Gemini, Cursor, Kiro. Press Enter to skip any prompt and fill in values later.

```
npx android-vitals-install-skills
```
Installs 4 guided skill playbooks into every detected AI CLI. Re-run anytime — it's idempotent.

Then restart your AI CLI and ask:
**"improve my Android crash rate"**

Works with: Claude Code · Gemini CLI · Cursor · GitHub Copilot · Cline · Kiro · Amp · OpenCode · Codex

📦 npmjs.com/package/android-vitals-mcp
