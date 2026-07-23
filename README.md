# mini-coding-agent

`mini-coding-agent` is a local AI Coding Agent CLI. It runs inside a git repository, accepts natural-language coding tasks, uses controlled tools to inspect and edit the codebase, runs commands, records every step to local JSONL session files, and prints the final summary plus git diff.

The project is intentionally focused on the local CLI loop. There is no bundled backend service or web console in the current version.

## Documentation

Chinese project notes live under [`docs/zh-CN`](docs/zh-CN/README.md), including:

- architecture notes
- architecture evolution from earlier designs to the current runtime
- project status and scorecard
- resume/interview packaging notes
- demo script
- interview guide and interview Q&A
- test plan and self-check checklist
- AI study guide for this project

## What It Does

- Starts an interactive local coding-agent session with `mini-agent`.
- Keeps one active session in interactive mode, and resolves implicit demonstratives against the latest completed exchange instead of unrelated older topics.
- Runs one-shot tasks with `mini-agent run "..."`.
- Routes normal questions and explicit snippet-only requests to direct-answer mode before using the repository-editing agent loop.
- Routes current external-information questions to web-answer mode instead of treating them as code tasks.
- Calls real OpenAI-compatible chat completions APIs.
- Answers general non-code questions in direct-answer mode.
- Creates or updates repository files by default for code-generation tasks, instead of only printing code in chat.
- Treats explicit documentation creation as a repository task, enforces a successful patch, and suggests an existing docs-style Markdown location.
- Reuses the active session to resolve short repository follow-ups such as "写入一个文件里面" and can save the latest generated code into a real file.
- Searches public web results through the controlled `web_search` tool when current external information is needed.
- Fetches bounded public HTTP(S) pages through the `fetch_url` tool.
- Answers web-capability questions locally: the CLI has controlled, on-demand web tools, not a browser-style always-on session or manual web-search switch.
- Keeps product capability facts in one registry, classifies capability questions from composable semantic signals instead of complete-sentence cases, and corrects model answers that falsely deny registered web or repository-write capabilities.
- Maintains governed Memory v2 records with semantic kinds/scopes, evidence-backed automatic writes, TTL, supersession, secret redaction, and pluggable embeddings.
- Provides repository-local document RAG for Markdown/TXT with safe ingestion, line-aware chunking, incremental source replacement, hybrid retrieval, metadata filters, grounded citations, insufficient-evidence refusal, and offline evaluation metrics.
- Caches remote embeddings by provider/vector-space and text hash with bounded in-process LRU, single-flight deduplication, and repository-local atomic persistence without storing source text.
- Supports explicit long-term-memory control with `memory remember`, `memory forget`, `memory stats`, `memory migrate`, `memory clear --yes`, `/remember`, and `/forget`; plans, web/direct answers, failed tasks, and Agent outcomes without a repository diff are not auto-promoted.
- Discovers declarative `SKILL.md` files from `skills/<name>/SKILL.md` and `.mini-agent/skills/<name>/SKILL.md`, validates and selects relevant skills, and injects them into answer/task modes without allowing skills to bypass tool permissions. Ambiguous direct-answer follow-ups suppress fresh Skill selection so an older workflow cannot become the referent.
- Provides a hard read-only plan mode through `mini-agent plan`, `/plan`, `/plan off`, and `/execute`; plan mode exposes only read-only tools and blocks patches and commands at runtime.
- Connects configured MCP servers over stdio or Streamable HTTP, discovers remote tools, namespaces them, maps permissions, forwards `tools/call`, and closes server lifecycles.
- Provides AgentBench v1 with versioned scripted/real-model datasets, pass@1/pass@k, quality gates, baseline regression checks, token/cache/latency/context metrics, and failure classification.
- Persists compact versioned Agent checkpoints and restores interrupted Working Set, side-effect, verification, and in-flight-action state without replaying raw patches or command output.
- Enforces a deterministic task-completion contract: source/configuration changes require a successful verification after the latest patch, while documentation-only changes do not pay that cost.
- Supports opt-in controlled multi-agent investigation: one parent is the sole writer, while two or three isolated children inspect independent repository concerns in parallel using only local closed-world read-only tools.
- Grades verification evidence as `DIFF_HYGIENE < SYNTAX < STATIC < TEST`, checks file scope, and requires stronger evidence for compiled source, configuration, bug-fix, regression, refactor, and test changes.
- Classifies common pasted runtime errors locally before asking the model, including wrong working directory, missing commands, occupied ports, refused connections, and permission errors.
- Searches code with `rg`.
- Reads files with repository path safety checks and refuses internal metadata paths such as `.git` and `.mini-agent`.
- Reads large source files through token-bounded pagination, tracks merged line-range coverage with a source hash, and blocks a successful full-file review until the primary target is covered from line 1 through EOF.
- Normalizes code-search result paths to POSIX-style repository paths for stable follow-up tool calls.
- Applies unified diff patches after `git apply --check`, with `core.autocrlf=false` to avoid machine-specific Git line-ending behavior.
- Executes structured commands with shell disabled by default.
- Requires additional approval and dangerous-command checks for explicit shell or shell-like commands.
- Records messages, tool calls, command results, patch events, file changes, and final diffs in `.mini-agent/`.
- Exposes debug commands for tools, commands, patches, git, sessions, and config.

## Requirements

- Node.js 20+
- npm or pnpm
- git
- ripgrep (`rg`)
- An OpenAI-compatible model endpoint

Install ripgrep on Ubuntu:

```bash
sudo apt install ripgrep
```

## Install

From this project directory:

```bash
npm install
npm run build
npm run test:regression
npm link
```

After `npm link`, the CLI command is available as:

```bash
mini-agent --help
```

If you do not want to install the global link, run it directly:

```bash
node dist/cli/index.js --help
```

## LLM Configuration

Create a local config file:

```bash
cp mini-agent.config.example.json mini-agent.config.json
```

Edit `mini-agent.config.json`:

```json
{
  "version": 1,
  "llm": {
    "mode": "real",
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "your-api-key",
    "model": "your-model",
    "temperature": 0.2,
    "maxTokens": 4096,
    "timeoutMs": 60000
  },
  "rag": {
    "topK": 5,
    "minScore": 0.12,
    "maxContextChars": 6000
  },
  "multiAgent": {
    "mode": "off",
    "maxConcurrency": 2,
    "maxBatchesPerRun": 1,
    "maxTasksPerRun": 3
  }
}
```

`mini-agent.config.json` is ignored by git, so your API key is not committed.

Optional MCP servers are configured under `mcp.servers`. A server uses either `command` + `args` for stdio or `url` for Streamable HTTP. Remote tools are registered as `<server>__<tool>`; `defaultPermission` and `toolPermissions` map untrusted remote capabilities into the existing `SAFE` / `REVIEW` / `DANGEROUS` permission model. See `mini-agent.config.example.json` for a disabled filesystem example.

You can also create or update it through the CLI:

```bash
mini-agent config init \
  --base-url "https://api.openai.com/v1" \
  --api-key "your-api-key" \
  --model "your-model"
```

Show config with secrets redacted:

```bash
mini-agent config show
```

## CLI Commands

```bash
mini-agent
mini-agent run "inspect this repository and summarize the main modules"
mini-agent review src/tools/WebSearchTool.ts
mini-agent resume <sessionId>
mini-agent sessions
mini-agent session summary <sessionId>
mini-agent memory index
mini-agent memory search "之前数据流中位数怎么实现的"
mini-agent memory list
mini-agent memory remember "Use npm test before pushing"
mini-agent memory stats
mini-agent memory migrate
mini-agent rag ingest README.md docs --tag project
mini-agent rag search "how does MCP permission mapping work?" --top-k 3
mini-agent rag stats
mini-agent rag eval docs/rag-eval.example.json
mini-agent bench run benchmarks/agent-bench-v1.json
mini-agent bench run benchmarks/agent-bench-v1.json --baseline benchmarks/baselines/core-v1.json
mini-agent bench run benchmarks/agent-bench-v1.json --mode real --repetitions 3 --output .mini-agent/benchmarks/real.json
mini-agent skill list
mini-agent skill init testing --description "Use for Vitest regression work"
mini-agent plan "refactor the CLI router"
mini-agent status
mini-agent diff
mini-agent tool list
mini-agent tool manifest
mini-agent tool run read_file '{"path":"README.md"}'
mini-agent tool run knowledge_search '{"query":"how is RAG evaluated?","topK":3}'
mini-agent mcp tools
mini-agent mcp status
mini-agent mcp call filesystem__read_file '{"path":"README.md"}'
mini-agent tool run fetch_url '{"url":"https://example.com"}'
mini-agent command run "echo hello"
mini-agent patch preview < patch.diff
```

Common options for `run`:

```bash
mini-agent run "fix the failing test" --max-steps 20
mini-agent run "inspect repository" --model "your-model"
mini-agent run "inspect repository" --base-url "https://api.example.com/v1"
mini-agent run "inspect repository" --event-stream
mini-agent run "fix the failing test" --verbose
mini-agent run "inspect repository" --trace
mini-agent run "explain the current design trade-offs" --agent-loop
mini-agent run "inspect the context and memory architecture" --agents 3
```

`--event-stream` prints machine-readable `MINI_AGENT_EVENT {...}` lines while still writing normal local session/event files.
`--verbose` expands tool inputs, context compaction, cache, token, and timing telemetry. `--trace` additionally prints redacted AgentDecision payloads and per-section context allocation.
`--agent-loop` keeps the routed task capabilities unchanged but forces a direct response to use the iterative decision protocol instead of the single-shot optimization.
`--agents 2..3` opts repository tasks into one bounded read-only delegation batch. `--agents 1` disables delegation. It is off by default; config can enable it with `multiAgent.mode: "auto"`.

## Unified Agent Runtime

Every request now runs through one `AgentLoop`. `TaskRouter` no longer selects four independent executors; it provides a semantic hint that is compiled into an `AgentTaskContract`. The contract controls tools, write/command permissions, evidence thresholds, output shape, and step budget:

- `DIRECT_RESPONSE`: one AgentLoop step, no tools, no repository access, output `[answer]`.
- `WEB_RESEARCH`: iterative AgentLoop with only `web_search` and `fetch_url`; live claims require fetched pages from two independent domains and citations must use URLs gathered in the current run. Output `[answer]`.
- `REPOSITORY_INVESTIGATION`: the shared read-only profile for both code review and repository analysis. Their only architectural difference is the output contract (`CODE_REVIEW` or `REPOSITORY_ANALYSIS`).
- `REPOSITORY_TASK`: repository reading, patches, controlled commands, verification, optional RAG/MCP, and bounded read-only delegation.
- `KNOWLEDGE_QUERY`: only the indexed `knowledge_search` capability, with exact file-and-line citation postconditions.
- `PLAN`: a persisted read-only operating mode layered over the relevant task contract. Patches and commands are blocked again at execution time.

Legacy labels such as `DIRECT_ANSWER`, `WEB_ANSWER`, and `CODE_REVIEW` remain in session/change-log metadata for compatibility; `executionEngine: AGENT_LOOP` records the actual runtime.

## Runtime timeline and telemetry

The CLI renders every AgentLoop run as an ordered terminal timeline. The same versioned `AgentRuntimeEvent` stream is available through `--event-stream` for logs and automation. It covers context construction, auditable decision summaries, tool start/result, patches, live command output, guardrail rejections, LLM calls, diffs, and final results.

LLM telemetry distinguishes prompt, completion, reasoning, prompt-cache read, and provider-reported cache-write tokens. Missing provider fields are shown as `unreported`, never inferred as a cache miss. Direct responses report the separately supplied conversation message count and estimated content tokens; repository and web tasks report session-memory records beneath the context-budget line. Context traces report selected, skipped, and truncated sections plus structured session-memory compaction. Remote embedding telemetry reports memory hits, disk hits, misses, writes, and coalesced requests.

Task-contract capabilities are per-request least-privilege boundaries, not a global product capability list. Product meta-questions such as “what can you do?”, “can you access the web?”, “can you write files?”, or “why did you say you could not?” are answered deterministically from local product/session facts. They do not trigger web research merely because their text mentions networking.

The timeline deliberately does not expose hidden model chain-of-thought. It shows the explicit plan, structured decisions, evidence, tool inputs/results, and deterministic guardrail reasons instead. Machine-readable events and trace payloads are redacted before being printed.

Repository-writing tasks finish with a compact `Changes` card instead of dumping unified diff text into the execution timeline. In an interactive TTY, click the card or press Enter at the changes action to open the built-in full-screen terminal diff viewer; use arrow keys to select a file, PageUp/PageDown or the mouse wheel to scroll, and `q`/Escape to return. Non-interactive runs print `mini-agent diff --session <id>` as the fallback. Task diffs come from isolated before/after working-tree snapshots, so they include new untracked code or documentation files without mixing in changes that already existed before the task.

Declarative skills use a small `SKILL.md` format:

```markdown
---
name: testing
description: Use for Vitest regression work
triggers: vitest, regression
---

Run targeted tests before the full suite.
```

Versioned skills live in `skills/<name>/SKILL.md`; machine-local skills live in `.mini-agent/skills/<name>/SKILL.md`. Mention `$testing` to select one explicitly, or let deterministic trigger matching select up to three relevant skills.

When the user asks to write code but does not provide a target path, the agent now prefers the repository-editing loop and receives task-specific file-placement guidance from local project signals such as `src/`, `public/`, `src/main/java/`, `tests/`, build files, and detected languages.

For repository analysis requests such as "analyze this repository" or "总结当前项目", the investigation contract exposes only repository-read tools and refuses a successful final answer until at least one relevant file has been read. Code review uses the same runtime profile with review-specific output instructions.

In interactive mode, web-research follow-up questions reuse the active session context. The current question is resolved against the previous exchange before the same AgentLoop selects search queries and source URLs. Local guardrails reject completion without the contract's search, fetch, independent-domain, and citation evidence.

For example, after asking about World Cup scores, a follow-up like "Japan's recent results" is searched as a World Cup-scoped question instead of a broad national-team query.

Very short follow-up prompts such as `葡萄牙呢`, `那这个呢`, or `and Portugal?` also reuse the active session. When the previous question makes the omitted predicate clear, the CLI rewrites the follow-up into a fuller question before routing and answering. Referential prompts such as `这个难度如何` are given only the latest completed exchange; older topics, Agent decision traces, long-term retrieval, and fresh Skill selection are excluded from that turn.

Time-sensitive popularity and match-result questions such as `YouTube现在最热门的视频是什么` or `法国队vs西班牙队，谁赢了` route directly to web-answer mode. Natural retries such as `你用搜一下啊`, `嗯切换吧`, or `联网查吧` also enter that mode and reuse the previous question instead of searching for the retry phrase itself.

Short repository follow-ups can also reuse the active session. For example, if the previous turn returned a code snippet and the next turn says `写入一个文件里面`, `写进去`, or `保存一下`, the CLI rewrites that into an explicit repository task, carries over the latest code block, and lets `AGENT_LOOP` create the file instead of asking the user to repeat the code. Short coding follow-ups after an edit task, such as `数据流的中位数呢`, keep the repository-editing mode instead of falling back to chat-only output.

File-write confirmation is answered from local session records. If the user asks `你写入了嘛？`, the CLI checks whether a `FILE_CHANGE` record was created after the previous request. It will not ask the model to guess, and it will not claim a file was written when no write record exists.

Artifact-location follow-ups are grounded the same way. After a task creates or modifies files, prompts such as `在哪里`, `放哪了`, `哪个文件`, or `怎么打开` are resolved from the immediately preceding turn's `FILE_CHANGE` records. The CLI returns repository-safe absolute paths, emits a `[follow-up]` timeline entry, and skips the LLM instead of asking it to guess the referent.

## Regression Suite

The project keeps a focused conversation-level regression suite for the user-visible failures that are easiest to reintroduce:

- explicit snippet requests must stay chat-only
- implementation requests must create or update files
- short follow-ups such as `写入一个文件里面` or `写进去` must reuse the latest generated code
- short algorithm follow-ups after an edit task must remain in repository-editing mode
- write-confirmation questions such as `你写入了嘛？` must be grounded in session `FILE_CHANGE` records
- artifact-location questions such as `在哪里` must return the latest turn's changed paths without an LLM call
- package-manager `ENOENT package.json` errors must be diagnosed as wrong working-directory problems when the pasted path is outside the active repo
- omitted-predicate follow-ups such as `葡萄牙呢` must reuse session context
- repository analysis must read real repository evidence before summarizing
- repository metadata such as `.git` and `.mini-agent` must not be exposed through read/search tools

Run it with:

```bash
npm run test:regression
```

For a quick pre-demo gate:

```bash
npm run verify:regression
```

Current normal-environment gate: 39 Vitest files and 288 tests, along with TypeScript type checking and unused-symbol checks.

Interactive slash commands:

```text
/help         Show slash command help.
/new          Start a new conversation session in the same repo.
/review <p>   Run a focused code review for one repository file.
/resume <id>  Switch to a previous session without restarting the CLI.
/pause        Pause the active session and exit; resume it later.
/session      Show current session metadata.
/summary      Show a compact summary of the current session.
/sessions     List local sessions with recent message/summary hints.
/history [n]  Show recent session records.
/events [n]   Show recent event records.
/logs [n]     Show recent runtime logs.
/changes [n]  Show recent task change-log entries.
/compact      Write a compact local memory record for the active session.
/status       Show current agent/session status and tracked LLM usage.
/repo         Show a repository state summary.
/diff         Open the latest task changes in the terminal diff viewer.
/clear        Clear the terminal.
/exit         Finish the active interactive session and exit.
```

Inside interactive mode, pressing `Tab` now completes slash commands such as `/sta` -> `/status`. If a prefix matches multiple commands, repeated `Tab` shows the available candidates.

Use `/pause` when you are leaving temporarily and want the session shown as `PAUSED`; use `/exit` when the session is finished. A paused session can be reopened with `mini-agent resume <sessionId>` or interactive `/resume <sessionId>`.

Interactive `/status` is session-oriented. It shows the current session id, last mode, last user message, latest summary, configured model, and locally tracked token usage when the provider returns usage metrics. The remaining context window is reported as unavailable because most OpenAI-compatible APIs do not expose it directly.

Use `/repo` for the repository summary. Outside interactive mode, `mini-agent status` and `mini-agent repo` both print the repository state summary, while `mini-agent session status <sessionId>` prints the JSON version of session status.

## Typical Local Workflow

Run inside any git repository:

```bash
cd /path/to/your/repo
mini-agent run "find the README and explain how this project is structured"
```

For a standalone question or an explicit snippet-only request, `run` answers directly without editing files:

```bash
mini-agent run "give me a C++ code snippet for two sum"
mini-agent run "非登记收款人是什么意思"
```

For current external information, the agent can use controlled web tools:

```bash
mini-agent run "联网搜索一下 TypeScript 最新版本信息"
```

This path prints `[tool] web_search`, may print `[tool] fetch_url`, and then prints a normal `[answer]` instead of a terse repository-task `[summary]`.

The web tools are bounded public-page tools, not a dedicated live-score API. Dynamic pages, anti-bot pages, or JavaScript-rendered scoreboards may fail to provide exact real-time data; in that case the answer should say what could not be verified instead of guessing.

In interactive mode, follow-up questions reuse the same session until `/new` or `/exit`:

```text
mini-agent
> 给我一个两数之和的 C++ 代码片段，不要改文件
> 你还记得刚才让我写什么了吗
```

To continue a previous transcript:

```bash
mini-agent resume <sessionId>
```

For a real coding task:

```bash
mini-agent run "add validation for uploaded file extensions and update tests"
mini-agent run "write a C++ two-sum example"
```

At the end, inspect changes:

```bash
git status --short
mini-agent status
mini-agent diff
```

## Tool System

All tools implement a shared interface:

- `name`
- `description`
- `inputSchema`
- `permissionLevel`
- `execute(input, context)`

Available tools:

| Tool | Permission | Purpose |
| --- | --- | --- |
| `list_files` | `SAFE` | List repository files and directories. |
| `read_file` | `SAFE` | Read a text file with line limits. |
| `search_code` | `SAFE` | Search with ripgrep. |
| `git_status` | `SAFE` | Run `git status --short`. |
| `git_diff` | `SAFE` | Run `git diff` or `git diff --cached`. |
| `web_search` | `SAFE` | Search public web results with lightweight provider fallback. |
| `fetch_url` | `REVIEW` | Fetch bounded text from a public HTTP(S) URL after permission review. |
| `apply_patch` | `REVIEW` | Check and apply a unified diff patch. |

Command execution is handled by the command subsystem rather than the tool registry:

```bash
mini-agent command run "echo hello"
```

## Safety Model

The current MVP uses local guardrails:

- File paths are resolved under the current repository root.
- `../` and absolute-path escapes are rejected.
- Binary files are rejected by `read_file`.
- `read_file` has line limits.
- `search_code` limits result count.
- `fetch_url` requires review permission, blocks localhost/private-network targets, validates DNS and each redirect hop, limits timeout/download size, and returns only readable text-like content.
- `web_search` returns bounded public result titles, URLs, and snippets; it currently tries DuckDuckGo HTML first and falls back to DuckDuckGo Lite when needed. The `WEB_RESEARCH` contract lets the AgentLoop choose which results to fetch, but it does not grant arbitrary browser control.
- If a web `FINAL` lacks the required fetched sources, independent domains, or a URL from the gathered evidence, local guardrails reject that decision and return the violation to the same AgentLoop. Product questions about its name, configured model identifier, unified runtime, or web capability are answered from deterministic local product knowledge instead of model improvisation.
- Patch application runs `git apply --check` before `git apply`.
- Commands execute as structured `executable + args` processes with shell disabled by default, plus timeout and output truncation.
- Explicit shell or shell-like commands require additional approval; dangerous command patterns such as `rm -rf /`, `sudo`, `mkfs`, `shutdown`, `reboot`, and `chmod 777 /` are blocked.

This is a local developer tool, not a production sandbox.

## Session Files

Each repository gets a local `.mini-agent/` directory:

```text
.mini-agent/
  config.json
  change-log.jsonl
  sessions/
    <sessionId>.jsonl
  events/
    <sessionId>.jsonl
  logs/
    YYYY-MM-DD.jsonl
  memory/
    index.jsonl
```

Session records include:

- user and assistant messages
- tool calls and results
- command executions
- patch events
- file-change summaries
- test pass/fail markers
- final git diff
- compact Agent checkpoints for interrupted-task recovery

The current session records are used as short-term memory. Before each LLM call, `mini-agent` injects recent user messages, assistant messages, task summaries, command results, tool results, and errors into the prompt.

Agent execution recovery is separate from conversational memory. During AgentLoop execution, `AGENT_CHECKPOINT` records persist a bounded Working Set, successful side effects, latest verification/test/RAG outcome, whether verification happened after the latest patch, total steps, and any in-flight action. Resuming a session restores only the latest `RUNNING` or `WAITING_USER` checkpoint in the same operating mode. `FINISHED`/`FAILED` checkpoints and checkpoints followed by a task summary are terminal, so a completed task cannot leak execution state into the next task. If interruption happened during a tool, patch, or command, the restored task enters recovery and inspects current repository state before retrying.

Before every model decision, Context Engine v2 injects a task-completion contract derived from the user goal and the files actually changed. `FINAL success=true` is checked locally rather than trusted: required repository changes must exist; indexed-knowledge answers must preserve grounded evidence; requested verification must pass; and source/configuration changes must have sufficiently strong, relevant evidence after the most recent successful patch. Verification is ordered as `DIFF_HYGIENE < SYNTAX < STATIC < TEST`; a weak diff check cannot satisfy a TypeScript change, a file-scoped check cannot verify an unrelated file, and bug-fix/regression/refactor tasks require tests. A passing command that predates a later patch is stale and cannot satisfy completion.

Long-term memory is stored separately in `.mini-agent/memory/index.jsonl`. Automatic writes accept only successful AgentLoop outcomes with a non-empty repository diff, plus explicit compaction records; plans, web/direct answers, repository analysis, failures, and unsupported summaries are rejected by `MemoryWritePolicy`. Records carry a semantic kind, scope, status, evidence references, confidence, provider identity, and vector. `MemoryReadPolicy` selects allowed kinds/scopes per consumer before retrieval, reranking, and evidence selection. Ordinary direct/web answers do not query historical memory; explicit recall can retrieve outcomes, while normal repository work receives stable preferences, conventions, and architecture decisions only.

The default provider remains a dependency-free deterministic local embedding. Set `MINI_AGENT_EMBEDDING_MODEL`, `MINI_AGENT_EMBEDDING_BASE_URL`, and `MINI_AGENT_EMBEDDING_API_KEY` to use a real OpenAI-compatible embedding endpoint. Remote embedding results are content-addressed under `.mini-agent/cache/embeddings/v1/`; cache records contain vectors and hashes, not the original text. LLM KV/prompt caching remains provider-managed, while the CLI records returned cached-token metrics. Memory JSONL mutations use a cross-process lock and atomic replacement. Changing provider/schema does not silently rebuild entries during search; run `mini-agent memory migrate` explicitly.

Runtime logs and task change logs serve different purposes:

- `logs/YYYY-MM-DD.jsonl` records operational events such as task start/end, tool debugging, command execution, and CLI errors.
- `change-log.jsonl` records session id, task text, compatibility mode, success/failure, summary, changed files, diff stat, test outcomes, and unified-runtime metadata (`executionEngine`, `taskKind`, and `outputKind`).

List sessions:

```bash
mini-agent sessions
```

Inspect one session:

```bash
mini-agent session show <sessionId>
mini-agent session events <sessionId>
mini-agent memory index <sessionId>
mini-agent memory search "search query"
mini-agent logs
mini-agent changes
mini-agent doctor
```

## Development

Run the deterministic AgentBench quality gate:

```bash
npm run bench -- --baseline benchmarks/baselines/core-v1.json
```

The versioned core dataset covers repository edits, document creation, patch-conflict recovery, premature-success guardrails, test verification, and read-only planning. Scripted mode evaluates the execution engine deterministically. Real mode ignores scripted decisions and samples the configured OpenAI-compatible model; use multiple repetitions to measure reliability rather than a single lucky run. Reports include pass@1, pass@k, run pass rate, tool-choice accuracy, steps, LLM calls, duration, token/cache usage, context truncation, test outcomes, and categorized failures. A failing dataset threshold or baseline comparison sets a non-zero CLI exit code.

```bash
npm install
npm run build
npm test
npm run verify
```

Debug examples:

```bash
mini-agent tool list
mini-agent tool run list_files '{"path":"."}'
mini-agent tool run search_code '{"query":"AgentLoop","path":"src"}'
mini-agent tool run fetch_url '{"url":"https://example.com"}'
mini-agent tool run git_status '{}'
mini-agent tool run git_diff '{}'
mini-agent command run "echo hello"
mini-agent doctor
mini-agent logs
mini-agent changes
```

## Current MVP Scope

Included:

- TypeScript CLI
- real OpenAI-compatible LLM client
- task router for direct answers vs repository edits
- agent loop
- opt-in parent/child multi-agent investigation with a single-writer boundary and bounded parallel read-only children
- phase-aware Context Engine v2 with Working Set, token budgeting, structured session compaction, and context traces
- tool registry
- path-safe file tools
- git status and diff tools
- intelligent repository state summaries
- controlled web search and URL fetch tools
- patch manager
- command runner
- permission manager
- local JSONL sessions and events
- runtime logs and task change logs
- automated Vitest coverage

Not included:

- bundled web UI
- bundled Java backend
- remote PR creation
- production sandboxing
- multi-user server mode

## Roadmap

Next useful steps:

1. Improve the real-model prompting and decision parser.
2. Add a dry-run mode that previews intended tools and patches.
3. Add richer test-command detection per repository type.
4. Improve session replay and terminal rendering.
5. Expand MCP compatibility for server-initiated requests, resources, prompts, and authentication profiles.
