# codewrapper

A minimal, modular coding-agent harness that talks to your local [modelrelay](https://github.com/ellipticmarketing/modelrelay) router at `http://127.0.0.1:7352/v1`. It gives a model the ability to read, search, and edit a codebase and run shell commands — all locked to one workspace directory — while trying to spend as few tokens per turn as possible.

Zero runtime dependencies (Node 18+ built-ins only: `fetch`, `child_process`, `fs`).

## Quick start

```bash
cd your-project
node /path/to/codewrapper/src/index.js --workspace .
```

By default it talks to `http://127.0.0.1:7352/v1` with model `auto-fastest`. Override via flags, env vars, or a config file:

```bash
node src/index.js --workspace ~/code/myapp --model kimi-k2.5 --base-url http://127.0.0.1:7352/v1
```

```bash
cp .env.example .env   # then export the vars, or set them in your shell
```

```bash
cp .codewrapper.example.json .codewrapper.json   # edit, then run from that directory
```

## Architecture

```
src/
  config.js              # merges defaults -> .codewrapper.json -> env -> CLI flags
  llm/client.js           # POSTs to modelrelay's /v1/chat/completions
  safety/
    workspaceGuard.js      # the ONLY place path containment is decided
    commandGuard.js         # classifies shell commands: block / confirm / allow
    limits.js               # every numeric cap lives here
  tools/
    fs/{readFile,listDir,writeFile,editFile,searchFiles}.js
    terminal/runCommand.js
    index.js                # registry: builds the tool array, exports OpenAI schemas
  agent/
    systemPrompt.js          # short, since tool JSON schemas carry the detail
    tokenBudget.js            # trims conversation history to a token cap
    loop.js                    # the actual agent loop (model call <-> tool calls)
  utils/logger.js
  index.js                    # CLI: wires everything together, runs a REPL
```

Every module is small and single-purpose on purpose — see "Becoming an orchestrator" below.

## Safety model

**Filesystem:** every tool resolves paths through `workspaceGuard.resolvePath()`. It rejects `..` escapes, absolute paths outside the root, and symlinks whose real target lands outside the root. There's no other path into the filesystem tools.

**Terminal:** `run_command` is not a raw shell. Every command string goes through `commandGuard.classifyCommand()`:

- **Blocked outright, no matter what:** `rm -rf /` or `~`, fork bombs, `mkfs`, raw disk writes, `sudo`, `shutdown`/`reboot`, piping `curl`/`wget` into a shell, `chmod -R 777 /`, overwriting `/etc/*`, and anything referencing a path outside the workspace (heuristic token scan).
- **Requires human confirmation:** `rm`, `mv`, `git push --force`, `git reset --hard`, `git clean -f`, `npm publish`, `chmod`, `kill`/`pkill`, `truncate`, and any `>` redirect.
- **Network commands** (`curl`, `wget`, `ssh`, `scp`, `nc`, `ftp`, `telnet`) are blocked unless `allowNetworkCommands: true` is set in config — off by default since these models are meant to work on local code, not reach out to the internet.
- Everything else runs with: cwd locked to the workspace, a timeout (default 30s, hard cap 120s), truncated stdout/stderr (20KB each), and a minimal environment (`PATH`/`HOME`/`LANG` only — your shell's other env vars, including any secrets, are **not** inherited by the child process).

**Confirmation** is a callback you inject (`confirm(async ({type, command, reason}) => boolean)`). The CLI wires it to a `y/N` prompt. If you don't supply one, confirm-gated actions are denied by default — fail closed, not open.

**Threat model / honest limits:** this is defense-in-depth for a cooperative-but-imperfect model, not a hard sandbox against a malicious one. The command-string path scanner is a heuristic (it doesn't parse shell quoting/substitution/pipes fully), and `run_command` still runs with your OS-level user permissions inside the workspace directory — it can still, say, fill the disk with a loop, or run a compiler that does something unexpected. If you need real isolation, run this inside a container or VM scoped to the workspace directory.

## Token-minimization strategy

- **`read_file`** takes `start_line`/`end_line` and caps output at 300 lines by default — the model pages through large files instead of ingesting them whole.
- **`edit_file`** is a unique find/replace (like `str_replace`), so a one-line fix costs a few dozen tokens instead of the whole file being retransmitted. The system prompt explicitly tells the model to prefer this over `write_file`.
- **`list_dir`** is non-recursive by default, skips `node_modules`/`.git`/`dist`/build noise automatically, and caps at 200 entries.
- **`search_files`** returns `file:line:snippet` (snippet capped at 300 chars) instead of full file contents, capped at 50 matches.
- **`run_command`** output is truncated at 20KB per stream.
- **`tokenBudget.trimHistory()`** keeps the system message plus as much recent history as fits a token budget (default ~6000 tokens), dropping the oldest turns and leaving a one-line marker rather than silently growing every request forever.
- The **system prompt is short** (a few sentences) — the tool JSON schemas carry the operational detail, since those are only sent once per request in a structured form the model already has to parse.

None of this is exact (`estimateTokens` is a `chars/4` heuristic, not a real tokenizer) — it's meant to keep steady-state usage low, not to hit an exact budget.

## Becoming an orchestration system

The pieces were kept decoupled specifically for this:

- **`Agent`** (`agent/loop.js`) holds no global state — it's `{config, llmClient, tools, systemPrompt}` in, a `run()` method out. Instantiate several, each with a different model (route different agents to different modelrelay groups, e.g. one on `kimi-k2.5` for planning and one on `glm4.7` for implementation), different system prompt, and a different tool subset.
- **`createToolRegistry()`** (`tools/index.js`) is the place to hand out restricted tool sets — e.g. a read-only "reviewer" agent that only gets `read_file`/`search_files`/`list_dir`, or a "tester" agent that only gets `run_command` plus read access.
- **`workspaceGuard`** can be shared across agents (same workspace) or created per-agent (e.g. each agent gets a scoped subdirectory) since it's just bound to a root path.
- **`confirm`** is already a pluggable callback — an orchestrator can route confirmation requests to a policy engine instead of a human prompt (e.g. auto-approve for a "trusted" agent role, always deny for an "untrusted" one).
- **`onEvent`** in `Agent.run()` is the hook for a coordinator to observe/log/relay what one agent is doing — swap the CLI's console logger for a message bus, and you have inter-agent visibility.
- **`tokenBudget.trimHistory()`** is flagged in its own comments as the place to plug in real summarization once you have a "summarizer" role to call.

A natural next step: a `orchestrator.js` that owns N `Agent` instances, a task queue, and a routing policy for which agent handles which step — using this repo's `tools/`, `safety/`, and `llm/` modules unchanged.

## CLI

```
node src/index.js [--workspace <path>] [--model <id>] [--base-url <url>]
```

Type a message at the `>` prompt; `exit` / `quit` / `:q` to leave. Tool calls and results print inline; destructive actions pause for `y/N`.
