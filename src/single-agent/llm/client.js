/**
 * Thin client for modelrelay's OpenAI-compatible /v1/chat/completions
 * endpoint (base URL http://127.0.0.1:7352/v1, any API key string, model
 * "auto-fastest" or a grouped id like "minimax-m2.5"/"kimi-k2.5"/"glm4.7").
 */
export function createLLMClient({ baseUrl, apiKey }) {
  async function chat({ model, messages, tools }) {
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

  return { chat };
}
