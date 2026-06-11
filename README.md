# mini-coding-agent

`mini-coding-agent` is a local conversational AI coding agent CLI. The first milestone focuses on a small but real loop inspired by Codex CLI and Claude Code: inspect a repository, call local tools, apply patches with review, run approved commands, capture feedback, and store every step in local JSONL session files.

## Chinese Docs

- [中文文档总览](docs/zh-CN/README.md)
- [架构设计说明](docs/zh-CN/ARCHITECTURE.md)
- [测试计划](docs/zh-CN/TEST_PLAN.md)
- [测试报告 2026-06-11](docs/zh-CN/TEST_REPORT_2026-06-11.md)
- [面试讲解稿](docs/zh-CN/INTERVIEW_GUIDE.md)
- [演示脚本](docs/zh-CN/DEMO_SCRIPT.md)
- [自测清单](docs/zh-CN/SELF_TEST_CHECKLIST.md)
- [面试问答](docs/zh-CN/INTERVIEW_QA.md)
- [后续规划](docs/zh-CN/ROADMAP.md)

## Current Stage

Phase 1 through Phase 11 are implemented:

- TypeScript and Node.js project skeleton.
- `mini-agent` CLI entry point.
- Commands for interactive mode, one-shot tasks, session resume/list, and diff.
- Build/test scripts.
- Typed tool interface and registry.
- SAFE tools: `list_files`, `read_file`, `search_code`, `git_status`, `git_diff`.
- Temporary JSON debug commands for listing and running tools.
- JSONL session and event stores under `.mini-agent`.
- Tool debug runs can be attached to a session with `--session`.
- Command execution with permission checks, timeout, output capture, and session/event logging.
- Patch preview/check/apply with git diff generation and session/event logging.
- AgentLoop, AgentState, AgentDecision, ContextBuilder, RepoScanner, and MockLlmClient.
- `mini-agent run "demo..." --yes` runs the full mock coding loop: plan, search, read, patch, command, diff, summary.
- OpenAI-compatible model client, structured AgentDecision parsing, JSON protocol validation, and `--real` CLI mode.
- Java Spring Boot backend module under `backend/`.
- Backend task APIs for starting the TypeScript runner, storing stdout/stderr logs, parsing `MINI_AGENT_EVENT` lines, querying task events, reading session JSONL files, and streaming events with SSE.
- React + Vite web console under `frontend/`.
- Web pages for task creation, task list, task detail, live events, stdout/stderr logs, final diff, session records/events, and task cancellation.
- Docker sandbox execution mode for backend tasks: isolated task workspace, Docker container lifecycle, CPU/memory/network limits, container cancellation, sandbox persistence, and workspace session/event reads.
- Git Workflow delivery flow: create a task branch, commit final diff, generate a PR title/description draft, expose backend APIs, and operate from the web task detail page.

Later phases will improve real-model planning quality, repair loops, and remote GitHub/GitLab PR creation.

## Install

```bash
pnpm install
pnpm build
pnpm test
```

Run all local verification targets:

```bash
pnpm verify
```

If `pnpm` is not available as a global command, use:

```bash
corepack pnpm verify
```

For local CLI usage from this repository:

```bash
pnpm build
node dist/cli/index.js --help
```

Or run the TypeScript entry directly during development:

```bash
pnpm dev
```

## Model Configuration

The CLI can run with `MockLlmClient` for deterministic local demos, but normal coding-agent usage should use a real OpenAI-compatible model.

Recommended local config:

```bash
node dist/cli/index.js config init \
  --real \
  --base-url "https://api.openai.com/v1" \
  --api-key "your_api_key" \
  --model "your_model"

node dist/cli/index.js config show
node dist/cli/index.js run "查看当前项目结构并总结可以从哪里开始修改" --yes
```

This writes `.mini-agent/config.json` in the current repository. `.mini-agent/` is ignored by git, and `config show` redacts the API key by default.

Example config:

```json
{
  "version": 1,
  "repoPath": "/path/to/repo",
  "createdAt": "2026-06-11T00:00:00.000Z",
  "llm": {
    "mode": "real",
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "your_api_key",
    "model": "your_model",
    "temperature": 0.2,
    "maxTokens": 4096,
    "timeoutMs": 60000
  }
}
```

You can avoid storing the key directly by using an environment variable reference:

```bash
node dist/cli/index.js config init \
  --real \
  --base-url "https://api.openai.com/v1" \
  --api-key-env MINI_AGENT_API_KEY \
  --model "your_model"
```

CLI flags override config for one run:

```bash
node dist/cli/index.js run "demo task" --mock
node dist/cli/index.js run "demo task" --real --model "another_model"
```

Environment variables are still supported as a fallback:

```bash
MINI_AGENT_BASE_URL=https://api.openai.com/v1
MINI_AGENT_API_KEY=your_api_key
MINI_AGENT_MODEL=your_model
MINI_AGENT_TEMPERATURE=0.2
MINI_AGENT_MAX_TOKENS=4096
MINI_AGENT_TIMEOUT_MS=60000
```

For real model mode, an API key and model are required, either from `.mini-agent/config.json`, from environment variables, or from CLI overrides where available. `MINI_AGENT_BASE_URL` defaults to `https://api.openai.com/v1`; the remaining values are optional defaults.

## CLI Commands

```bash
mini-agent
mini-agent run "demo: 给 demo.txt 增加 hello from mini-agent" --mock --yes
mini-agent run "inspect this repo" --real --max-steps 10
mini-agent run "demo: 给 demo.txt 增加一行 hello" --real --model your_model --yes
mini-agent run "demo: 给 demo.txt 增加 hello" --mock --yes --event-stream
mini-agent resume <sessionId>
mini-agent sessions
mini-agent config init --real --api-key your_api_key --model your_model
mini-agent config show
mini-agent session create --title "tool test"
mini-agent session show <sessionId>
mini-agent session events <sessionId>
mini-agent diff
mini-agent command run "echo hello" --yes
mini-agent command run "mvn test" --session <sessionId>
mini-agent patch preview fix.patch
mini-agent patch apply fix.patch --session <sessionId> --yes
mini-agent tool list
mini-agent tool run apply_patch '{"patch":"..."}' --session <sessionId>
mini-agent tool run list_files '{"path":"."}' --session <sessionId>
mini-agent tool run read_file '{"path":"README.md"}'
mini-agent tool run search_code '{"query":"class"}'
mini-agent tool run git_status '{}'
mini-agent tool run git_diff '{}'
mini-agent git status
mini-agent git diff
mini-agent git branch create agent/task-1-demo
mini-agent git commit --message "feat(agent): demo change"
mini-agent --help
```

When developing from this repository before publishing or linking the package, replace `mini-agent` with `node dist/cli/index.js` after `pnpm build`.

### `mini-agent`

Starts interactive mode in the current working directory.

```bash
Mini Coding Agent
Current repo: /path/to/project
Type your coding task, or use /exit, /diff, /status.
```

Interactive mode supports:

- `/exit`: quit.
- `/diff`: print current git diff.
- `/status`: print current git status.
- `/sessions`: list local sessions.

Any other non-empty input is treated as a coding task and executed through `AgentLoop`. It uses `.mini-agent/config.json` when configured, otherwise it falls back to the mock LLM.

### `mini-agent run "task"`

Runs a one-shot task through `AgentLoop`. With no model config it uses `MockLlmClient`; after `mini-agent config init --real ...`, it uses `OpenAICompatibleClient` by default:

```bash
node dist/cli/index.js run "demo: 给 demo.txt 增加 hello from mini-agent" --mock --yes
```

Options:

- `--session <sessionId>` appends the task to an existing session.
- `--yes` auto-approves REVIEW and DANGEROUS actions that are not blocked.
- `--max-steps <number>` overrides the default 20 loop steps.
- `--mock` selects the deterministic mock LLM path for this run.
- `--real` selects `OpenAICompatibleClient`.
- `--model <model>` overrides configured model or `MINI_AGENT_MODEL`.
- `--base-url <url>` overrides configured base URL or `MINI_AGENT_BASE_URL`.
- `--event-stream` prints `MINI_AGENT_EVENT {...}` lines for the Java backend while still writing normal session/event JSONL files.

Typical output:

```text
[task] demo: 给 demo.txt 增加 hello from mini-agent
[session] 7a5f...
[plan] 我会先搜索 demo 相关内容，读取 demo.txt，然后生成 patch、运行验证命令并查看 diff。
[tool] search_code
[tool] read_file
[patch] 给 demo.txt 增加 hello from mini-agent
[command] echo test passed
[tool] git_diff
[diff] generated
[summary] 已完成 demo.txt 修改，并运行 echo test passed 验证，diff 已生成。
```

Real model example:

```bash
node dist/cli/index.js config init \
  --real \
  --base-url "https://api.openai.com/v1" \
  --api-key "your-api-key" \
  --model "your-model"

node dist/cli/index.js run "查看当前项目结构并总结可以从哪里开始修改"
node dist/cli/index.js run "demo: 给 demo.txt 增加一行 hello from real model" --yes
```

### `mini-agent resume <sessionId>`

Placeholder for interactive resume. Direct session inspection is available with `mini-agent session show <sessionId>`.

### `mini-agent sessions`

Lists session summaries from `.mini-agent/index.json` as JSON.

### `mini-agent session create --title "title"`

Creates a new session, initializes the local `.mini-agent` layout, records a `SESSION_CREATED` event, and prints the session metadata:

```bash
node dist/cli/index.js session create --title "tool test"
```

### `mini-agent session show <sessionId>`

Prints all records from `.mini-agent/sessions/<sessionId>.jsonl`.

### `mini-agent session events <sessionId>`

Prints all events from `.mini-agent/events/<sessionId>.jsonl`.

### `mini-agent diff`

Prints `git diff` for the current repository through the `git_diff` tool.

### `mini-agent command run "<command>"`

Runs a shell command through `PermissionManager` and `CommandRunner`, then prints `CommandResult` JSON:

```bash
node dist/cli/index.js command run "echo hello" --yes
node dist/cli/index.js command run "pwd" --cwd "backend" --yes
node dist/cli/index.js command run "mvn test" --session <sessionId>
node dist/cli/index.js command run "sudo ls" --yes
```

Options:

- `--session <sessionId>` records command records and events.
- `--yes` auto-approves ordinary non-blocked commands.
- `--timeout <ms>` overrides the default 60000ms timeout.
- `--cwd <path>` runs from a repository-relative working directory.

Blocked commands print structured JSON errors and are not executed.

### `mini-agent patch preview <patchFile>`

Parses a unified diff patch and prints changed files, additions/deletions, and a summary:

```bash
node dist/cli/index.js patch preview fix.patch
cat fix.patch | node dist/cli/index.js patch preview
```

### `mini-agent patch apply <patchFile>`

Applies a unified diff patch through the `apply_patch` tool:

```bash
node dist/cli/index.js patch apply fix.patch
node dist/cli/index.js patch apply fix.patch --yes
node dist/cli/index.js patch apply fix.patch --session <sessionId> --yes
cat fix.patch | node dist/cli/index.js patch apply --yes
```

`patch apply` previews the patch, asks for REVIEW permission unless `--yes` is passed, runs `git apply --check`, applies the patch with `git apply`, then returns the resulting git diff as JSON.

### `mini-agent tool list`

Prints registered tools as JSON:

```bash
node dist/cli/index.js tool list
```

### `mini-agent tool run <name> <jsonInput>`

Runs a tool through `ToolRegistry.execute`, including Zod validation and structured errors:

```bash
node dist/cli/index.js tool run list_files '{"path":"."}'
node dist/cli/index.js tool run list_files '{"path":"."}' --session <sessionId>
node dist/cli/index.js tool run read_file '{"path":"README.md","maxLines":20}'
node dist/cli/index.js tool run search_code '{"query":"upload","path":"src"}'
node dist/cli/index.js tool run git_status '{}'
node dist/cli/index.js tool run git_diff '{"cached":false}'
```

## Tool System

Implemented tools:

- `list_files`: list files under a repository path.
- `read_file`: read up to 300 lines from a file.
- `search_code`: search with `rg`, returning up to 50 matches.
- `git_status`: show repository status.
- `git_diff`: show repository diff.
- `apply_patch`: check and apply unified diff patches.

All tools share a typed `Tool` interface with Zod input validation:

```ts
interface Tool<TInput, TResult> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  permissionLevel: PermissionLevel;
  execute(input: TInput, context: ToolContext): Promise<ToolResult<TResult>>;
}
```

`ToolContext` currently includes `repoPath`, optional `sessionId`, optional `maxOutputChars`, and optional session/event recorders. `ToolResult` always reports `success`; successful calls include `data`, while failures include a structured `{ code, message, details }` error.

When a tool is executed with `--session`, the registry writes:

- `TOOL_CALL_STARTED` event before validation/execution.
- `TOOL_CALL` session record with the requested input.
- `TOOL_RESULT` session record after execution.
- `TOOL_CALL_FINISHED` or `TOOL_CALL_FAILED` event depending on the result.

## Agent Loop

`AgentLoop` is the orchestration layer. It keeps the low-level systems independent and coordinates them like this:

1. Creates or resumes a session.
2. Records the user task as `USER_MESSAGE`.
3. Builds context from git status, tree summary, README/build files, recent results, errors, and diff.
4. Calls `LlmClient.chat`.
5. Dispatches `AgentDecision` values: `PLAN`, `TOOL_CALL`, `APPLY_PATCH`, `RUN_COMMAND`, `ASK_USER`, `FINAL`, and `FAILED`.
6. Writes session records and events throughout the run.
7. Stops at `FINAL`, `FAILED`, or the max step limit.

`MockLlmClient` has deterministic flows:

- Tasks containing `demo` or `hello`: `PLAN -> search_code -> read_file -> apply_patch -> echo test passed -> git_diff -> FINAL`.
- Tasks containing `upload`: search for `upload`, read the first match when available, then summarize.
- Other tasks: inspect with `git_status`, `list_files`, and `git_diff`.

`ContextBuilder` keeps the prompt bounded, with a default maximum of 30000 characters.

`OpenAICompatibleClient` calls an OpenAI-compatible `/chat/completions` endpoint with:

- `Authorization: Bearer <MINI_AGENT_API_KEY>`.
- A system prompt from `src/llm/prompts.ts`.
- User goal, repository context, AgentState snapshot, and available tool specs.
- `response_format: { "type": "json_object" }`.

Model output is parsed by `DecisionParser`. It accepts plain JSON, fenced JSON code blocks, or text that contains one JSON object, then validates the result with Zod. Invalid output becomes a `FAILED` decision or an `ERROR` session record; API keys are never printed.

## Java Backend

Phase 8 adds a Spring Boot control-plane backend in `backend/`. The backend is intentionally separate from the TypeScript runner:

- TypeScript CLI runner: owns AgentLoop, tools, patch application, command execution, git diff generation, and `.mini-agent` session/events files.
- Java backend: owns HTTP APIs, task records, runner subprocess lifecycle, stdout/stderr logs, parsed event storage, task status, H2 persistence, Swagger, and SSE event streaming.

Build the runner first:

```bash
pnpm build
```

Then run backend tests and start the API:

```bash
cd backend
mvn test
mvn spring-boot:run
```

Open Swagger:

```text
http://localhost:8080/swagger-ui/index.html
```

Default backend config:

```yaml
code-agent:
  runner-path: ../dist/cli/index.js
  node-path: node
  workspace-root: ../
  default-max-steps: 20
  default-timeout-seconds: 600
  execution-mode: DOCKER
  sandbox:
    enabled: true
    docker-image: mini-coding-agent-sandbox:latest
    workspace-root: ./data/workspaces
    container-workdir: /workspace
    cpu-limit: "2"
    memory-limit: "2g"
    network-enabled: false
    auto-remove-container: true
    container-timeout-seconds: 600
    runner-mount-path: /opt/mini-agent
    runner-host-path: ../
```

`workspace-root` is the backend security boundary. Submitted `repoPath` values must resolve to directories inside it. The default values assume `mvn spring-boot:run` is launched from `backend/`.

### Docker Sandbox Mode

In `DOCKER` mode the backend does not mutate the submitted repository directly. It creates:

```text
backend/data/workspaces/task_<taskId>/
  repo/
  logs/
  metadata.json
```

`WorkspaceService` copies the source repo into `repo/`, preserves `.git`, and excludes `.mini-agent`, `node_modules`, `target`, `dist`, `build`, `.idea`, and `.vscode`. The backend then runs the TypeScript runner in a Docker container with the copied repo mounted writable at `/workspace` and the runner project mounted read-only at `/opt/mini-agent`.

Build the sandbox image from the repository root:

```bash
pnpm run docker:build-sandbox
```

Equivalent Docker command:

```bash
docker build -t mini-coding-agent-sandbox:latest -f docker/sandbox/Dockerfile .
```

`LOCAL` mode is still available by sending `"executionMode": "LOCAL"` in the create-task request or changing `code-agent.execution-mode`.

Create a task:

```bash
curl -s -X POST http://localhost:8080/api/agent/tasks \
  -H 'Content-Type: application/json' \
  -d '{
    "repoPath": "/absolute/path/to/repo",
    "userGoal": "demo: 给 demo.txt 增加 hello from mini-agent",
    "maxSteps": 20,
    "autoApprove": true,
    "useRealModel": false,
    "executionMode": "DOCKER"
  }'
```

Useful APIs:

```text
GET  /api/agent/tasks
GET  /api/agent/tasks/{id}
GET  /api/agent/tasks/{id}/events
GET  /api/agent/tasks/{id}/logs
GET  /api/agent/tasks/{id}/diff
GET  /api/agent/tasks/{id}/sandbox
GET  /api/agent/tasks/{id}/session/records
GET  /api/agent/tasks/{id}/session/events?limit=200
GET  /api/agent/tasks/{id}/git/workflow
POST /api/agent/tasks/{id}/git/branch
POST /api/agent/tasks/{id}/git/commit
POST /api/agent/tasks/{id}/git/pr-draft
POST /api/agent/tasks/{id}/git/complete
GET  /api/agent/tasks/{id}/stream
POST /api/agent/tasks/{id}/cancel
GET  /api/sessions?repoPath=/absolute/path/to/repo
GET  /api/sessions/{sessionId}/records?repoPath=/absolute/path/to/repo
GET  /api/sessions/{sessionId}/events?repoPath=/absolute/path/to/repo
```

See `backend/README.md` for backend setup, API examples, H2 details, and the roadmap.

## Web Frontend

Phase 9 adds a React + TypeScript + Vite console in `frontend/`. The frontend calls the Java backend APIs and never runs Agent logic in the browser.

Frontend responsibilities:

- Create Agent tasks.
- Choose `LOCAL` or `DOCKER` execution mode.
- List tasks and filter by status or repository path.
- Show task details, status, execution mode, workspace path, sandbox container, session id, summary, and errors.
- Stream execution events with SSE and fall back to polling.
- Show stdout/stderr logs.
- Show and copy final git diff.
- Create a Git workflow branch, commit changes, generate PR draft text, and copy the PR draft.
- Open session records and session events written by the TypeScript runner.
- Cancel running tasks through the backend API.

Install and build:

```bash
cd frontend
pnpm install
pnpm build
```

Run in development:

```bash
cd frontend
pnpm dev
```

Open:

```text
http://localhost:5173
```

The frontend reads `VITE_API_BASE_URL`; when omitted it defaults to `http://localhost:8080`.

```bash
VITE_API_BASE_URL=http://localhost:8080 pnpm dev
```

## Overall Architecture

```text
Browser Web Console
  React + Vite + Ant Design
        |
        | REST + SSE
        v
Java Backend
  Spring Boot + H2 + JPA
        |
        | LOCAL: node ../dist/cli/index.js run ... --event-stream
        | DOCKER: docker run ... node /opt/mini-agent/dist/cli/index.js run ...
        v
TypeScript Agent Runner
  AgentLoop + tools + patch + command + git + JSONL sessions
        |
        v
Target Repository
```

Recommended startup order:

```bash
# 1. Build the TypeScript runner
pnpm build

# 2. Start the Java backend
cd backend
mvn spring-boot:run

# 3. Start the Web frontend
cd ../frontend
pnpm install
pnpm dev
```

Complete browser demo:

1. Prepare a git repository inside the backend `workspace-root`.
2. Start backend and frontend.
3. Open `http://localhost:5173`.
4. Go to `Tasks`, then `Create`.
5. Enter the absolute `repoPath`.
6. Enter `demo: 给 demo.txt 增加 hello from mini-agent`.
7. Keep `executionMode` as `DOCKER`, `maxSteps` at `20`, `autoApprove` on, and `useRealModel` off.
8. Submit and watch the task detail page.
9. Confirm events arrive, logs render, sandbox info appears, and the final diff is available from the copied workspace.
10. In the Diff tab, use Git Workflow to create a branch, commit, and generate a PR draft.

## Git Workflow

Phase 11 adds a local delivery flow after a task reaches `COMPLETED`.

Backend API flow:

```bash
curl -s -X POST http://localhost:8080/api/agent/tasks/1/git/branch \
  -H 'Content-Type: application/json' \
  -d '{"branchName":"agent/task-1-demo"}'

curl -s -X POST http://localhost:8080/api/agent/tasks/1/git/commit \
  -H 'Content-Type: application/json' \
  -d '{"commitMessage":"feat(agent): demo change"}'

curl -s -X POST http://localhost:8080/api/agent/tasks/1/git/pr-draft \
  -H 'Content-Type: application/json' \
  -d '{"targetBranch":"main"}'
```

One-shot flow:

```bash
curl -s -X POST http://localhost:8080/api/agent/tasks/1/git/complete \
  -H 'Content-Type: application/json' \
  -d '{"targetBranch":"main"}'
```

`CommitMessageGenerator` uses simple rules: goals containing `修复`/`fix` become `fix`, `测试`/`test` become `test`, `重构`/`refactor` become `refactor`, otherwise `feat`. `PrDescriptionGenerator` creates a draft with Summary, Changes, Test, and Review Notes sections.

Mode differences:

- `DOCKER`: git operations run in `backend/data/workspaces/task_<id>/repo`; the original repository is not modified.
- `LOCAL`: git operations run directly in `repoPath`; this changes the local repository branch and commit state.

Remote push and GitHub/GitLab PR creation are intentionally not implemented yet. The current flow produces a local branch, local commit, and copyable PR draft.

## AgentDecision Protocol

Models must return exactly one JSON object:

```json
{ "type": "PLAN", "message": "I will search and read relevant files first." }
```

Allowed shapes:

```json
{ "type": "TOOL_CALL", "toolName": "search_code", "input": { "query": "upload" } }
```

```json
{ "type": "APPLY_PATCH", "patch": "diff --git ...", "description": "Add validation" }
```

```json
{ "type": "RUN_COMMAND", "command": "pnpm test", "description": "Run the test suite" }
```

```json
{ "type": "ASK_USER", "message": "Which package should I modify?" }
```

```json
{ "type": "FINAL", "summary": "Completed and tests passed.", "success": true }
```

```json
{ "type": "FAILED", "error": "Cannot continue safely." }
```

The parser rejects unknown `type` values, missing `toolName`, missing `patch`, missing `command`, and schema-invalid fields.

## Path Safety

File tools call `resolveRepoPath(repoPath, targetPath)` before touching the filesystem. Paths may be relative or absolute, but the resolved path must stay inside the repository root. Attempts such as `../outside.txt` return:

```json
{
  "success": false,
  "error": {
    "code": "PATH_OUTSIDE_REPOSITORY",
    "message": "Path is outside repository"
  }
}
```

`read_file` also checks the real path before reading, so symlinks cannot escape the repository.

Patch paths are parsed before `git apply` runs. Patches cannot modify absolute paths, paths outside the repository, `.git`, or `.mini-agent`.

## Permission Model

Implemented permission levels:

- `SAFE`: read-only tools, allowed by default.
- `REVIEW`: file-changing tools, require confirmation.
- `DANGEROUS`: shell commands, require confirmation and risk checks.

`command run` uses `DANGEROUS`. In interactive mode it asks for approval unless `--yes` is passed. In non-interactive auto-approve mode, ordinary commands are allowed, but dangerous commands are still blocked.

`patch apply` uses `REVIEW`. In interactive mode it asks for approval with the patch summary. `--yes` auto-approves patch application, but path safety checks and `git apply --check` still run.

Blocked command patterns include:

- `rm -rf /`
- `rm -rf /*`
- `sudo`
- `mkfs`
- `shutdown`
- `reboot`
- `chmod 777 /`
- `chown -R`
- `dd if=`
- `:(){ :|:& };:`

## Command Runner

`CommandRunner` executes shell commands inside the repository. The default working directory is `repoPath`; `--cwd` must also resolve inside the repository. Results include:

```json
{
  "command": "echo hello",
  "cwd": "/repo",
  "exitCode": 0,
  "stdout": "hello",
  "stderr": "",
  "durationMs": 12,
  "success": true,
  "timedOut": false,
  "truncated": false
}
```

Output is truncated after 20000 characters by default. Timed-out commands are terminated and returned as `success: false`.

## Patch Manager

`PatchManager` writes patch content to `.mini-agent/tmp`, runs `git apply --check`, applies with `git apply`, deletes the temp file, and returns a structured result:

```json
{
  "success": true,
  "applied": true,
  "preview": {
    "summary": "Modified 1 file: demo.txt (+1, -0)"
  },
  "diff": "...",
  "changedFiles": [
    {
      "path": "demo.txt",
      "changeType": "MODIFIED",
      "additions": 1,
      "deletions": 0
    }
  ]
}
```

Preview supports common unified diff cases: modified files, added files, deleted files, and multi-file patches.

## Session Files

Session storage is implemented under the current repository root:

```text
.mini-agent/
  config.json
  index.json
  sessions/
    <sessionId>.jsonl
  events/
    <sessionId>.jsonl
```

`index.json` stores `SessionMeta` summaries for quick listing. `sessions/*.jsonl` stores append-only session records such as `USER_MESSAGE`, `ASSISTANT_MESSAGE`, `TOOL_CALL`, `TOOL_RESULT`, `COMMAND_RESULT`, `FILE_CHANGE`, `DIFF_SUMMARY`, `TASK_SUMMARY`, and `ERROR`.

`events/*.jsonl` stores fine-grained events such as `SESSION_CREATED`, `TOOL_CALL_STARTED`, `TOOL_CALL_FINISHED`, `TOOL_CALL_FAILED`, command/test/patch events, and final task events. Empty lines are ignored on read; invalid JSONL reports the line number.

When an agent task runs, `AgentLoop` writes:

- Session records: `USER_MESSAGE`, `ASSISTANT_MESSAGE`, `AGENT_DECISION`, `TOOL_CALL`, `TOOL_RESULT`, `COMMAND_RESULT`, `FILE_CHANGE`, `DIFF_SUMMARY`, `TASK_SUMMARY`, and `ERROR` when needed.
- Events: `USER_MESSAGE`, `ASSISTANT_MESSAGE`, `TOOL_CALL_STARTED`, `TOOL_CALL_FINISHED`, `TOOL_CALL_FAILED`, `PATCH_APPLY_STARTED`, `PATCH_APPLY_FINISHED`, `PATCH_APPLY_FAILED`, `COMMAND_STARTED`, `COMMAND_FINISHED`, `TEST_PASSED`, `TEST_FAILED`, `DIFF_GENERATED`, `TASK_FINISHED`, and `TASK_FAILED`.

When a command is executed with `--session`, the CLI writes:

- `COMMAND_STARTED` before execution.
- `COMMAND_RESULT` in the session records after execution.
- `COMMAND_FINISHED` after execution.
- `TEST_PASSED` or `TEST_FAILED` for test-like commands such as `mvn test`, `npm test`, `pnpm test`, `go test`, `pytest`, and `gradle test`.

When a patch is applied with `--session`, the tool writes:

- `PATCH_APPLY_STARTED` before permission/check/apply.
- `PATCH_APPLY_FINISHED` after successful apply.
- `PATCH_APPLY_FAILED` on permission denial, check failure, or apply failure.
- `FILE_CHANGE` session record with changed files and resulting diff.

## MVP Roadmap

1. Project skeleton and CLI entry.
2. Tool interface, registry, and read-only tools.
3. JSONL session and event stores.
4. Permission manager and command runner.
5. Patch manager and `apply_patch`.
6. Agent loop, state, decisions, planner, and mock LLM.
7. OpenAI-compatible real-model client and decision parser.
8. Expanded repair loops and end-to-end UX polish.

## Common Errors

- `Missing MINI_AGENT_API_KEY`: set the API key in `.mini-agent/config.json`, set `MINI_AGENT_API_KEY`, or configure `apiKeyEnv`.
- `Missing MINI_AGENT_MODEL`: set the model in `.mini-agent/config.json`, set `MINI_AGENT_MODEL`, or pass `--model`.
- `LLM request failed: <status>`: check `MINI_AGENT_BASE_URL`, model name, credentials, and provider compatibility.
- `LLM response did not include content`: the provider returned no assistant text.
- `INVALID_AGENT_DECISION`: the model returned JSON that does not match the AgentDecision protocol.
- `Tool not found`: the model requested a tool outside the available tool list.
- `Tool input validation failed`: the model used the right tool with invalid arguments.
- `Agent repeated the same decision too many times`: the loop stopped to avoid an infinite cycle.
- `Agent failed too many consecutive steps`: the model/action path failed repeatedly.

For debugging, inspect:

```bash
node dist/cli/index.js sessions
node dist/cli/index.js session show <sessionId>
node dist/cli/index.js session events <sessionId>
```

## Safety Notes

Read-only tools are allowed automatically. Patch application requires REVIEW permission and command execution requires DANGEROUS permission. `--yes` auto-approves ordinary REVIEW/DANGEROUS actions for non-interactive runs, but blocked command patterns such as `sudo`, `rm -rf /`, `mkfs`, `shutdown`, and `reboot` are still refused.

## Demo

Create a temporary git repository:

```bash
mkdir -p /tmp/mini-agent-demo
cd /tmp/mini-agent-demo
git init
printf "demo file\n" > demo.txt
git add demo.txt
```

Run the mock agent from this project:

```bash
cd /tmp/mini-agent-demo
node /home/sid/miniagent/mini-coding-agent/dist/cli/index.js run "demo: 给 demo.txt 增加 hello from mini-agent" --mock --yes
node /home/sid/miniagent/mini-coding-agent/dist/cli/index.js diff
node /home/sid/miniagent/mini-coding-agent/dist/cli/index.js sessions
```

Expected result:

- `demo.txt` contains `hello from mini-agent`.
- `git diff` shows the added line.
- `.mini-agent/sessions/<sessionId>.jsonl` contains tool, command, diff, and summary records.
- `.mini-agent/events/<sessionId>.jsonl` contains tool, patch, command, diff, and task events.
