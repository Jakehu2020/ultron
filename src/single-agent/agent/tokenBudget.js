/** Rough token estimate: ~4 chars/token for English text and most code. */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function messageTokens(message) {
  const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
  const toolCallText = message.tool_calls ? JSON.stringify(message.tool_calls) : "";
  return estimateTokens(text) + estimateTokens(toolCallText) + 4; // small per-message overhead
}

/**
 * Keeps the system message plus as much recent history as fits in
 * maxTokens, dropping the oldest non-system messages first and leaving a
 * one-line marker so the model knows context was trimmed.
 *
 * Intentionally simple. Extension point: swap this for a real tokenizer,
 * or replace the dropped-messages marker with an actual summary produced
 * by a cheap model call, once the orchestration layer has a "summarizer"
 * agent role.
 */
export function trimHistory(messages, maxTokens) {
  const system = messages[0]?.role === "system" ? [messages[0]] : [];
  const rest = messages.slice(system.length);

  let total = system.reduce((sum, m) => sum + messageTokens(m), 0);
  const kept = [];
  for (let i = rest.length - 1; i >= 0; i--) {
    const t = messageTokens(rest[i]);
    if (total + t > maxTokens && kept.length > 0) break;
    kept.unshift(rest[i]);
    total += t;
  }

  const dropped = rest.length - kept.length;
  if (dropped > 0) {
    return [...system, { role: "system", content: `[${dropped} earlier message(s) truncated to save tokens]` }, ...kept];
  }
  return [...system, ...kept];
}
