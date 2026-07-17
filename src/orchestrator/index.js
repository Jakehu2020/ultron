import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadConfig } from "../single-agent/config.js";
import { Coordinator } from "./coordinator.js";
import { QueenWorker } from "./queenWorker.js";
import { logger } from "../single-agent/utils/logger.js";

/**
 * Human-in-the-loop confirmation callback, reused verbatim from the
 * single-agent entry point. A single prompt serves every role's agents, so the
 * operator sees exactly which role is about to do something destructive.
 */
async function confirm({ type, command, path: filePath, reason }) {
  const detail =
    type === "run_command"
      ? `command: ${command}`
      : type === "overwrite_file"
        ? `file: ${filePath}`
        : JSON.stringify({ type, command, path: filePath });

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(
      `⚠ Confirm ${type} (${reason})? ${detail}\nAllow? [y/N] `
    );
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

/** Default orchestration pipeline: plan, implement, review. */
function defaultPipeline(userGoal) {
  return [
    {
      role: "planner",
      storeKey: "planner.plan",
      taskBuilder: (bus, prev, goal) =>
        `Goal: ${goal}\n\nExplore the workspace and produce a concrete, ordered implementation plan. ` +
        `List the files to create or modify and the steps to take. Keep it actionable.`,
    },
    {
      role: "coder",
      storeKey: "coder.summary",
      taskBuilder: (bus, prev) =>
        `Implement the following plan:\n\n${bus.get("planner", "plan")}\n\n` +
        `Use your tools to create/edit files and run commands as needed. ` +
        `When done, summarize what you changed.`,
    },
    {
      role: "reviewer",
      storeKey: "reviewer.verdict",
      taskBuilder: (bus, prev) =>
        `Review the work described below against the plan.\n\n` +
        `Plan:\n${bus.get("planner", "plan")}\n\n` +
        `Implementation summary:\n${bus.get("coder", "summary")}\n\n` +
        `Read the relevant files and report any issues, missing steps, or risks. ` +
        `Conclude with APPROVED or a list of required fixes.`,
    },
  ];
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
      args[key] = val;
    }
  }
  return args;
}

async function main() {
  const argv = parseArgs(process.argv.slice(2));
  const mode = argv.mode || "queen";
  const goal = argv._ || process.argv.slice(2).filter((a) => !a.startsWith("--")).join(" ").trim();

  if (!goal) {
    logger.warn("Usage: node src/orchestrator/index.js [--mode queen|linear] \"<goal>\"");
    process.exit(1);
  }

  const config = loadConfig();

  if (mode === "linear") {
    const coordinator = new Coordinator({
      baseConfig: config,
      confirm,
      pipeline: defaultPipeline(goal),
    });

    const { bus, steps } = await coordinator.run(goal);

    logger.assistant("\n=== Orchestration complete ===");
    for (const s of steps) {
      logger.assistant(`[${s.role}] (${s.iterations} iterations)`);
    }
    const verdict = bus["reviewer.verdict"];
    if (verdict) logger.warn(`Reviewer verdict:\n${verdict}`);
  } else {
    const queen = new QueenWorker({ baseConfig: config, confirm });
    const { summary, workerRuns } = await queen.run(goal);

    logger.assistant("\n=== Queen-worker orchestration complete ===");
    for (const run of workerRuns) {
      logger.assistant(`  [${run.role}] ${run.iterations} iterations`);
    }
    logger.assistant(`\nTotal workers dispatched: ${workerRuns.length}`);
    if (summary) logger.assistant(`\nQueen's summary:\n${summary}`);
  }
}

main().catch((err) => {
  console.error("Orchestrator failed:", err);
  process.exit(1);
});
