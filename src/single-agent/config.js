import { existsSync, statSync, readFileSync } from "node:fs";
import path from "node:path";

const DEFAULTS = {
  baseUrl: "http://127.0.0.1:7352/v1",
  apiKey: "no-key",
  model: "hy3",
  fallbackModels: ["nemotron-3-ultra", "north-mini-code", "mimo-v2.5"],
  allowNetworkCommands: false,
};

/**
 * Loads configuration in increasing priority order:
 *   1. built-in defaults
 *   2. .ultron.json in the current directory
 *   3. environment variables (MODELRELAY_*)
 *   4. explicit overrides (e.g. CLI flags)
 *
 * Extension point: an orchestration layer can call loadConfig() once per
 * agent with different overrides (different model, different workspace)
 * to spin up several independently configured agents.
 */
export function loadConfig(overrides = {}) {
  let fileConfig = {};
  const configPath = path.resolve(process.cwd(), ".ultron.json");
  if (existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(readFileSync(configPath, "utf8"));
    } catch (err) {
      throw new Error(`Failed to parse .ultron.json: ${err.message}`);
    }
  }

  // to be clear, you can absolutely run it without any of these.
  // modelrelay is free.
  const envConfig = {
    baseUrl: process.env.MODELRELAY_BASE_URL,
    apiKey: process.env.MODELRELAY_API_KEY,
    model: process.env.MODELRELAY_MODEL,
  };
  Object.keys(envConfig).forEach((k) => envConfig[k] === undefined && delete envConfig[k]);

  const cleanOverrides = { ...overrides };
  Object.keys(cleanOverrides).forEach((k) => cleanOverrides[k] === undefined && delete cleanOverrides[k]);

  const merged = {
    ...DEFAULTS,
    ...fileConfig,
    ...envConfig,
    ...cleanOverrides,
  };

  const workspaceRootInput = merged.workspaceRoot || "/workspace";
  const workspaceRoot = path.resolve(process.cwd(), workspaceRootInput);

  if (!existsSync(workspaceRoot) || !statSync(workspaceRoot).isDirectory()) {
    throw new Error(`Workspace root does not exist or is not a directory: ${workspaceRoot}`);
  }

  return { ...merged, workspaceRoot };
}
