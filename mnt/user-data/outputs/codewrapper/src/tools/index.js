import { createReadFileTool } from "./fs/readFile.js";
import { createListDirTool } from "./fs/listDir.js";
import { createWriteFileTool } from "./fs/writeFile.js";
import { createEditFileTool } from "./fs/editFile.js";
import { createSearchFilesTool } from "./fs/searchFiles.js";
import { createRunCommandTool } from "./terminal/runCommand.js";

/**
 * Builds the default tool set. This is the main extension point for a
 * future orchestration system: a coordinator can call this once per agent
 * with a shared or per-agent workspaceGuard/config/confirm, then hand each
 * agent a filtered subset of the resulting array — e.g. a "reviewer" agent
 * that only gets read_file/search_files, with no write or terminal access.
 */
export function createToolRegistry({ workspaceGuard, config, confirm }) {
  const ctx = { workspaceGuard, config, confirm };
  return [
    createReadFileTool(ctx),
    createListDirTool(ctx),
    createSearchFilesTool(ctx),
    createWriteFileTool(ctx),
    createEditFileTool(ctx),
    createRunCommandTool(ctx),
  ];
}

/** Converts internal tool definitions into OpenAI-compatible function schemas. */
export function toOpenAITools(registry) {
  return registry.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? { type: "object", properties: {} },
    },
  }));
}
