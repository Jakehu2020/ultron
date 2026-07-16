#!/usr/bin/env node
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadConfig } from "./config.js";
import { createWorkspaceGuard } from "./safety/workspaceGuard.js";
import { createToolRegistry } from "./tools/index.js";
import { createLLMClient } from "./llm/client.js";
import { buildSystemPrompt } from "./agent/systemPrompt.js";
import { Agent } from "./agent/loop.js";
import { logger } from "./utils/logger.js";

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
  const config = loadConfig({
    workspaceRoot: argv.workspace,
    model: argv.model,
    baseUrl: argv["base-url"],
  });

  const workspaceGuard = createWorkspaceGuard(config.workspaceRoot);
  const rl = readline.createInterface({ input: stdin, output: stdout });

  const confirm = async ({ type, command, path, reason }) => {
    const desc = type === "run_command" ? `run: ${command}` : `overwrite: ${path}`;
    const answer = await rl.question(`\n⚠ Confirm needed (${reason}) — ${desc}\nProceed? [y/N] `);
    return answer.trim().toLowerCase() === "y";
  };

  const tools = createToolRegistry({ workspaceGuard, config, confirm });
  const llmClient = createLLMClient({ baseUrl: config.baseUrl, apiKey: config.apiKey });
  const systemPrompt = buildSystemPrompt({ workspaceRoot: workspaceGuard.root });
  const agent = new Agent({ config, llmClient, tools, systemPrompt });

  console.log(`codewrapper — workspace: ${workspaceGuard.root}`);
  console.log(`model: ${config.model}  endpoint: ${config.baseUrl}`);
  console.log(`type a message, or "exit" to quit\n`);

  while (true) {
    const input = await rl.question("> ");
    if (["exit", "quit", ":q"].includes(input.trim().toLowerCase())) break;
    if (!input.trim()) continue;

    try {
      await agent.run(input, {
        onEvent: (event) => {
          if (event.type === "tool_call") logger.toolCall(event.name, event.args);
          else if (event.type === "tool_result") logger.toolResult(event.name, event.result);
          else if (event.type === "assistant") logger.assistant(event.text);
        },
      });
    } catch (err) {
      logger.warn(err.message);
    }
  }

  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
