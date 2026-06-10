# mini-agent Sandbox Image

This image runs the TypeScript Agent Runner inside an isolated repository workspace.

Included tools:

- Node.js 20 with Corepack/pnpm support
- git
- ripgrep
- bash, curl, ca-certificates, openssh-client
- Java 17 and Maven
- Python 3 and pip

Build from the project root:

```bash
docker build -t mini-coding-agent-sandbox:latest -f docker/sandbox/Dockerfile .
```

The backend mounts the copied task repository at `/workspace` and mounts the local runner project at `/opt/mini-agent:ro`.
The image entrypoint prints basic tool versions to stderr, then executes the command provided by the backend.
