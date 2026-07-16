import fs from "node:fs/promises";

export function createEditFileTool({ workspaceGuard }) {
  return {
    name: "edit_file",
    description:
      "Replace an exact, unique substring in an existing file. This is the preferred way to modify files — it sends only the changed text instead of the whole file, which uses far fewer tokens than write_file. old_str must match the file's current content exactly (whitespace included) and must appear exactly once; include enough surrounding context to make it unique.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to workspace root" },
        old_str: { type: "string", description: "Exact existing text to replace (must be unique in the file)" },
        new_str: { type: "string", description: "Replacement text (empty string to delete old_str)" },
      },
      required: ["path", "old_str"],
    },
    async execute({ path: relPath, old_str, new_str = "" }) {
      const absPath = workspaceGuard.resolvePath(relPath);
      const raw = await fs.readFile(absPath, "utf8").catch(() => null);
      if (raw === null) return { error: true, message: `File not found: ${relPath}` };

      const firstIndex = raw.indexOf(old_str);
      if (firstIndex === -1) {
        return { error: true, message: "old_str not found in file. Re-read the file and copy the exact text." };
      }
      const lastIndex = raw.lastIndexOf(old_str);
      if (firstIndex !== lastIndex) {
        return { error: true, message: "old_str is not unique in the file. Include more surrounding context." };
      }

      const updated = raw.slice(0, firstIndex) + new_str + raw.slice(firstIndex + old_str.length);
      await fs.writeFile(absPath, updated, "utf8");

      return { path: relPath, replaced_chars: old_str.length, new_chars: new_str.length };
    },
  };
}
