# mini-coding-agent Frontend

React + TypeScript + Vite web console for `mini-coding-agent`. The frontend talks to the Java backend only; Agent execution still lives in the TypeScript runner launched by the backend.

Chinese architecture and demo notes are available in:

- [架构设计说明](../docs/zh-CN/ARCHITECTURE.md)
- [演示脚本](../docs/zh-CN/DEMO_SCRIPT.md)
- [面试问答](../docs/zh-CN/INTERVIEW_QA.md)

## Install

```bash
cd frontend
pnpm install
```

## Start

Start the TypeScript runner and Java backend first:

```bash
cd ..
pnpm build
cd backend
mvn spring-boot:run
```

Then start the frontend:

```bash
cd ../frontend
pnpm dev
```

Open:

```text
http://localhost:5173
```

## Environment

The frontend uses `VITE_API_BASE_URL` when provided:

```bash
VITE_API_BASE_URL=http://localhost:8080 pnpm dev
```

Without the variable, API calls default to `http://localhost:8080`. Vite also proxies `/api` to `http://localhost:8080` during local development.

## Pages

- `/tasks`: task list with status/repository filters, refresh, detail navigation, and cancel action.
- `/tasks/create`: create an Agent task with repo path, goal, execution mode, max steps, auto approve, and real-model switches.
- `/tasks/:id`: task detail with metadata, execution mode, workspace path, sandbox info, current status, events, stdout/stderr logs, final diff, Git Workflow actions, cancel, and session record/event drawers.

## API

API calls are centralized in:

- `src/api/http.ts`: axios instance, base URL, ApiResponse unwrapping, error normalization.
- `src/api/taskApi.ts`: task CRUD, events, logs, diff, sandbox info, task session records/events, Git Workflow, cancel, SSE URL.
- `src/api/sessionApi.ts`: repository-level session records and session events.

## Git Workflow Panel

The task detail Diff tab includes `GitWorkflowPanel`.

It shows:

- execution mode and actual repo path
- workflow status
- base branch and work branch
- commit hash and commit message
- PR title and generated PR description

Available actions:

- Create branch
- Commit
- Generate PR draft
- Complete workflow
- Copy PR

Actions are enabled only when the task is `COMPLETED` and a diff exists. In `DOCKER` mode, the panel operates on the task workspace repository. In `LOCAL` mode, it shows a warning because branch and commit operations modify the original local repository.

## SSE

`useTaskEvents(taskId)` connects to:

```text
/api/agent/tasks/{id}/stream
```

It appends incoming events by id, avoids duplicates, and falls back to polling `/api/agent/tasks/{id}/events` every two seconds if SSE disconnects. When a task reaches `COMPLETED`, `FAILED`, or `CANCELLED`, the hook closes the live connection and performs a final refresh.

## Common Issues

- `Network request failed`: start the Java backend or set `VITE_API_BASE_URL`.
- `repoPath is outside workspace-root`: update backend `code-agent.workspace-root` or choose a repo inside it.
- No events appear: use task refresh; the frontend will fall back to polling if SSE is unavailable.
- Docker task has no sandbox info: make sure the request uses `executionMode: DOCKER` and the backend has Docker sandbox enabled.
- Git Workflow buttons are disabled: wait until the task is `COMPLETED` and make sure the task has a non-empty diff.
- Port `5173` is busy: run `pnpm dev -- --port 5174` and add the new origin to backend CORS if needed.
