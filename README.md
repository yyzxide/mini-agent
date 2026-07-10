# mini-coding-agent

`mini-coding-agent` is a local AI Coding Agent CLI. It runs inside a git repository, accepts natural-language coding tasks, uses controlled tools to inspect and edit the codebase, runs commands, records every step to local JSONL session files, and prints the final summary plus git diff.

The project is intentionally focused on the local CLI loop. There is no bundled backend service or web console in the current version.

## Documentation

Chinese project notes live under [`docs/zh-CN`](docs/zh-CN/README.md), including:

- architecture notes
- project status and scorecard
- resume/interview packaging notes
- demo script
- interview guide and interview Q&A
- test plan and self-check checklist
- AI study guide for this project

## What It Does

- Starts an interactive local coding-agent session with `mini-agent`.
- Keeps one active session in interactive mode, so follow-up prompts can use recent conversation history.
- Runs one-shot tasks with `mini-agent run "..."`.
- Routes normal questions and explicit snippet-only requests to direct-answer mode before using the repository-editing agent loop.
- Routes current external-information questions to web-answer mode instead of treating them as code tasks.
- Calls real OpenAI-compatible chat completions APIs.
- Answers general non-code questions in direct-answer mode.
- Creates or updates repository files by default for code-generation tasks, instead of only printing code in chat.
- Reuses the active session to resolve short repository follow-ups such as "写入一个文件里面" and can save the latest generated code into a real file.
- Searches public web results through the controlled `web_search` tool when current external information is needed.
- Fetches bounded public HTTP(S) pages through the `fetch_url` tool.
- Answers web-capability questions locally: the CLI has controlled, on-demand web tools, not a browser-style always-on session or manual web-search switch.
- Maintains local long-term memory from task summaries and compaction records, then retrieves relevant memories into future prompts.
- Supports explicit long-term-memory control with `memory remember`, `memory forget`, `memory stats`, `memory clear --yes`, `/remember`, and `/forget`; failed task summaries are excluded and common secrets are redacted.
- Discovers declarative `SKILL.md` files from `skills/<name>/SKILL.md` and `.mini-agent/skills/<name>/SKILL.md`, validates and selects relevant skills, and injects them into every answer/task mode without allowing skills to bypass tool permissions.
- Provides a hard read-only plan mode through `mini-agent plan`, `/plan`, `/plan off`, and `/execute`; plan mode exposes only read-only tools and blocks patches and commands at runtime.
- Exposes tool capability annotations and MCP-style local tool descriptors for future external-tool integration.
- Provides a scripted Agent Harness for repeatable end-to-end agent-loop scenarios.
- Classifies common pasted runtime errors locally before asking the model, including wrong working directory, missing commands, occupied ports, refused connections, and permission errors.
- Searches code with `rg`.
- Reads files with repository path safety checks and refuses internal metadata paths such as `.git` and `.mini-agent`.
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
  }
}
```

`mini-agent.config.json` is ignored by git, so your API key is not committed.

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
mini-agent skill list
mini-agent skill init testing --description "Use for Vitest regression work"
mini-agent plan "refactor the CLI router"
mini-agent status
mini-agent diff
mini-agent tool list
mini-agent tool manifest
mini-agent tool run read_file '{"path":"README.md"}'
mini-agent mcp tools
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
mini-agent run "write a C++ two-sum example" --agent-loop
```

`--event-stream` prints machine-readable `MINI_AGENT_EVENT {...}` lines while still writing normal local session/event files.
`--agent-loop` forces the repository-editing loop when the router would otherwise answer directly.

## Answer Modes

`mini-agent` separates user input into four modes:

- `DIRECT_ANSWER`: normal chat, explanations, and explicit snippet-only requests. Output uses `[answer]`.
- `WEB_ANSWER`: current external-information questions. The CLI runs `web_search`, prefers higher-trust or official-looking sources first, fetches important public pages with `fetch_url`, keeps follow-up scope from the active session, and keeps fetching later-ranked sources when early pages fail. Output uses `[answer]`.
- `CODE_REVIEW`: file-focused bug inspection and code review. The CLI reads the target file, automatically loads a few related files referenced by local imports/includes, asks the model for structured findings, locally filters out findings whose quoted code does not match the primary file, then runs a second-pass verification step that can downgrade or drop overreaching findings. Output uses `[review]`.
- `AGENT_LOOP`: repository inspection or modification tasks. The model returns structured decisions for tools, patches, commands, and final summaries. Output uses `[plan]`, `[tool]`, `[patch]`, `[command]`, and `[summary]`.
- `PLAN`: a persisted read-only operating mode for repository planning. Only read-only tools are exposed; patches, commands, and non-read-only tool calls are blocked again at execution time. Use `mini-agent plan`, `/plan`, `/plan off`, and `/execute`.

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

For repository analysis requests such as "analyze this repository" or "总结当前项目", the CLI now forces an evidence-gathering pass before summarizing: it lists files, reads README/build files, loads representative source files, and only then asks the model for a grounded project analysis. This avoids shallow summaries based only on a tree snapshot.

In interactive mode, web-answer follow-up questions reuse the active session context. The CLI first asks the model for a small web research plan: standalone question, search queries, answer scope, source hints, and answer instructions. If that planner fails, a local fallback planner still carries recent context and adds source-focused queries for live sports scores, release notes, news, and similar time-sensitive topics.

For example, after asking about World Cup scores, a follow-up like "Japan's recent results" is searched as a World Cup-scoped question instead of a broad national-team query.

Very short follow-up prompts such as `葡萄牙呢`, `那这个呢`, or `and Portugal?` also reuse the active session. When the previous question makes the omitted predicate clear, the CLI rewrites the follow-up into a fuller question before routing and answering.

Time-sensitive popularity questions such as `YouTube现在最热门的视频是什么` route directly to web-answer mode. If the assistant previously suggested web research, confirmations such as `嗯切换吧` or `联网查吧` also enter that mode and reuse the previous question instead of searching for the confirmation phrase itself.

Short repository follow-ups can also reuse the active session. For example, if the previous turn returned a code snippet and the next turn says `写入一个文件里面`, `写进去`, or `保存一下`, the CLI rewrites that into an explicit repository task, carries over the latest code block, and lets `AGENT_LOOP` create the file instead of asking the user to repeat the code. Short coding follow-ups after an edit task, such as `数据流的中位数呢`, keep the repository-editing mode instead of falling back to chat-only output.

File-write confirmation is answered from local session records. If the user asks `你写入了嘛？`, the CLI checks whether a `FILE_CHANGE` record was created after the previous request. It will not ask the model to guess, and it will not claim a file was written when no write record exists.

## Regression Suite

The project keeps a focused conversation-level regression suite for the user-visible failures that are easiest to reintroduce:

- explicit snippet requests must stay chat-only
- implementation requests must create or update files
- short follow-ups such as `写入一个文件里面` or `写进去` must reuse the latest generated code
- short algorithm follow-ups after an edit task must remain in repository-editing mode
- write-confirmation questions such as `你写入了嘛？` must be grounded in session `FILE_CHANGE` records
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

Current normal-environment gate: 34 Vitest files and 247 tests, along with TypeScript type checking and unused-symbol checks.

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
/diff         Show git diff.
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
- `web_search` returns bounded public result titles, URLs, and snippets; it currently tries DuckDuckGo HTML first and falls back to DuckDuckGo Lite when needed. The CLI then ranks sources by domain trust hints, query overlap, and page type before deciding what to fetch, but it still does not grant arbitrary browser control.
- If a model-generated web answer contradicts the executed tool trace by claiming the CLI has no web capability or needs a manual web switch, the CLI treats that as invalid and asks for a grounded rewrite. Capability questions such as "你不能联网吗" are answered locally without calling the model.
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

The current session records are used as short-term memory. Before each LLM call, `mini-agent` injects recent user messages, assistant messages, task summaries, command results, tool results, and errors into the prompt.

Long-term memory is stored separately in `.mini-agent/memory/index.jsonl`. After tasks finish, the CLI indexes `TASK_SUMMARY` and `MEMORY_COMPACTION` records with keywords and a deterministic local vector representation. Retrieval is split into query building, candidate retrieval, reranking, and evidence selection before `ContextBuilder` injects the final memories as `Long-term retrieved memory`.

This is a local lightweight RAG layer. It is intentionally dependency-free for the MVP, so it is not the same as a production vector database or hosted embedding service. The design leaves an explicit extension point for replacing the deterministic local vector with real embeddings and a vector store later.

Runtime logs and task change logs serve different purposes:

- `logs/YYYY-MM-DD.jsonl` records operational events such as task start/end, tool debugging, command execution, CLI errors, and code-review stages like target resolution, primary/supplemental file loading, grounding, and verification.
- `change-log.jsonl` records task-level review entries: session id, task text, answer mode, success/failure, summary, changed files, diff stat, test outcomes, and task metadata such as review file, supplemental file count/list, findings count, rejected count, and verdict when the task is a code review.

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
- context builder with recent session memory
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
5. Add optional integration points for external systems without coupling them to this repo.
