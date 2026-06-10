# mini-coding-agent Backend

This module is the Java control-plane backend for `mini-coding-agent`. It does not reimplement the TypeScript AgentLoop or tool system. Instead, it accepts coding tasks over HTTP, starts the compiled TypeScript CLI runner locally or inside Docker, stores logs/events in H2, and exposes REST APIs for task inspection, sandbox status, session records, session events, and final diffs.

Chinese architecture and interview notes are available in:

- [架构设计说明](../docs/zh-CN/ARCHITECTURE.md)
- [面试讲解稿](../docs/zh-CN/INTERVIEW_GUIDE.md)
- [演示脚本](../docs/zh-CN/DEMO_SCRIPT.md)

## Responsibilities

- Create an `AgentTask` from an HTTP request.
- Validate that `repoPath` stays under the configured `workspace-root`.
- Start the TypeScript runner with `node ../dist/cli/index.js run ... --event-stream` in `LOCAL` mode.
- Create an isolated workspace and run `docker run ... node /opt/mini-agent/dist/cli/index.js run ...` in `DOCKER` mode.
- Persist stdout/stderr lines to `agent_task_log`.
- Parse `MINI_AGENT_EVENT ...` stdout lines and persist them to `agent_task_event`.
- Maintain task status: `CREATED`, `STARTING`, `RUNNING`, `COMPLETED`, `FAILED`, `CANCELLED`.
- Read `.mini-agent/sessions/*.jsonl` and `.mini-agent/events/*.jsonl` produced by the TypeScript runner.
- Preserve Docker task workspaces under `data/workspaces/task_<id>` for inspection.
- Create local Git workflow branches, commits, and PR draft text after a task completes.
- Provide REST and Swagger APIs for local verification.

## Prerequisites

- Java 17
- Maven 3.6+
- Node.js
- pnpm
- The TypeScript runner must be built before starting backend tasks.
- Docker is required for `DOCKER` mode.
- Build the sandbox image before creating Docker tasks.

From the repository root:

```bash
pnpm install
pnpm build
pnpm test
```

Then from `backend`:

```bash
mvn test
mvn spring-boot:run
```

Build the Docker sandbox image from the repository root:

```bash
pnpm run docker:build-sandbox
```

Open Swagger:

```text
http://localhost:8080/swagger-ui/index.html
```

## Configuration

Default configuration lives in `src/main/resources/application.yml`:

```yaml
server:
  port: 8080

spring:
  datasource:
    url: jdbc:h2:file:./data/code-agent
    driver-class-name: org.h2.Driver
    username: sa
    password:
  h2:
    console:
      enabled: true

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

The default paths assume `mvn spring-boot:run` is launched from `backend/`.

Common overrides:

```bash
CODE_AGENT_RUNNER_PATH=/absolute/path/to/dist/cli/index.js \
CODE_AGENT_WORKSPACE_ROOT=/absolute/path/to/workspaces \
mvn spring-boot:run
```

`workspace-root` is a security boundary. Every submitted `repoPath` must resolve to an existing directory inside it.

`execution-mode` can be `LOCAL` or `DOCKER`. Requests can override it with `executionMode`.

## Docker Sandbox

`WorkspaceService` creates one directory per task:

```text
data/workspaces/task_<id>/
  repo/
  logs/
  metadata.json
```

It copies the submitted repository into `repo/`, keeps `.git`, skips `.mini-agent`, `node_modules`, `target`, `dist`, `build`, `.idea`, and `.vscode`, and rolls back the task workspace if copying fails. Workspace paths are canonicalized and must stay under `code-agent.sandbox.workspace-root`; `repo` must stay under the task workspace.

`DockerCommandBuilder` generates a list-form command similar to:

```bash
docker run --name mini-agent-task-1 --cpus 2 --memory 2g --network none --rm \
  -v /abs/backend/data/workspaces/task_1/repo:/workspace \
  -v /abs/mini-coding-agent:/opt/mini-agent:ro \
  -w /workspace \
  mini-coding-agent-sandbox:latest \
  node /opt/mini-agent/dist/cli/index.js run "demo: 给 demo.txt 增加 hello from mini-agent" --mock --yes --max-steps 20 --event-stream
```

`DockerSandboxService` owns container lifecycle: create sandbox DB record, start `docker run`, read stdout/stderr asynchronously, parse `MINI_AGENT_EVENT` lines, stop containers on cancel/timeout, and update both task and sandbox status. By default Docker networking is disabled with `--network none`, CPU/memory limits are applied, the workspace is the only writable mount, and the runner mount is read-only.

When `useRealModel` is true, the backend passes OpenAI-compatible environment variable names to Docker with `-e`; API key values are not written to the DB or command logs.

## Git Workflow

`GitWorkflowService` runs delivery operations for completed tasks:

- Resolve the actual repo path: `task.repoPath` for `LOCAL`, `task.workspacePath/repo` for `DOCKER`.
- Create a work branch named `agent/task-{taskId}-{yyyyMMddHHmmss}` unless a branch name is provided.
- Generate a commit message when the user does not provide one.
- Commit the current task diff.
- Generate a PR title and Markdown description.
- Store workflow state in `agent_git_workflow`.
- Write task events and logs for branch, commit, PR draft, and failures.

`GitCommandExecutor` uses `ProcessBuilder` argument lists, never shell command strings. It validates branch names with a strict allowlist, checks that the repo path is a git repository, rejects empty commit messages, and rejects commit attempts when there are no changes.

Branch name rules:

```text
^[A-Za-z0-9][A-Za-z0-9_./-]{0,127}$
```

Names containing `..`, ending with `/`, or containing `@{` are rejected.

Commit message rules:

- `修复` or `fix` -> `fix(scope): ...`
- `测试` or `test` -> `test(scope): ...`
- `重构` or `refactor` -> `refactor(scope): ...`
- otherwise -> `feat(scope): ...`

PR drafts contain:

- `## Summary`
- `## Changes`
- `## Test`
- `## Review Notes`

## Runner Command

`RunnerCommandBuilder` starts tasks with a command like:

```bash
node ../dist/cli/index.js run "demo: 给 demo.txt 增加 hello from mini-agent" --mock --yes --max-steps 20 --event-stream
```

`useRealModel: true` switches `--mock` to `--real`. In that mode, the TypeScript runner reads the same OpenAI-compatible environment variables documented in the root README.

The `--event-stream` flag makes the runner print structured lines:

```text
MINI_AGENT_EVENT {"id":"...","sessionId":"...","type":"TOOL_CALL_STARTED","timestamp":"...","payload":{}}
```

Only lines with this exact prefix are parsed as events. Ordinary stdout/stderr lines are still stored as logs.

## REST APIs

Create and start a task:

```http
POST /api/agent/tasks
Content-Type: application/json

{
  "repoPath": "/absolute/path/to/repo",
  "userGoal": "demo: 给 demo.txt 增加 hello from mini-agent",
  "maxSteps": 20,
  "autoApprove": true,
  "useRealModel": false,
  "executionMode": "DOCKER"
}
```

Task APIs:

```text
GET  /api/agent/tasks
GET  /api/agent/tasks?status=RUNNING
GET  /api/agent/tasks?repoPath=/absolute/path/to/repo
GET  /api/agent/tasks/{id}
GET  /api/agent/tasks/{id}/events
GET  /api/agent/tasks/{id}/logs
GET  /api/agent/tasks/{id}/diff
GET  /api/agent/tasks/{id}/sandbox
GET  /api/agent/tasks/{id}/session/records
GET  /api/agent/tasks/{id}/session/events
GET  /api/agent/tasks/{id}/session/events?limit=50
GET  /api/agent/tasks/{id}/stream
POST /api/agent/tasks/{id}/cancel
```

Git Workflow APIs:

```text
GET  /api/agent/tasks/{id}/git/workflow
POST /api/agent/tasks/{id}/git/branch
POST /api/agent/tasks/{id}/git/commit
POST /api/agent/tasks/{id}/git/pr-draft
POST /api/agent/tasks/{id}/git/complete
```

Example:

```bash
curl -s -X POST http://localhost:8080/api/agent/tasks/1/git/complete \
  -H 'Content-Type: application/json' \
  -d '{"targetBranch":"main"}'
```

Session file APIs:

```text
GET /api/sessions?repoPath=/absolute/path/to/repo
GET /api/sessions/{sessionId}?repoPath=/absolute/path/to/repo
GET /api/sessions/{sessionId}/records?repoPath=/absolute/path/to/repo
GET /api/sessions/{sessionId}/events?repoPath=/absolute/path/to/repo
GET /api/sessions/{sessionId}/events?repoPath=/absolute/path/to/repo&limit=50
```

## Manual Demo

Build the TypeScript runner first:

```bash
cd /home/sid/miniagent/mini-coding-agent
pnpm build
pnpm run docker:build-sandbox
```

Create a demo repository inside the backend workspace:

```bash
mkdir -p /home/sid/miniagent/mini-coding-agent/tmp/backend-demo
cd /home/sid/miniagent/mini-coding-agent/tmp/backend-demo
git init
printf "demo file\n" > demo.txt
git add demo.txt
git commit -m "init"
```

Start the backend:

```bash
cd /home/sid/miniagent/mini-coding-agent/backend
mvn spring-boot:run
```

Create a task:

```bash
curl -s -X POST http://localhost:8080/api/agent/tasks \
  -H 'Content-Type: application/json' \
  -d '{
    "repoPath": "/home/sid/miniagent/mini-coding-agent/tmp/backend-demo",
    "userGoal": "demo: 给 demo.txt 增加 hello from mini-agent",
    "maxSteps": 20,
    "autoApprove": true,
    "useRealModel": false,
    "executionMode": "DOCKER"
  }'
```

Then query:

```bash
curl -s http://localhost:8080/api/agent/tasks/1
curl -s http://localhost:8080/api/agent/tasks/1/events
curl -s http://localhost:8080/api/agent/tasks/1/logs
curl -s http://localhost:8080/api/agent/tasks/1/diff
curl -s http://localhost:8080/api/agent/tasks/1/sandbox
```

## Database

The default H2 database is stored under:

```text
backend/data/code-agent.mv.db
```

Tables are initialized from `src/main/resources/schema.sql`:

- `agent_task`
- `agent_task_event`
- `agent_task_log`
- `agent_sandbox`
- `agent_git_workflow`

H2 console is enabled at:

```text
http://localhost:8080/h2-console
```

JDBC URL:

```text
jdbc:h2:file:./data/code-agent
```

## Error Handling

- Invalid `repoPath`: rejected before starting the runner.
- Runner start failure: task is marked `FAILED`, stderr log is recorded.
- Docker start failure: task and sandbox are marked `FAILED`, workspace is kept.
- Docker timeout: container is stopped and task becomes `FAILED`.
- Invalid `MINI_AGENT_EVENT` JSON: log line is kept, a parse error event is recorded, task continues.
- Runner exit code `0`: task becomes `COMPLETED` unless already terminal.
- Runner non-zero exit: task becomes `FAILED` unless already terminal.
- Cancel request: live process is destroyed when possible, task becomes `CANCELLED`.
- Docker cancel request: `docker stop <container>` is called, task becomes `CANCELLED`, workspace is kept.
- Git workflow failure: workflow status becomes `FAILED`, a `GIT_WORKFLOW_FAILED` event is recorded, and the error is kept on the workflow.

## Tests

```bash
mvn test
```

Covered areas:

- Runner command generation for mock/real modes.
- `--yes`, `--max-steps`, and `--event-stream` command arguments.
- Structured event parsing and invalid JSON handling.
- Task creation/status/cancel service behavior.
- LOCAL/DOCKER execution-mode routing.
- Docker command generation, resource flags, network defaults, and mounts.
- Workspace copy rules, excluded directories, `.git` preservation, and sandbox path rejection.
- Git command execution for branch, checkout, changed files, commit, and validation failures.
- Commit message and PR draft generation.
- Git Workflow service branch/commit/PR flow, event writing, and LOCAL/DOCKER path selection.
- JSONL session and event file reading.
- JSONL session and event file reading from Docker task workspaces.
- Workspace path escape rejection.
- Task detail/events/logs controller responses.

## Roadmap

- Replace polling SSE with an in-memory event bus.
- Add task permission handoff for REVIEW/DANGEROUS runner actions.
- Add MySQL profile and migration tooling.
- Harden Docker image/toolchain profiles and optional integration tests.
- Add remote push and GitHub/GitLab PR creation workflow after local PR draft generation.
