/**
 * Hard-blocked patterns: commands matching these are never executed,
 * regardless of confirmation. Kept intentionally broad/simple — this is
 * defense-in-depth, not a sandbox by itself (see README "Threat model").
 */
const BLOCKED_PATTERNS = [
  { re: /\brm\s+(-\w*r\w*f\w*|-\w*f\w*r\w*)\s+(\/|~)(\s|$)/i, reason: "recursive force-delete of root or home" },
  { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: "fork bomb" },
  { re: /\bmkfs(\.\w+)?\b/i, reason: "filesystem format" },
  { re: /\bdd\s+if=.*of=\/dev\//i, reason: "raw disk write" },
  { re: />\s*\/dev\/sd[a-z]/i, reason: "raw disk write" },
  { re: /\bsudo\b/i, reason: "privilege escalation" },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: "system power control" },
  { re: /curl[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i, reason: "pipe remote script into a shell" },
  { re: /wget[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i, reason: "pipe remote script into a shell" },
  { re: /\bchmod\s+-R\s+777\s+\//i, reason: "world-writable root" },
  { re: />\s*\/etc\/\S+/i, reason: "overwrite system config" },
];

/**
 * Soft-warn patterns: allowed, but only after explicit confirmation from
 * whatever `confirm` callback the host application supplies.
 */
const CONFIRM_PATTERNS = [
  { re: /\brm\b/i, reason: "deletes files" },
  { re: /\bmv\b/i, reason: "moves/overwrites files" },
  { re: /\bgit\s+push\b.*(--force|-f\b)/i, reason: "force-push (rewrites remote history)" },
  { re: /\bgit\s+reset\s+--hard\b/i, reason: "discards uncommitted work" },
  { re: /\bgit\s+clean\s+-\w*f/i, reason: "deletes untracked files" },
  { re: /\bnpm\s+publish\b/i, reason: "publishes a package" },
  { re: /\bchmod\b/i, reason: "changes file permissions" },
  { re: /\bkill\b|\bpkill\b/i, reason: "terminates processes" },
  { re: /\btruncate\b/i, reason: "truncates a file" },
  { re: />\s*[^&|]/i, reason: "redirects output, may overwrite a file" },
];

const NETWORK_PATTERNS = [/\bcurl\b/i, /\bwget\b/i, /\bnc\b/i, /\bssh\b/i, /\bscp\b/i, /\btelnet\b/i, /\bftp\b/i];

/**
 * Best-effort scan for path-like tokens that point outside the workspace.
 * This is a heuristic (it doesn't fully parse shell quoting/expansion) and
 * is defense-in-depth on top of workspaceGuard, not a replacement for it —
 * the dedicated file tools (read_file/write_file/etc.) are the real boundary.
 */
function findEscapingPathTokens(command, workspaceGuard) {
  const tokens = command.split(/\s+/);
  const offenders = [];
  for (const tok of tokens) {
    const clean = tok.replace(/^['"]|['"]$/g, "");
    if (clean.startsWith("-")) continue; // a flag, not a path
    if (!clean.startsWith("/") && !clean.startsWith("~") && !clean.includes("..")) continue;
    try {
      workspaceGuard.resolvePath(clean.startsWith("~") ? clean.replace(/^~/, ".") : clean);
    } catch {
      offenders.push(clean);
    }
  }
  return offenders;
}

export function classifyCommand(command, { workspaceGuard, allowNetworkCommands } = {}) {
  for (const { re, reason } of BLOCKED_PATTERNS) {
    if (re.test(command)) return { blocked: true, reason };
  }

  if (!allowNetworkCommands && NETWORK_PATTERNS.some((re) => re.test(command))) {
    return { blocked: true, reason: "network commands are disabled (set allowNetworkCommands: true to permit)" };
  }

  if (workspaceGuard) {
    const offenders = findEscapingPathTokens(command, workspaceGuard);
    if (offenders.length > 0) {
      return { blocked: true, reason: `references path(s) outside the workspace: ${offenders.join(", ")}` };
    }
  }

  for (const { re, reason } of CONFIRM_PATTERNS) {
    if (re.test(command)) return { blocked: false, needsConfirmation: true, reason };
  }

  return { blocked: false, needsConfirmation: false };
}
