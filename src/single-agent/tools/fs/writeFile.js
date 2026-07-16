import fs from "node:fs/promises";
import path from "node:path";
import { LIMITS } from "../../safety/limits.js";

export function createWriteFileTool({ workspaceGuard, confirm }) {
  return {
    name: "write_file",
    description:
      "Create a new file, or overwrite an existing one when overwrite=true. Prefer edit_file for changes to existing files — it costs far fewer tokens than rewriting the whole file. Overwriting an existing file asks for confirmation first.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to workspace root" },
        content: { type: "string", description: "Full file content" },
        overwrite: { type: "boolean", description: "Set true to replace an existing file (default false)" },
      },
      required: ["path", "content"],
    },
    async execute({ path: relPath, content, overwrite = false }) {
      if (Buffer.byteLength(content, "utf8") > LIMITS.MAX_FILE_WRITE_BYTES) {
        return { error: true, message: `Content exceeds max write size (${LIMITS.MAX_FILE_WRITE_BYTES} bytes)` };
      }

      const absPath = workspaceGuard.resolvePath(relPath);
      const exists = await fs
        .access(absPath)
        .then(() => true)
        .catch(() => false);

      if (exists && !overwrite) {
        return { error: true, message: `File already exists: ${relPath}. Pass overwrite=true or use edit_file.` };
      }

      if (exists && overwrite) {
        const approved = confirm ? await confirm({ type: "overwrite_file", path: relPath, reason: "overwrites an existing file" }) : false;
        if (!approved) {
          return { error: true, cancelled: true, message: `Overwrite of ${relPath} was not approved.` };
        }
      }

      await fs.mkdir(path.dirname(absPath), { recursive: true });
      await fs.writeFile(absPath, content, "utf8");
      return { path: relPath, bytes_written: Buffer.byteLength(content, "utf8"), overwritten: exists };
    },
  };
}
