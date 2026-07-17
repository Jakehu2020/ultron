# ultron

A multi-agent coding system with a queen-worker architecture, web interface on `localhost:2048`, and a single-agent CLI mode. Talks to your local [modelrelay](https://github.com/ellipticmarketing/modelrelay) router at `http://127.0.0.1:7352/v1`.

Zero runtime dependencies (Node 18+ built-ins only, except marked.js CDN for markdown rendering).

## Quick start

### Web interface (queen-worker)

```bash
node src/orchestrator/index.js --mode queen
```

Opens `http://localhost:2048` — the queen explores your codebase and dispatches workers to get tasks done.

### CLI (single-agent)

```bash
node src/single-agent/index.js --workspace /workspace
```

Type a message at the `>` prompt; `exit` / `quit` / `:q` to leave.

## Architecture

```
src/
  single-agent/               # standalone agent
    config.js                   # merges defaults -> .ultron.json -> env -> CLI flags
    index.js                    # CLI entry point
    llm/
      client.js                 # POSTs to modelrelay's /v1/chat/completions, model fallback
    safety/
      workspaceGuard.js         # path containment enforcement
      commandGuard.js           # classifies shell commands: block / confirm / allow
      limits.js                 # every numeric cap lives here
    tools/
      fs/{readFile,listDir,writeFile,editFile,searchFiles}.js
      terminal/runCommand.js
      index.js                  # registry + OpenAI schema converter
    agent/
      systemPrompt.js           # short system prompt
      tokenBudget.js            # trims conversation history to a token cap
      loop.js                   # the agent loop (model call <-> tool calls)
    utils/
      logger.js

  orchestrator/               # multi-agent layer
    index.js                    # orchestrator entry point (--mode queen|linear)
    server.js                   # HTTP server on port 2048, SSE streaming
    queenWorker.js              # queen-worker orchestrator with dispatch/collect
    queenPrompt.js              # queen system prompt
    agentFactory.js             # builds scoped agents per role (tool-subset + guard)
    coordinator.js              # linear pipeline coordinator (plan->code->review)
    memoryBus.js                # shared blackboard (namespaced role.key values)
    public/
      index.html                # web interface (chat + worker panel + settings)

tests/
  queenWorker.test.js

example/
  run.js                        # single-agent test runner
```

## Modes

### Queen-worker (default)

The queen is the strategic layer: it explores the codebase, forms a plan, and dispatches specialized workers:

- **planner** — Explores the codebase and creates detailed implementation plans. Read-only.
- **coder** — Implements changes (creates, edits, deletes files; runs commands). Full access.
- **reviewer** — Reads files and reviews work. Reports issues, missing steps, or risks. Read-only.

Workers can be dispatched synchronously (blocks until result) or asynchronously (fire-and-forget, collect later).

### Linear pipeline

A fixed plan -> code -> review pipeline via `coordinator.js`.

## Web interface

- **Chat** — Send messages to the queen, see responses with markdown rendering
- **Worker panel** — Live view of dispatched workers, their status, and results
- **Activity stream** — Real-time tool calls, results, and thinking shown inline
- **Settings** (gear icon) — Configure per-worker tool permissions (allow/deny/prompt), queen agent requirements, and dark/light mode
- **Confirmation prompts** — When a worker tool is set to "prompt", a modal asks for approval before execution

## Safety model

**Filesystem:** every tool resolves paths through `workspaceGuard.resolvePath()`. It rejects `..` escapes, absolute paths outside the root, and symlinks whose real target lands outside the root.

**Terminal:** `run_command` goes through `commandGuard.classifyCommand()`:
- **Blocked:** `rm -rf /`, fork bombs, `mkfs`, `sudo`, `shutdown`, piping `curl`/`wget` into a shell, anything referencing a path outside the workspace.
- **Requires confirmation:** `rm`, `mv`, `git push --force`, `git reset --hard`, `npm publish`, `chmod`, `kill`/`pkill`, and any `>` redirect.
- **Network commands** (`curl`, `wget`, `ssh`, `scp`) are blocked unless `allowNetworkCommands: true` is set.
- Everything else runs with: cwd locked to the workspace, a timeout (default 30s, hard cap 120s), truncated stdout/stderr (20KB each), and a minimal environment.

**Worker tool permissions** (web UI settings):
- Each worker role (planner, coder, reviewer) can have tools set to **allow**, **deny**, or **prompt** (requires user approval via web UI).

## Configuration

### Config file

Create `.ultron.json` in your workspace root:

```json
{
  "model": "hy3",
  "fallbackModels": ["nemotron-3-ultra", "north-mini-code", "mimo-v2.5"],
  "workspaceRoot": "/workspace",
  "allowNetworkCommands": false
}
```

### Environment variables

```bash
export ULTRON_MODEL=hy3
export ULTRON_BASE_URL=http://127.0.0.1:7352/v1
export ULTRON_API_KEY=your-key
```

### CLI flags

```bash
node src/single-agent/index.js --workspace /workspace --model hy3 --base-url http://127.0.0.1:7352/v1
```

## Token minimization

- **`read_file`** takes `start_line`/`end_line` and caps output at 300 lines by default.
- **`edit_file`** is a unique find/replace (like `str_replace`), so a one-line fix costs a few dozen tokens.
- **`list_dir`** is non-recursive by default, skips `node_modules`/`.git`/`dist`/build noise, caps at 200 entries.
- **`search_files`** returns `file:line:snippet` (capped at 300 chars), max 50 matches.
- **`run_command`** output truncated at 20KB per stream.
- **`tokenBudget.trimHistory()`** keeps the system message plus as much recent history as fits a token budget (default 1M tokens), dropping the oldest turns.

## License

MIT
