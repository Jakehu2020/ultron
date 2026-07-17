/**
 * Thin client for modelrelay's OpenAI-compatible /v1/chat/completions
 * endpoint. Falls back through the model chain on failure:
 * deepseek-v4-flash -> hy3 -> nemotron-3-ultra -> north-mini-code -> mimo-v2.5
 *
 * Includes automatic retry and model fallback: if the primary model fails,
 * the client retries once, then tries each fallback model in order.
 */
export function createLLMClient({ baseUrl, apiKey, fallbackModels = [] }) {
  async function singleRequest(model, messages, tools) {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        ...(tools && tools.length ? { tools, tool_choice: "auto" } : {}),
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`modelrelay request failed (${res.status}): ${body.slice(0, 500)}`);
    }

    const data = await res.json();
    const choice = data.choices?.[0];
    if (!choice) throw new Error("modelrelay returned no choices");
    return choice.message;
  }

  async function chat({ model, messages, tools }) {
    const candidates = [model, ...fallbackModels.filter((m) => m !== model)];
    let lastError;

    for (let i = 0; i < candidates.length; i++) {
      const m = candidates[i];

      // first attempt
      try {
        return await singleRequest(m, messages, tools);
      } catch (err) {
        lastError = err;
        if (i === 0) console.log(`  [ultron] model "${m}" failed, retrying...`);
      }

      // one retry on the same model
      try {
        return await singleRequest(m, messages, tools);
      } catch (err) {
        lastError = err;
        console.log(`  [ultron] model "${m}" failed twice: ${err.message.slice(0, 120)}`);
      }

      // if there are more candidates, log the switch
      if (i < candidates.length - 1) {
        console.log(`  [ultron] falling back to "${candidates[i + 1]}"...`);
      }
    }

    throw lastError;
  }

  return { chat };
}
