# Docker Sandbox

The Java backend can run tasks in Docker mode. For each task it creates `backend/data/workspaces/task_<id>/repo`,
copies the source repository there, and starts a container with that copy mounted as `/workspace`.

Build the image:

```bash
docker build -t mini-coding-agent-sandbox:latest -f docker/sandbox/Dockerfile .
```

Manual smoke test after `pnpm build`:

```bash
docker run --rm \
  --network none \
  -v "$PWD:/opt/mini-agent:ro" \
  -v "$PWD:/workspace" \
  -w /workspace \
  mini-coding-agent-sandbox:latest \
  node /opt/mini-agent/dist/cli/index.js --help
```

The first image is intentionally broad enough for Node, Java, and Python projects. Go or other toolchains can be added
later by extending `docker/sandbox/Dockerfile`.
