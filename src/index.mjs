#!/usr/bin/env node
// Minimal MCP bridge for the OpenCode V2 HTTP API.
// Lets any MCP client (Cursor, Claude, ...) run OpenCode agents with a chosen model.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE = (process.env.OPENCODE_BASE_URL || "http://127.0.0.1:4096").replace(/\/+$/, "");
const USER = process.env.OPENCODE_SERVER_USERNAME || "opencode";
const PASS = process.env.OPENCODE_SERVER_PASSWORD || "";
const DEFAULT_DIR = process.env.OPENCODE_DEFAULT_DIRECTORY || process.cwd();
const FORCE_MODEL = process.env.OPENCODE_FORCE_MODEL || "";
const FALLBACK_MODEL = process.env.OPENCODE_FALLBACK_MODEL || "";
const AUTH = PASS ? "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64") : undefined;

async function api(method, path, body, timeoutMs = 300_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(AUTH ? { Authorization: AUTH } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await res.text();
    const data = raw ? JSON.parse(raw) : null;
    if (!res.ok) {
      throw new Error(`${res.status} ${method} ${path}: ${raw.slice(0, 500)}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function qs(params) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) s.set(k, v);
  const out = s.toString();
  return out ? `?${out}` : "";
}

function parseModel(model) {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  if (slash <= 0) throw new Error(`model must be "provider/model", got "${model}"`);
  const providerID = model.slice(0, slash);
  const rest = model.slice(slash + 1);
  const hash = rest.indexOf("#");
  return {
    providerID,
    id: hash === -1 ? rest : rest.slice(0, hash),
    ...(hash === -1 ? {} : { variant: rest.slice(hash + 1) }),
  };
}

function textResult(value, isError = false) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function finalAssistant(messages) {
  const list = messages || [];
  const assistant = list
    .filter((m) => m.type === "assistant")
    .sort((a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0))[0];
  if (!assistant) return null;
  const text = (assistant.content || [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  return { id: assistant.id, agent: assistant.agent, model: assistant.model, text, cost: assistant.cost, tokens: assistant.tokens };
}

async function waitForIdle(sessionID, timeoutMs) {
  try {
    await api("POST", `/api/experimental/session/${sessionID}/wait`, undefined, timeoutMs);
    return true;
  } catch (err) {
    if (err.name === "AbortError") return false;
    throw err;
  }
}

function modelLabel(model) {
  if (!model) return "server-default";
  return `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`;
}

function latestError(messages) {
  const failed = (messages || [])
    .filter((m) => m.type === "idle" && m.error)
    .sort((a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0));
  return failed[0]?.error ?? null;
}

async function runTask({ dir, agent, model, prompt, title, timeoutSeconds }) {
  const created = await api("POST", "/api/session", {
    agent: agent ?? null,
    model: model ?? null,
    location: { directory: dir },
    title: title ?? null,
  });
  const sessionID = created.data.id;
  await api("POST", `/api/session/${sessionID}/prompt`, { text: prompt });
  const finished = await waitForIdle(sessionID, (timeoutSeconds ?? 50) * 1000);
  const info = (await api("GET", `/api/session/${sessionID}`)).data;
  const messages = (await api("GET", `/api/session/${sessionID}/message`)).data;
  const last = finalAssistant(messages);
  const error = latestError(messages);
  return {
    sessionID,
    finished,
    outcome: info.outcome,
    agent: info.agent,
    model: info.model,
    cost: info.cost,
    tokens: info.tokens,
    text: last?.text ?? "(no assistant message yet)",
    ...(error ? { error: { type: error.type, message: error.message, status: error.status } } : {}),
  };
}

function shouldFallback(result) {
  // Only retry a genuinely failed run. A timeout means the job is still running.
  if (!result.finished) return false;
  if (result.outcome === "cancelled" || result.outcome === "interrupted") return false;
  return result.outcome === "failed";
}


const server = new McpServer({ name: "opencode-v2", version: "1.0.0" });

server.registerTool(
  "oc_agents",
  {
    title: "List OpenCode agents",
    description:
      "List agents available in an OpenCode project, including each agent's mode and assigned model. Use the returned id as the `agent` argument of oc_task.",
    inputSchema: {
      directory: z.string().optional().describe("Absolute project directory (defaults to the bridge's configured directory)"),
    },
  },
  async ({ directory }) => {
    try {
      const dir = directory || DEFAULT_DIR;
      const res = await api("GET", `/api/agent${qs({ directory: dir })}`);
      const agents = (res?.data || []).map((a) => ({
        id: a.id,
        name: a.name,
        mode: a.mode,
        description: a.description,
        model: a.model,
        hidden: a.hidden,
      }));
      return textResult({ directory: dir, agents });
    } catch (err) {
      return textResult(`Error: ${err.message}`, true);
    }
  },
);

server.registerTool(
  "oc_models",
  {
    title: "List OpenCode models",
    description: "List models available to OpenCode, optionally filtered by provider. Returns ids usable as `model` (provider/model).",
    inputSchema: {
      directory: z.string().optional(),
      provider: z.string().optional().describe("Filter by provider id, e.g. google"),
    },
  },
  async ({ directory, provider }) => {
    try {
      const dir = directory || DEFAULT_DIR;
      const res = await api("GET", `/api/model${qs({ directory: dir })}`);
      const items = (res?.data || []).map((m) => ({
        id: `${m.providerID}/${m.id}`,
        providerID: m.providerID,
        name: m.name,
        variants: (m.variants || []).map((v) => v.id ?? v),
        cost: m.cost,
      }));
      const filtered = provider ? items.filter((m) => m.providerID === provider) : items;
      return textResult({ count: filtered.length, models: filtered });
    } catch (err) {
      return textResult(`Error: ${err.message}`, true);
    }
  },
);

server.registerTool(
  "oc_task",
  {
    title: "Run an OpenCode agent task",
    description:
      "Create a fresh OpenCode session for the given agent (and optional model override), send a prompt, and by default wait for completion. Returns the agent's final text plus session id, cost and token usage. If OPENCODE_FORCE_MODEL is set on the bridge, that model is always used.",
    inputSchema: {
      prompt: z.string().min(1).describe("Task or question for the agent"),
      agent: z.string().optional().describe("Agent id from oc_agents (e.g. build, plan, reviewer)"),
      model: z.string().optional().describe('Model override as "provider/model" or "provider/model#variant"'),
      directory: z.string().optional().describe("Absolute project directory"),
      title: z.string().optional().describe("Session title"),
      background: z.boolean().optional().describe("Return immediately with a session id instead of waiting"),
      timeoutSeconds: z.number().int().positive().max(3600).optional().describe("Max wait time in seconds (default 50, keeps calls under typical MCP client timeouts)"),
    },
  },
  async ({ prompt, agent, model, directory, title, background, timeoutSeconds }) => {
    try {
      const dir = directory || DEFAULT_DIR;
      let resolved = parseModel(FORCE_MODEL || model);
      // OpenCode does not apply an agent's configured model when a session omits it,
      // so resolve it explicitly to make "model lives in the agent file" behave as expected.
      if (!resolved && agent) {
        try {
          const info = await api("GET", `/api/agent/${encodeURIComponent(agent)}${qs({ directory: dir })}`);
          const m = info?.data?.model;
          if (m?.providerID && m?.id) resolved = { providerID: m.providerID, id: m.id, ...(m.variant ? { variant: m.variant } : {}) };
        } catch {
          // fall back to the server default model
        }
      }
      if (background) {
        const created = await api("POST", "/api/session", {
          agent: agent ?? null,
          model: resolved ?? null,
          location: { directory: dir },
          title: title ?? null,
        });
        const sessionID = created.data.id;
        await api("POST", `/api/session/${sessionID}/prompt`, { text: prompt });
        return textResult({
          sessionID,
          status: "running",
          agent: agent ?? null,
          model: resolved ?? null,
          hint: "Use oc_status to poll this session. Automatic model fallback is disabled for background runs.",
        });
      }

      let result;
      try {
        result = await runTask({ dir, agent, model: resolved, prompt, title, timeoutSeconds });
      } catch (err) {
        result = {
          sessionID: null,
          finished: true,
          outcome: "failed",
          agent: agent ?? null,
          model: resolved ?? null,
          text: "",
          error: { message: err.message },
        };
      }
      let fallback;
      if (FALLBACK_MODEL && shouldFallback(result)) {
        const alt = parseModel(FALLBACK_MODEL);
        const same = resolved && alt && resolved.providerID === alt.providerID && resolved.id === alt.id;
        if (!same) {
          const first = { model: modelLabel(result.model ?? resolved), sessionID: result.sessionID, outcome: result.outcome, error: result.error?.message };
          result = await runTask({ dir, agent, model: alt, prompt, title, timeoutSeconds });
          fallback = { from: first.model, to: modelLabel(alt), reason: first.error ?? first.outcome, originalSessionID: first.sessionID };
        }
      }

      return textResult(
        { ...result, ...(fallback ? { fallback } : {}) },
        result.outcome === "failed",
      );
    } catch (err) {
      return textResult(`Error: ${err.message}`, true);
    }
  },
);

server.registerTool(
  "oc_reply",
  {
    title: "Reply in an OpenCode session",
    description: "Send a follow-up prompt to an existing OpenCode session and wait for the answer.",
    inputSchema: {
      sessionID: z.string().describe("Session id, e.g. ses_..."),
      prompt: z.string().min(1),
      timeoutSeconds: z.number().int().positive().max(3600).optional(),
    },
  },
  async ({ sessionID, prompt, timeoutSeconds }) => {
    try {
      await api("POST", `/api/session/${sessionID}/prompt`, { text: prompt });
      const finished = await waitForIdle(sessionID, (timeoutSeconds ?? 50) * 1000);
      const info = (await api("GET", `/api/session/${sessionID}`)).data;
      const messages = (await api("GET", `/api/session/${sessionID}/message`)).data;
      const last = finalAssistant(messages);
      return textResult({ sessionID, finished, outcome: info.outcome, text: last?.text ?? "(no assistant message yet)", cost: info.cost });
    } catch (err) {
      return textResult(`Error: ${err.message}`, true);
    }
  },
);

server.registerTool(
  "oc_status",
  {
    title: "Get OpenCode session status",
    description: "Return status, agent, model, cost and the latest assistant message for a session.",
    inputSchema: {
      sessionID: z.string(),
      waitSeconds: z.number().int().min(0).max(600).optional().describe("Optionally block up to this many seconds for the session to become idle"),
    },
  },
  async ({ sessionID, waitSeconds }) => {
    try {
      if (waitSeconds) await waitForIdle(sessionID, waitSeconds * 1000);
      const info = (await api("GET", `/api/session/${sessionID}`)).data;
      const messages = (await api("GET", `/api/session/${sessionID}/message`)).data;
      const last = finalAssistant(messages);
      return textResult({
        sessionID,
        outcome: info.outcome,
        agent: info.agent,
        model: info.model,
        title: info.title,
        time: info.time,
        cost: info.cost,
        tokens: info.tokens,
        lastAssistant: last,
      });
    } catch (err) {
      return textResult(`Error: ${err.message}`, true);
    }
  },
);

server.registerTool(
  "oc_cancel",
  {
    title: "Cancel an OpenCode session",
    description: "Interrupt the active execution of a session.",
    inputSchema: { sessionID: z.string() },
  },
  async ({ sessionID }) => {
    try {
      const res = await api("POST", `/api/session/${sessionID}/interrupt`);
      return textResult({ sessionID, ...res });
    } catch (err) {
      return textResult(`Error: ${err.message}`, true);
    }
  },
);

server.registerTool(
  "oc_sessions",
  {
    title: "List OpenCode sessions",
    description: "List recent OpenCode sessions for a directory.",
    inputSchema: {
      directory: z.string().optional(),
      limit: z.number().int().positive().max(100).optional(),
    },
  },
  async ({ directory, limit }) => {
    try {
      const dir = directory || DEFAULT_DIR;
      const res = await api("GET", `/api/session${qs({ directory: dir })}`);
      const items = (res?.data || []).slice(0, limit ?? 20).map((s) => ({
        id: s.id,
        title: s.title,
        agent: s.agent,
        model: s.model,
        outcome: s.outcome,
        time: s.time,
      }));
      return textResult({ directory: dir, sessions: items });
    } catch (err) {
      return textResult(`Error: ${err.message}`, true);
    }
  },
);

await server.connect(new StdioServerTransport());
