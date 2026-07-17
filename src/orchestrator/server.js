import http from "node:http";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { QueenWorker } from "./queenWorker.js";
import { loadConfig } from "../single-agent/config.js";
import { logger } from "../single-agent/utils/logger.js";

const PORT = 2048;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "public");
const SETTINGS_FILE = path.join(__dirname, "..", "..", ".ultron-settings.json");

const sseClients = new Set();
export const pendingConfirmations = new Map();
let processing = false;

const DEFAULT_SETTINGS = {
  workerTools: {
    planner: { read_file: "allow", list_dir: "allow", search_files: "allow", write_file: "deny", apply_diff: "deny", run_command: "deny" },
    coder: { read_file: "allow", list_dir: "allow", search_files: "allow", write_file: "allow", apply_diff: "allow", run_command: "allow" },
    reviewer: { read_file: "allow", list_dir: "allow", search_files: "allow", write_file: "deny", apply_diff: "deny", run_command: "deny" }
  },
  queen: { requireAgents: false },
  appearance: "dark"
};

let settings = (() => {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fsSync.readFileSync(SETTINGS_FILE, "utf-8")) };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
})();

function persistSettings() {
  fsSync.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

export function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(msg);
}

function confirmPrompt(workerId, toolName, args) {
  return new Promise((resolve) => {
    const requestId = `conf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    pendingConfirmations.set(requestId, { resolve });
    broadcast("confirmation:request", { requestId, workerId, toolName, args });
  });
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

async function serveStatic(res, urlPath) {
  let filePath = urlPath === "/" ? "/index.html" : urlPath;
  filePath = path.join(PUBLIC, filePath);
  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "text/plain" });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // SSE endpoint
  if (req.method === "GET" && req.url === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(":\n\n");
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  // GET /api/settings
  if (req.method === "GET" && req.url === "/api/settings") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(settings));
    return;
  }

  // POST /api/settings
  if (req.method === "POST" && req.url === "/api/settings") {
    try {
      const body = await readBody(req);
      const incoming = JSON.parse(body);
      settings = { ...DEFAULT_SETTINGS, ...incoming };
      persistSettings();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // POST /api/confirmation
  if (req.method === "POST" && req.url === "/api/confirmation") {
    try {
      const body = await readBody(req);
      const { requestId, approved } = JSON.parse(body);
      const pending = pendingConfirmations.get(requestId);
      if (!pending) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unknown requestId" }));
        return;
      }
      pendingConfirmations.delete(requestId);
      pending.resolve(!!approved);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Chat endpoint
  if (req.method === "POST" && req.url === "/api/chat") {
    if (processing) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Queen is busy processing a request." }));
      return;
    }

    processing = true;
    try {
      const body = await readBody(req);
      const { message } = JSON.parse(body);

      if (!message || !message.trim()) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Message is required." }));
        processing = false;
        return;
      }

      const config = loadConfig();
      const queen = new QueenWorker({
        baseConfig: config,
        confirm: async () => true,
        settings,
        confirmPrompt,
      });

      broadcast("queen:start", { message });

      const { summary, workerRuns } = await queen.run(message, {
        onEvent: (event) => broadcast("queen:event", event),
      });

      broadcast("queen:done", { summary, workerRuns });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ summary, workerRuns }));
    } catch (err) {
      logger.warn(`[server] queen error: ${err.message}`);
      broadcast("queen:error", { error: err.message });
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    } finally {
      processing = false;
    }
    return;
  }

  // Static files
  await serveStatic(res, req.url);
});

server.listen(PORT, () => {
  console.log(`\n  ultron web interface: http://localhost:${PORT}\n`);
});
