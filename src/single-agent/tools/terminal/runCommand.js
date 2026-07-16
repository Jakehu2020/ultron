import { spawn } from "node:child_process";
import { LIMITS } from "../../safety/limits.js";
import { classifyCommand } from "../../safety/commandGuard.js";

export function createRunCommandTool({ workspaceGuard, config, confirm }) {
  return {
    name: "run_command",
    description:
      "Run a shell command inside the workspace. The command's working directory is locked to the workspace root (or a subdirectory of it). Dangerous commands (rm -rf /, sudo, fork bombs, piping curl into a shell, etc.) are blocked outright. Destructive-but-legitimate commands (rm, mv, git reset --hard, force-push, chmod, ...) require human confirmation before they run.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        cwd: { type: "string", description: "Working directory, relative to the workspace root. Defaults to the workspace root." },
        timeout_seconds: {
          type: "integer",
          description: `Max seconds before the process is killed (default ${LIMITS.COMMAND_TIMEOUT_MS / 1000}, hard cap ${LIMITS.MAX_COMMAND_TIMEOUT_S})`,
        },
      },
      required: ["command"],
    },
    async execute({ command, cwd = ".", timeout_seconds }) {
      const resolvedCwd = workspaceGuard.resolvePath(cwd);

      const classification = classifyCommand(command, {
        workspaceGuard,
        allowNetworkCommands: !!config.allowNetworkCommands,
      });

      if (classification.blocked) {
        return { error: true, blocked: true, message: `Command blocked: ${classification.reason}` };
      }

      if (classification.needsConfirmation) {
        const approved = confirm ? await confirm({ type: "run_command", command, reason: classification.reason }) : false;
        if (!approved) {
          return {
            error: true,
            cancelled: true,
            message: `Command requires confirmation (${classification.reason}) and was not approved.`,
          };
        }
      }

      const timeoutMs = Math.min(
        (timeout_seconds ?? LIMITS.COMMAND_TIMEOUT_MS / 1000) * 1000,
        LIMITS.MAX_COMMAND_TIMEOUT_S * 1000
      );

      return await new Promise((resolve) => {
        const child = spawn(command, {
          shell: true,
          cwd: resolvedCwd,
          // Minimal, explicit env — the child does not inherit the parent's
          // full environment (API keys, secrets, etc.) by default.
          env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG },
          timeout: timeoutMs,
        });

        let stdout = "";
        let stderr = "";
        let truncated = false;

        child.stdout.on("data", (chunk) => {
          if (stdout.length < LIMITS.MAX_COMMAND_OUTPUT_BYTES) stdout += chunk.toString();
          else truncated = true;
        });
        child.stderr.on("data", (chunk) => {
          if (stderr.length < LIMITS.MAX_COMMAND_OUTPUT_BYTES) stderr += chunk.toString();
          else truncated = true;
        });

        child.on("error", (err) => {
          resolve({ error: true, message: `Failed to start command: ${err.message}` });
        });

        child.on("close", (code, signal) => {
          resolve({
            exit_code: code,
            signal,
            timed_out: code === null && signal === "SIGTERM",
            stdout: stdout.slice(0, LIMITS.MAX_COMMAND_OUTPUT_BYTES),
            stderr: stderr.slice(0, LIMITS.MAX_COMMAND_OUTPUT_BYTES),
            truncated,
          });
        });
      });
    },
  };
}
