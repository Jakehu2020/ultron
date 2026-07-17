import { createRoleAgent } from "./agentFactory.js";
import { buildQueenPrompt } from "./queenPrompt.js";
import { loadConfig } from "../single-agent/config.js";
import { createWorkspaceGuard } from "../single-agent/safety/workspaceGuard.js";
import { createToolRegistry } from "../single-agent/tools/index.js";
import { createLLMClient } from "../single-agent/llm/client.js";
import { Agent } from "../single-agent/agent/loop.js";
import { logger } from "../single-agent/utils/logger.js";

let workerIdCounter = 0;

/**
 * Creates the dispatch_worker and collect_workers tools.
 *
 * dispatch_worker:
 *   - background:false (default) — synchronous, waits for the worker and returns its result.
 *   - background:true — asynchronous, fires the worker in the background and
 *     returns immediately with a pending id. Use collect_workers to retrieve
 *     results later.
 *
 * collect_workers:
 *   - ids: string[] (optional) — specific worker ids to collect.
 *     Omit to collect ALL pending/completed workers.
 *   - Returns each worker's status, result, and iteration count.
 */
export function createWorkerTools({ globalConfig, confirm, createWorker, settings, confirmPrompt }) {
  const pending = new Map(); // id -> { role, task, status, promise, result, collected }
  const allRuns = [];

  const makeRun = createWorker || ((role, workerId) => {
    const beforeToolCall = async (toolName, args) => {
      const permission = settings?.workerTools?.[role]?.[toolName];
      if (permission === "deny") return false;
      if (permission === "prompt") {
        return await confirmPrompt(workerId, toolName, args);
      }
      return true;
    };
    return createRoleAgent({ role, globalConfig, confirm, beforeToolCall });
  });

  const dispatchTool = {
    name: "dispatch_worker",
    description:
      "Dispatch a task to a worker agent. Workers are specialized: " +
      "'planner' explores the codebase and creates plans (read-only), " +
      "'coder' implements changes (full access), " +
      "'reviewer' reviews work and reports issues (read-only). " +
      "Set background:true to fire-and-forget (async) and collect results later with collect_workers. " +
      "Set background:false (default) to wait for the result before continuing (sync).",
    parameters: {
      type: "object",
      properties: {
        role: {
          type: "string",
          enum: ["planner", "coder", "reviewer"],
          description: "The worker role to dispatch",
        },
        task: {
          type: "string",
          description: "The specific task for this worker to complete",
        },
        background: {
          type: "boolean",
          description: "If true, dispatch async and return immediately with an id. If false (default), wait for the result before continuing (sync).",
        },
      },
      required: ["role", "task"],
    },
    async execute({ role, task, background = false }) {
      const id = `w-${++workerIdCounter}`;
      logger.warn(`  [queen] dispatching ${role} worker ${id}${background ? " (async)" : ""}`);

      // Build context from previous worker results so the queen doesn't
      // have to repeat background info in every task description.
      const prevResults = [];
      for (const [, entry] of allRuns) {
        if (entry.result?.finalText) {
          const snippet = entry.result.finalText.slice(0, 400);
          prevResults.push(`[${entry.role}] ${snippet}`);
        }
      }
      const contextBlock = prevResults.length
        ? `PREVIOUS WORKER RESULTS:\n${prevResults.join("\n")}\n\n`
        : "";
      const fullTask = contextBlock + `TASK: ${task}`;

      const runWorker = async () => {
        const worker = makeRun(role, id);
        const result = await worker.run(fullTask);
        allRuns.push({ id, role, iterations: result.iterations, task });
        logger.warn(`  [queen] ${role} ${id} returned (${result.iterations} iterations)`);
        return result;
      };

      if (background) {
        const promise = runWorker();
        pending.set(id, { role, task, status: "pending", promise, result: null, collected: false });
        promise.then(
          (result) => {
            const entry = pending.get(id);
            if (entry) {
              entry.status = "complete";
              entry.result = result;
            }
          },
          (err) => {
            const entry = pending.get(id);
            if (entry) {
              entry.status = "error";
              entry.result = { error: true, message: err.message };
            }
          }
        );
        return { id, role, status: "dispatched" };
      }

      // Synchronous: wait for the worker.
      const result = await runWorker();
      return {
        id,
        role,
        result: result.finalText,
        iterations: result.iterations,
      };
    },
  };

  const collectTool = {
    name: "collect_workers",
    description:
      "Collect results from previously dispatched workers. " +
      "Call with no ids to get all pending and completed workers. " +
      "Call with specific ids to get those workers. " +
      "Pending workers show status:'pending'; completed workers include their result.",
    parameters: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          description: "Worker ids to collect. Omit for all.",
        },
      },
    },
    async execute({ ids } = {}) {
      const results = [];
      const reported = [];
      for (const [id, entry] of pending) {
        if (ids && !ids.includes(id)) continue;
        results.push({
          id,
          role: entry.role,
          status: entry.status,
          result: entry.status === "complete" ? entry.result?.finalText : undefined,
          iterations: entry.status === "complete" ? entry.result?.iterations : undefined,
        });
        reported.push([id, entry]);
      }

      // Mark everything we reported as collected (before pruning).
      for (const [, entry] of reported) {
        entry.collected = true;
      }

      // Prune entries that have been reported before (collected already true)
      // and are now terminal (complete/error). This lets a completed entry
      // survive exactly one collection and be removed on the next.
      for (const [id, entry] of reported) {
        if ((entry.status === "complete" || entry.status === "error") && entry.collected) {
          pending.delete(id);
        }
      }

      return { workers: results };
    },
  };

  dispatchTool.getRunHistory = () => [...allRuns];
  dispatchTool.resetRunHistory = () => { allRuns.length = 0; };

  return [dispatchTool, collectTool];
}

/**
 * The queen-worker orchestrator.
 *
 * The queen is an Agent with all standard tools PLUS dispatch_worker and
 * collect_workers. It can dispatch workers synchronously (waits for result)
 * or asynchronously (fires in background, collects later).
 */
export class QueenWorker {
  /**
   * @param {object} opts
   * @param {object} opts.baseConfig    Result of loadConfig() at top level.
   * @param {Function} opts.confirm     Shared human-confirmation callback.
   * @param {object} [opts.settings]    Worker tool permissions and queen settings.
   * @param {Function} [opts.confirmPrompt] Confirmation callback for "prompt" mode tool permissions.
   */
  constructor({ baseConfig, confirm, settings, confirmPrompt }) {
    this.baseConfig = baseConfig;
    this.confirm = confirm;
    this.settings = settings;
    this.confirmPrompt = confirmPrompt;
  }

  /**
   * Run the queen-worker orchestrator on a goal.
   * @param {string} goal  The user's goal or task description.
   * @param {object} [opts]
   * @param {Function} [opts.onEvent]  Called for every agent event.
   * @returns {Promise<{ summary: string, workerRuns: Array<object> }>}
   */
  async run(goal, { onEvent } = {}) {
    const config = loadConfig(this.baseConfig);
    const workspaceGuard = createWorkspaceGuard(config.workspaceRoot);

    const tools = createToolRegistry({ workspaceGuard, config, confirm: this.confirm });
    const [dispatchTool, collectTool] = createWorkerTools({
      globalConfig: this.baseConfig,
      confirm: this.confirm,
      settings: this.settings,
      confirmPrompt: this.confirmPrompt,
    });
    tools.push(dispatchTool, collectTool);

    const llmClient = createLLMClient({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      fallbackModels: config.fallbackModels,
    });

    const systemPrompt = buildQueenPrompt({
      workspaceRoot: workspaceGuard.root,
      goal,
      requireAgents: this.settings?.queen?.requireAgents ?? false,
    });
    const queen = new Agent({ config, llmClient, tools, systemPrompt });

    logger.warn(`\n[queen] goal: ${goal}`);
    logger.warn(`[queen] workspace: ${workspaceGuard.root}\n`);

    const finalText = await queen.run(goal, {
      onEvent: (event) => {
        onEvent?.(event);
        if (event.type === "tool_call" && event.name === "dispatch_worker") {
          logger.warn(`[queen] dispatching worker: ${JSON.stringify(event.args)}`);
        } else if (event.type === "tool_result" && event.name === "dispatch_worker") {
          const preview = JSON.stringify(event.result).slice(0, 200);
          logger.warn(`[queen] worker returned: ${preview}...`);
        } else if (event.type === "tool_call") {
          logger.toolCall(event.name, event.args);
        } else if (event.type === "tool_result") {
          logger.toolResult(event.name, event.result);
        } else if (event.type === "assistant") {
          logger.assistant(event.text);
        }
      },
    });

    return {
      summary: finalText,
      workerRuns: dispatchTool.getRunHistory(),
    };
  }
}
