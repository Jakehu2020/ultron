import { loadConfig } from "../single-agent/config.js";
import { createWorkspaceGuard } from "../single-agent/safety/workspaceGuard.js";
import { createToolRegistry } from "../single-agent/tools/index.js";
import { createLLMClient } from "../single-agent/llm/client.js";
import { Agent } from "../single-agent/agent/loop.js";
import { buildSystemPrompt } from "../single-agent/agent/systemPrompt.js";

/**
 * Per-role tool profiles. An orchestrator can hand each agent a *filtered
 * subset* of the tool registry so that, e.g., a "reviewer" cannot write files
 * or run commands, while a "coder" gets the full set. Each profile lists the
 * tool names that role is allowed to use.
 */
const ROLE_TOOL_PROFILES = {
  planner: ["read_file", "list_dir", "search_files"],
  coder: ["read_file", "list_dir", "search_files", "write_file", "edit_file", "run_command"],
  reviewer: ["read_file", "list_dir", "search_files"],
  default: ["read_file", "list_dir", "search_files", "write_file", "edit_file", "run_command"],
};

/**
 * Builds an isolated Agent for a single role in the orchestration pipeline.
 *
 * The orchestrator reuses the single-agent `Agent` class unmodified: each role
 * gets its own config (model/workspace overrides), its own workspace guard,
 * its own scoped tool registry, its own system prompt, and a shared confirm
 * callback. Agents never share conversation state — they only talk through the
 * orchestrator's message passing (see coordinator.js).
 *
 * Returns a wrapper with the same `.run(userInput)` interface but whose return
 * value is `{ finalText, iterations }` instead of a plain string, so the
 * coordinator can track per-role iteration counts.
 *
 * @param {object} opts
 * @param {string} opts.role            Role name (planner|coder|reviewer|...).
 * @param {object} opts.globalConfig    Base config (from loadConfig at top level).
 * @param {Function} opts.confirm       Shared human-confirmation callback.
 * @param {object} [opts.overrides]     Per-role config overrides (model, workspaceRoot, allowNetworkCommands...).
 */
export function createRoleAgent({ role, globalConfig, confirm, overrides = {}, beforeToolCall }) {
  const config = loadConfig({ ...globalConfig, ...overrides });
  const workspaceGuard = createWorkspaceGuard(config.workspaceRoot);

  const fullRegistry = createToolRegistry({ workspaceGuard, config, confirm });
  const profile = ROLE_TOOL_PROFILES[role] ?? ROLE_TOOL_PROFILES.default;
  const registry = fullRegistry.filter((tool) => profile.includes(tool.name));

  const client = createLLMClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    fallbackModels: config.fallbackModels,
  });

  const systemPrompt = buildSystemPrompt({ workspaceRoot: config.workspaceRoot });

  // Wrap the client to count LLM calls (= loop iterations) per run.
  let iterationCount = 0;
  const countingClient = {
    async chat(params) {
      iterationCount++;
      return client.chat(params);
    },
  };

  const agent = new Agent({ config, llmClient: countingClient, tools: registry, systemPrompt, beforeToolCall });

  return {
    async run(task) {
      iterationCount = 0;
      const finalText = await agent.run(task);
      return { finalText, iterations: iterationCount };
    },
  };
}
