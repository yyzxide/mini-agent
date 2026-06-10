package com.yuzhe.codeagent.service;

import com.yuzhe.codeagent.common.BusinessException;
import com.yuzhe.codeagent.config.CodeAgentProperties;
import com.yuzhe.codeagent.domain.AgentTask;
import com.yuzhe.codeagent.enums.AgentExecutionMode;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.springframework.stereotype.Service;

@Service
public class PathSecurityService {

    private final CodeAgentProperties properties;

    public PathSecurityService(CodeAgentProperties properties) {
        this.properties = properties;
    }

    public Path validateRepoPath(String repoPath) {
        try {
            Path workspace = Path.of(properties.getWorkspaceRoot()).toAbsolutePath().normalize().toRealPath();
            Path repo = Path.of(repoPath).toAbsolutePath().normalize().toRealPath();

            if (!Files.isDirectory(repo)) {
                throw new BusinessException("repoPath is not a directory: " + repoPath);
            }
            if (!repo.startsWith(workspace)) {
                throw new BusinessException("repoPath is outside workspace-root");
            }
            return repo;
        } catch (IOException exception) {
            throw new BusinessException("Invalid repoPath: " + repoPath, exception);
        }
    }

    public Path resolveMiniAgentFile(String repoPath, String sessionId, String kind) {
        Path repo = validateRepoPath(repoPath);
        return resolveMiniAgentFile(repo, sessionId, kind);
    }

    public Path resolveMiniAgentFile(AgentTask task, String sessionId, String kind) {
        return resolveMiniAgentFile(resolveTaskRepoPath(task), sessionId, kind);
    }

    public Path resolveMiniAgentIndex(String repoPath) {
        return resolveMiniAgentIndex(validateRepoPath(repoPath));
    }

    public Path resolveMiniAgentIndex(AgentTask task) {
        return resolveMiniAgentIndex(resolveTaskRepoPath(task));
    }

    public Path resolveTaskRepoPath(AgentTask task) {
        if (task.getExecutionMode() == AgentExecutionMode.DOCKER && task.getWorkspacePath() != null && !task.getWorkspacePath().isBlank()) {
            Path repoWorkspace = Path.of(task.getWorkspacePath()).resolve("repo");
            return validateSandboxRepoPath(repoWorkspace.toString(), task.getWorkspacePath());
        }
        return validateRepoPath(task.getRepoPath());
    }

    public Path validateSandboxWorkspacePath(String workspacePath) {
        try {
            Path root = Path.of(properties.getSandbox().getWorkspaceRoot()).toAbsolutePath().normalize().toRealPath();
            Path workspace = Path.of(workspacePath).toAbsolutePath().normalize().toRealPath();
            if (!Files.isDirectory(workspace)) {
                throw new BusinessException("workspacePath is not a directory: " + workspacePath);
            }
            if (!workspace.startsWith(root)) {
                throw new BusinessException("workspacePath is outside sandbox workspace-root");
            }
            return workspace;
        } catch (IOException exception) {
            throw new BusinessException("Invalid workspacePath: " + workspacePath, exception);
        }
    }

    public Path validateSandboxRepoPath(String repoWorkspacePath, String workspacePath) {
        try {
            Path workspace = validateSandboxWorkspacePath(workspacePath);
            Path repo = Path.of(repoWorkspacePath).toAbsolutePath().normalize().toRealPath();
            if (!Files.isDirectory(repo)) {
                throw new BusinessException("repoWorkspacePath is not a directory: " + repoWorkspacePath);
            }
            if (!repo.startsWith(workspace)) {
                throw new BusinessException("repoWorkspacePath is outside task workspace");
            }
            return repo;
        } catch (IOException exception) {
            throw new BusinessException("Invalid repoWorkspacePath: " + repoWorkspacePath, exception);
        }
    }

    private Path resolveMiniAgentFile(Path repo, String sessionId, String kind) {
        if (!sessionId.matches("^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")) {
            throw new BusinessException("Invalid sessionId: " + sessionId);
        }
        if (!kind.equals("sessions") && !kind.equals("events")) {
            throw new BusinessException("Invalid mini-agent file kind: " + kind);
        }

        Path miniAgentRoot = repo.resolve(".mini-agent").normalize();
        Path file = miniAgentRoot.resolve(kind).resolve(sessionId + ".jsonl").normalize();
        if (!file.startsWith(miniAgentRoot)) {
            throw new BusinessException("Requested file is outside .mini-agent");
        }
        return file;
    }

    private Path resolveMiniAgentIndex(Path repo) {
        Path miniAgentRoot = repo.resolve(".mini-agent").normalize();
        Path file = miniAgentRoot.resolve("index.json").normalize();
        if (!file.startsWith(miniAgentRoot)) {
            throw new BusinessException("Requested file is outside .mini-agent");
        }
        return file;
    }
}
