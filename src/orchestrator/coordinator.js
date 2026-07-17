import { MemoryBus } from "./memoryBus.js";
import { createRoleAgent } from "./agentFactory.js";
import { LIMITS } from "../single-agent/safety/limits.js";
import { logger } from "../single-agent/utils/logger.js";

/**
 * The multi-agent coordinator.
 *
 * It does NOT subclass or modify the single-agent `Agent`. Instead it composes
 * several isolated Agent instances (via `createRoleAgent`) and drives them in a
 * defined pipeline. Each step:
 *   1. Builds a role-specific task message that includes the shared MemoryBus
 *      context plus any handoff from the previous role.
 *   2. Runs that agent (which internally loops on its own tools up to
 *      maxIterations).
 *   3. Captures the agent's final text reply and stashes it on the MemoryBus
 *      for downstream roles.
 *
 * The coordinator owns the *cross-agent* concerns: ordering, the shared
 * blackboard, the global step budget, and surfacing confirm() prompts to a
 * single human in the loop.
 */
export class Coordinator {
  /**
   * @param {object} opts
   * @param {object} opts.baseConfig      Result of loadConfig() at top level.
   * @param {Function} opts.confirm       Shared human-confirmation callback.
   * @param {Array<object>} opts.pipeline List of role step descriptors:
   *     { role, overrides?, taskBuilder?, storeKey? }
   *     - role: passed to createRoleAgent.
   *     - overrides: per-role config overrides.
   *     - taskBuilder(bus, prev): (optional) returns the user message string
   *       for this role. Defaults to a generic "continue the workflow" prompt
   *       that forwards the previous role's output.
   *     - storeKey: (optional) where on the bus to stash this role's final
   *       reply (defaults to `${role}.summary`).
   */
  constructor({ baseConfig, confirm, pipeline }) {
    this.baseConfig = baseConfig;
    this.confirm = confirm;
    this.pipeline = pipeline;
    this.bus = new MemoryBus();
    this.agents = new Map();
  }

  /**
   * Build (and cache) the isolated agent for a given role step.
   * Agents are created once and reused across runs if the same role recurs.
   */
  _agentFor(step) {
    if (!this.agents.has(step.role)) {
      this.agents.set(
        step.role,
        createRoleAgent({
          role: step.role,
          globalConfig: this.baseConfig,
          confirm: this.confirm,
          overrides: step.overrides ?? {},
        })
      );
    }
    return this.agents.get(step.role);
  }

  /** Build the textual handoff context from the shared bus + previous output. */
  _defaultTaskBuilder(bus, prev) {
    const lines = ["Here is the current shared workflow state:"];
    for (const [k, v] of Object.entries(bus.snapshot())) {
      const text = typeof v === "string" ? v : JSON.stringify(v);
      lines.push(`\n[${k}]\n${text}`);
    }
    if (prev) {
      lines.push("\nYour specific task: advance the workflow using the state above.");
    } else {
      lines.push("\nYour specific task: begin the workflow.");
    }
    return lines.join("\n");
  }

  /**
   * Run the full pipeline to completion.
   * @returns {Promise<{ bus: object, steps: Array<object> }>}
   */
  async run(initialInput = "") {
    const steps = [];
    let prevOutput = initialInput;

    for (const step of this.pipeline) {
      const agent = this._agentFor(step);
      const task = step.taskBuilder
        ? step.taskBuilder(this.bus, prevOutput, initialInput)
        : this._defaultTaskBuilder(this.bus, prevOutput);

      logger.warn(`▶ orchestrator: activating role "${step.role}"`);
      const result = await agent.run(task);

      const storeKey = step.storeKey ?? `${step.role}.summary`;
      this.bus.set(step.role, storeKey.split(".").pop(), result.finalText);
      prevOutput = result.finalText;

      steps.push({
        role: step.role,
        iterations: result.iterations,
        finalText: result.finalText,
      });

      if (result.iterations >= LIMITS.MAX_AGENT_ITERATIONS) {
        logger.warn(`⚠ role "${step.role}" hit the iteration cap; continuing pipeline`);
      }
    }

    return { bus: this.bus.snapshot(), steps };
  }
}
