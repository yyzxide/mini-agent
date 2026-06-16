# mini-coding-agent

`mini-coding-agent` is a local AI Coding Agent CLI. It runs inside a git repository, accepts natural-language coding tasks, uses controlled tools to inspect and edit the codebase, runs commands, records every step to local JSONL session files, and prints the final summary plus git diff.

The project is intentionally focused on the local CLI loop. There is no bundled backend service or web console in the current version.

## What It Does

- Starts an interactive local coding-agent session with `mini-agent`.
- Runs one-shot tasks with `mini-agent run "..."`.
- Routes standalone questions/code snippets to direct-answer mode before using the repository-editing agent loop.
- Calls real OpenAI-compatible chat completions APIs.
- Fetches bounded public HTTP(S) pages through the `fetch_url` tool.
- Searches code with `rg`.
- Reads files with repository path safety checks.
- Applies unified diff patches after `git apply --check`.
- Runs shell commands with timeout and dangerous-command blocking.
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
mini-agent resume <sessionId>
mini-agent sessions
mini-agent diff
mini-agent tool list
mini-agent tool run read_file '{"path":"README.md"}'
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

## Typical Local Workflow

Run inside any git repository:

```bash
cd /path/to/your/repo
mini-agent run "find the README and explain how this project is structured"
```

For a standalone question or code snippet, `run` answers directly without editing files:

```bash
mini-agent run "write a C++ two-sum example"
```

For a real coding task:

```bash
mini-agent run "add validation for uploaded file extensions and update tests"
```

At the end, inspect changes:

```bash
git status --short
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
| `fetch_url` | `SAFE` | Fetch bounded text from a public HTTP(S) URL. |
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
- `fetch_url` blocks localhost/private-network targets, limits timeout/download size, and returns only readable text-like content.
- Patch application runs `git apply --check` before `git apply`.
- Commands have a timeout and output truncation.
- Dangerous command patterns such as `rm -rf /`, `sudo`, `mkfs`, `shutdown`, `reboot`, and `chmod 777 /` are blocked.

This is a local developer tool, not a production sandbox.

## Session Files

Each repository gets a local `.mini-agent/` directory:

```text
.mini-agent/
  config.json
  sessions/
    <sessionId>.jsonl
  events/
    <sessionId>.jsonl
```

Session records include:

- user and assistant messages
- tool calls and results
- command executions
- patch events
- file-change summaries
- test pass/fail markers
- final git diff

List sessions:

```bash
mini-agent sessions
```

Inspect one session:

```bash
mini-agent session show <sessionId>
mini-agent session events <sessionId>
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
```

## Current MVP Scope

Included:

- TypeScript CLI
- real OpenAI-compatible LLM client
- task router for direct answers vs repository edits
- agent loop
- context builder
- tool registry
- path-safe file tools
- git status and diff tools
- patch manager
- command runner
- permission manager
- local JSONL sessions and events
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
