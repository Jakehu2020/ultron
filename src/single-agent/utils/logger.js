const COLORS = {
  tool: "\x1b[36m",
  result: "\x1b[90m",
  assistant: "\x1b[32m",
  warn: "\x1b[33m",
  reset: "\x1b[0m",
};

function tag(label, color) {
  return `${COLORS[color] ?? ""}${label}${COLORS.reset}`;
}

export const logger = {
  toolCall(name, args) {
    console.log(`${tag("→ tool", "tool")} ${name} ${JSON.stringify(args)}`);
  },
  toolResult(name, result) {
    const preview = JSON.stringify(result);
    console.log(`${tag("← result", "result")} ${name} ${preview.length > 300 ? preview.slice(0, 300) + "…" : preview}`);
  },
  assistant(text) {
    console.log(`${tag("assistant", "assistant")} ${text}`);
  },
  warn(text) {
    console.log(`${tag("warn", "warn")} ${text}`);
  },
};
