package com.yuzhe.codeagent.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.yuzhe.codeagent.common.BusinessException;
import com.yuzhe.codeagent.config.CodeAgentProperties;
import com.yuzhe.codeagent.sandbox.WorkspaceCopyOptions;
import java.io.IOException;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.time.Instant;
import java.util.Comparator;
import java.util.Map;
import org.springframework.stereotype.Service;

@Service
public class WorkspaceService {

    private final CodeAgentProperties properties;
    private final ObjectMapper objectMapper;

    public WorkspaceService(CodeAgentProperties properties, ObjectMapper objectMapper) {
        this.properties = properties;
        this.objectMapper = objectMapper;
    }

    public WorkspacePaths createWorkspace(Long taskId, Path sourceRepo) {
        Path workspaceRoot = sandboxWorkspaceRoot();
        Path taskWorkspace = workspaceRoot.resolve("task_" + taskId).normalize();
        Path repoWorkspace = taskWorkspace.resolve("repo").normalize();
        Path logsPath = taskWorkspace.resolve("logs").normalize();

        ensureUnder(workspaceRoot, taskWorkspace, "workspacePath must be inside sandbox workspace-root");
        ensureUnder(taskWorkspace, repoWorkspace, "repoWorkspacePath must be inside task workspace");

        try {
            if (!Files.isDirectory(sourceRepo)) {
                throw new BusinessException("Source repo is not a directory: " + sourceRepo);
            }
            deleteIfExists(taskWorkspace);
            Files.createDirectories(repoWorkspace);
            Files.createDirectories(logsPath);
            copyRepository(sourceRepo.toRealPath(), repoWorkspace, WorkspaceCopyOptions.defaults());
            writeMetadata(taskId, sourceRepo.toRealPath(), taskWorkspace, repoWorkspace);
            return new WorkspacePaths(taskWorkspace, repoWorkspace, logsPath);
        } catch (BusinessException exception) {
            deleteQuietly(taskWorkspace);
            throw exception;
        } catch (IOException exception) {
            deleteQuietly(taskWorkspace);
            throw new BusinessException("Failed to create task workspace", exception);
        }
    }

    public Path sandboxWorkspaceRoot() {
        try {
            Path root = Path.of(properties.getSandbox().getWorkspaceRoot()).toAbsolutePath().normalize();
            Files.createDirectories(root);
            return root.toRealPath();
        } catch (IOException exception) {
            throw new BusinessException("Invalid sandbox workspace-root", exception);
        }
    }

    private void copyRepository(Path sourceRepo, Path targetRepo, WorkspaceCopyOptions options) throws IOException {
        Files.walkFileTree(sourceRepo, new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) throws IOException {
                Path relative = sourceRepo.relativize(dir);
                if (!relative.toString().isEmpty() && options.shouldExcludeDirectory(dir.getFileName().toString())) {
                    return FileVisitResult.SKIP_SUBTREE;
                }

                Path target = targetRepo.resolve(relative).normalize();
                ensureUnder(targetRepo, target, "Copied directory escaped repository workspace");
                Files.createDirectories(target);
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) throws IOException {
                if (Files.isSymbolicLink(file)) {
                    return FileVisitResult.CONTINUE;
                }
                Path relative = sourceRepo.relativize(file);
                Path target = targetRepo.resolve(relative).normalize();
                ensureUnder(targetRepo, target, "Copied file escaped repository workspace");
                Files.createDirectories(target.getParent());
                Files.copy(file, target);
                return FileVisitResult.CONTINUE;
            }
        });
    }

    private void writeMetadata(Long taskId, Path sourceRepo, Path taskWorkspace, Path repoWorkspace) throws IOException {
        Map<String, Object> metadata = Map.of(
                "taskId", taskId,
                "sourceRepoPath", sourceRepo.toString(),
                "repoWorkspacePath", repoWorkspace.toString(),
                "createdAt", Instant.now().toString());
        objectMapper.writerWithDefaultPrettyPrinter().writeValue(taskWorkspace.resolve("metadata.json").toFile(), metadata);
    }

    private void deleteIfExists(Path path) throws IOException {
        if (!Files.exists(path)) {
            return;
        }
        try (var stream = Files.walk(path)) {
            for (Path item : stream.sorted(Comparator.reverseOrder()).toList()) {
                Files.deleteIfExists(item);
            }
        }
    }

    private void deleteQuietly(Path path) {
        try {
            deleteIfExists(path);
        } catch (IOException ignored) {
        }
    }

    private void ensureUnder(Path root, Path child, String message) {
        Path normalizedRoot = root.toAbsolutePath().normalize();
        Path normalizedChild = child.toAbsolutePath().normalize();
        if (!normalizedChild.startsWith(normalizedRoot)) {
            throw new BusinessException(message);
        }
    }

    public record WorkspacePaths(Path workspacePath, Path repoWorkspacePath, Path logsPath) {
    }
}
