import fs from "node:fs";
import path from "node:path";

export class WorkspaceViolationError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkspaceViolationError";
  }
}

/**
 * Creates a guard bound to a single workspace root. Every filesystem and
 * terminal tool routes paths through resolvePath() so there is exactly one
 * place that enforces the workspace boundary. This is the tool to reuse
 * unmodified if/when this becomes a multi-agent orchestrator — each agent
 * can share the same guard, or get its own guard for a different subtree.
 */
export function createWorkspaceGuard(workspaceRoot) {
  const root = fs.realpathSync(path.resolve(workspaceRoot));

  function resolvePath(inputPath) {
    if (typeof inputPath !== "string" || inputPath.length === 0) {
      throw new WorkspaceViolationError("Path must be a non-empty string");
    }
    if (path.isAbsolute(inputPath) && !(inputPath === root || inputPath.startsWith(root + path.sep))) {
      throw new WorkspaceViolationError(`Absolute path "${inputPath}" is outside the workspace root`);
    }

    const candidate = path.resolve(root, inputPath);
    if (candidate !== root && !candidate.startsWith(root + path.sep)) {
      throw new WorkspaceViolationError(`Path "${inputPath}" resolves outside the workspace root`);
    }

    // Defense against symlink escapes: resolve the nearest existing
    // ancestor's real path and make sure *that* is still inside root.
    let ancestor = candidate;
    while (!fs.existsSync(ancestor) && ancestor !== path.parse(ancestor).root) {
      ancestor = path.dirname(ancestor);
    }
    if (fs.existsSync(ancestor)) {
      const real = fs.realpathSync(ancestor);
      if (real !== root && !real.startsWith(root + path.sep)) {
        throw new WorkspaceViolationError(`Path "${inputPath}" escapes the workspace root via a symlink`);
      }
    }

    return candidate;
  }

  return { root, resolvePath };
}
