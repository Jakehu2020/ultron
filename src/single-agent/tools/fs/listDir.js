import fs from "node:fs/promises";
import path from "node:path";
import { LIMITS } from "../../safety/limits.js";

const IGNORE = new Set(["node_modules", ".git", "dist", "build", "__pycache__", ".venv", "venv", ".next", "coverage"]);

export function createListDirTool({ workspaceGuard }) {
  return {
    name: "list_dir",
    description:
      "List files and directories under a path in the workspace. Non-recursive by default; set depth for nested listings. Common noise directories (node_modules, .git, dist, build, venv, etc.) are skipped automatically.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory relative to workspace root (default '.')" },
        depth: { type: "integer", description: "How many levels deep to recurse (default 1, max 4)" },
        show_hidden: { type: "boolean", description: "Include dotfiles/dot-directories (default false)" },
      },
    },
    async execute({ path: relPath = ".", depth = 1, show_hidden = false }) {
      const absRoot = workspaceGuard.resolvePath(relPath);
      const maxDepth = Math.min(depth, 4);
      const entries = [];

      async function walk(dir, level, prefix) {
        if (entries.length >= LIMITS.MAX_LIST_ENTRIES) return;
        let dirents;
        try {
          dirents = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        dirents.sort((a, b) => a.name.localeCompare(b.name));
        for (const d of dirents) {
          if (entries.length >= LIMITS.MAX_LIST_ENTRIES) break;
          if (!show_hidden && d.name.startsWith(".")) continue;
          if (IGNORE.has(d.name)) continue;
          const rel = prefix ? `${prefix}/${d.name}` : d.name;
          entries.push(`${rel}${d.isDirectory() ? "/" : ""}`);
          if (d.isDirectory() && level < maxDepth) {
            await walk(path.join(dir, d.name), level + 1, rel);
          }
        }
      }

      await walk(absRoot, 1, "");
      return {
        path: relPath,
        entries,
        truncated: entries.length >= LIMITS.MAX_LIST_ENTRIES,
      };
    },
  };
}
