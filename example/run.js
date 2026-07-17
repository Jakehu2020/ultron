import { createWorkspaceGuard } from "../src/single-agent/safety/workspaceGuard.js";
import { createToolRegistry } from "../src/single-agent/tools/index.js";
import { createLLMClient } from "../src/single-agent/llm/client.js";
import { buildSystemPrompt } from "../src/single-agent/agent/systemPrompt.js";
import { Agent } from "../src/single-agent/agent/loop.js";

const BASE_URL = "http://127.0.0.1:7352/v1";
const MODEL = "hy3";
const WORKSPACE = ".";

async function main() {
  const workspaceGuard = createWorkspaceGuard(WORKSPACE);
  const config = { baseUrl: BASE_URL, apiKey: "no-key", model: MODEL, fallbackModels: ["nemotron-3-ultra", "north-mini-code", "mimo-v2.5"] };

  const llmClient = createLLMClient({ baseUrl: config.baseUrl, apiKey: config.apiKey, fallbackModels: config.fallbackModels });
  const tools = createToolRegistry({ workspaceGuard, config, confirm: null });
  const systemPrompt = buildSystemPrompt({ workspaceRoot: workspaceGuard.root });
  const agent = new Agent({ config, llmClient, tools, systemPrompt });

  console.log(`workspace: ${workspaceGuard.root}`);
  console.log(`model: ${MODEL}  endpoint: ${BASE_URL}\n`);

  const prompt = process.argv[2] || "Create a WEBSITE interface to use this project";

  console.log(`> ${prompt}\n`);

  const reply = await agent.run(prompt, {
    onEvent: (event) => {
      if (event.type === "tool_call") console.log(`  -> ${event.name}(${JSON.stringify(event.args)})`);
      else if (event.type === "tool_result") console.log(`  <- ${JSON.stringify(event.result).slice(0, 200)}`);
    },
  });

  console.log(`\n${reply}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
