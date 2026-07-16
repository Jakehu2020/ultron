import fs from "node:fs/promises";
import { LIMITS } from "../../safety/limits.js";

export function createReadFileTool({ workspaceGuard }) {
  return {
    name: "read_file",
    description:
      "Read a text file from the workspace, optionally a line range. Returns content with 1-based line numbers so it can be referenced in edit_file calls. Output is capped; use start_line/end_line to page through large files instead of reading them whole.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the workspace root" },
        start_line: { type: "integer", description: "1-based first line to return (default 1)" },
        end_line: { type: "integer", description: "1-based last line to return (default start_line + 300)" },
      },
      required: ["path"],
    },
    async execute({ path: relPath, start_line = 1, end_line }) {
      const absPath = workspaceGuard.resolvePath(relPath);
      const stat = await fs.stat(absPath).catch(() => null);
      if (!stat) return { error: true, message: `File not found: ${relPath}` };
      if (!stat.isFile()) return { error: true, message: `Not a file: ${relPath}` };

      const raw = await fs.readFile(absPath, "utf8");
      const lines = raw.split("\n");
      const from = Math.max(1, start_line);
      const to = Math.min(lines.length, end_line ?? from + LIMITS.MAX_READ_LINES - 1, from + LIMITS.MAX_READ_LINES - 1);

      const slice = lines
        .slice(from - 1, to)
        .map((line, i) => `${from + i}\t${line}`)
        .join("\n");

      return {
        path: relPath,
        total_lines: lines.length,
        returned_lines: [from, to],
        truncated: to < lines.length,
        content: slice,
      };
    },
  };
}
