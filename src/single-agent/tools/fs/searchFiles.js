import fs from "node:fs/promises";
import path from "node:path";
import { LIMITS } from "../../safety/limits.js";

const IGNORE = new Set(["node_modules", ".git", "dist", "build", "__pycache__", ".venv", "venv", ".next", "coverage"]);

export function createSearchFilesTool({ workspaceGuard }) {
  return {
    name: "search_files",
    description:
      "Search file contents for a regular expression across the workspace. Much cheaper than reading whole files to find something. Returns matching file:line plus the matched line, capped to a result limit.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JavaScript-flavored regular expression" },
        path: { type: "string", description: "Directory to search under, relative to workspace root (default '.')" },
        file_glob: { type: "string", description: "Optional filename filter, e.g. '*.js' or '*.py'" },
        case_sensitive: { type: "boolean", description: "Default false" },
      },
      required: ["pattern"],
    },
    async execute({ pattern, path: relPath = ".", file_glob, case_sensitive = false }) {
      const absRoot = workspaceGuard.resolvePath(relPath);
      let regex;
      try {
        regex = new RegExp(pattern, case_sensitive ? "g" : "gi");
      } catch (err) {
        return { error: true, message: `Invalid regex: ${err.message}` };
      }

      const globRegex = file_glob ? new RegExp("^" + file_glob.split("*").map(escapeRegExp).join(".*") + "$") : null;

      const results = [];
      let filesScanned = 0;

      async function walk(dir) {
        if (results.length >= LIMITS.MAX_SEARCH_RESULTS || filesScanned >= LIMITS.MAX_SEARCH_FILES_SCANNED) return;
        let dirents;
        try {
          dirents = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const d of dirents) {
          if (results.length >= LIMITS.MAX_SEARCH_RESULTS || filesScanned >= LIMITS.MAX_SEARCH_FILES_SCANNED) return;
          if (d.name.startsWith(".") || IGNORE.has(d.name)) continue;
          const full = path.join(dir, d.name);
          if (d.isDirectory()) {
            await walk(full);
            continue;
          }
          if (globRegex && !globRegex.test(d.name)) continue;
          filesScanned++;
          let content;
          try {
            content = await fs.readFile(full, "utf8");
          } catch {
            continue; // likely binary or unreadable
          }
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            regex.lastIndex = 0;
            if (regex.test(lines[i])) {
              results.push({
                path: path.relative(workspaceGuard.root, full),
                line: i + 1,
                text: lines[i].trim().slice(0, 300),
              });
              if (results.length >= LIMITS.MAX_SEARCH_RESULTS) break;
            }
          }
        }
      }

      await walk(absRoot);
      return { matches: results, truncated: results.length >= LIMITS.MAX_SEARCH_RESULTS };
    },
  };
}

function escapeRegExp(s) {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}
