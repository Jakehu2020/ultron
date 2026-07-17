import { LIMITS } from "../safety/limits.js";
import { trimHistory } from "./tokenBudget.js";
import { toOpenAITools } from "../tools/index.js";

/**
 * A single self-contained coding agent: one model, one tool set, one
 * conversation. Instantiate several of these with different config/tools/
 * systemPrompt to build a multi-agent orchestrator later — this class has
 * no global state and no knowledge of any other agent.
 */
export class Agent {
  constructor({ config, llmClient, tools, systemPrompt, beforeToolCall }) {
    this.config = config;
    this.llmClient = llmClient;
    this.tools = tools;
    this.toolsByName = new Map(tools.map((t) => [t.name, t]));
    this.openAITools = toOpenAITools(tools);
    this.messages = [{ role: "system", content: systemPrompt }];
    this.beforeToolCall = beforeToolCall;
  }

  /**
   * Runs the agent loop for one user turn: sends the message, executes any
   * tool calls the model requests, feeds results back, and repeats until
   * the model replies with plain text (or the iteration cap is hit).
   *
   * onEvent(event) fires for {type:"tool_call"}, {type:"tool_result"}, and
   * {type:"assistant"} so a CLI (or a future orchestrator) can observe
   * progress without this class knowing how it's displayed.
   */
  async run(userInput, { onEvent } = {}) {
    this.messages.push({ role: "user", content: userInput });

    for (let iteration = 0; iteration < LIMITS.MAX_AGENT_ITERATIONS; iteration++) {
      const trimmed = trimHistory(this.messages, LIMITS.MAX_HISTORY_TOKENS);
      const message = await this.llmClient.chat({
        model: this.config.model,
        messages: trimmed,
        tools: this.openAITools,
      });

      this.messages.push(message);

      if (!message.tool_calls || message.tool_calls.length === 0) {
        onEvent?.({ type: "assistant", text: message.content ?? "" });
        return message.content ?? "";
      }

      for (const call of message.tool_calls) {
        const tool = this.toolsByName.get(call.function.name);
        let args = {};
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          args = {};
        }

        onEvent?.({ type: "tool_call", name: call.function.name, args });

        let result;
        if (!tool) {
          result = { error: true, message: `Unknown tool: ${call.function.name}` };
        } else {
          const allowed = !this.beforeToolCall || (await this.beforeToolCall(call.function.name, args));
          if (!allowed) {
            result = { error: true, message: `Tool "${call.function.name}" is not permitted.` };
          } else {
            try {
              result = await tool.execute(args);
            } catch (err) {
              result = { error: true, message: `Tool threw: ${err.message}` };
            }
          }
        }

        onEvent?.({ type: "tool_result", name: call.function.name, result });

        this.messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
    }

    onEvent?.({ type: "assistant", text: "" });
    return "";
  }
}
