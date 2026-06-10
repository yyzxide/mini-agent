package com.yuzhe.codeagent.git;

import com.yuzhe.codeagent.common.BusinessException;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

public class GitCommandExecutor {

    private static final long TIMEOUT_SECONDS = 60;
    private final Path repoPath;

    public GitCommandExecutor(Path repoPath) {
        this.repoPath = repoPath.toAbsolutePath().normalize();
        validateRepository();
    }

    public GitCommandResult gitStatus() {
        return run(List.of("status", "--short"));
    }

    public GitCommandResult gitDiff() {
        return run(List.of("diff"));
    }

    public GitCommandResult gitDiff(String range) {
        if (range == null || range.isBlank()) {
            return gitDiff();
        }
        return run(List.of("diff", range));
    }

    public GitCommandResult gitDiffStat() {
        return run(List.of("diff", "--shortstat"));
    }

    public GitCommandResult gitDiffStat(String range) {
        if (range == null || range.isBlank()) {
            return gitDiffStat();
        }
        return run(List.of("diff", "--shortstat", range));
    }

    public String currentBranch() {
        return run(List.of("branch", "--show-current")).stdout().trim();
    }

    public String currentCommit() {
        return run(List.of("rev-parse", "HEAD")).stdout().trim();
    }

    public void createBranch(String branchName) {
        validateBranchName(branchName);
        if (branchExists(branchName)) {
            throw new BusinessException("Branch already exists: " + branchName);
        }
        run(List.of("branch", branchName));
    }

    public void checkoutBranch(String branchName) {
        validateBranchName(branchName);
        run(List.of("checkout", branchName));
    }

    public void addAll() {
        run(List.of("add", "-A"));
    }

    public String commit(String message) {
        if (message == null || message.trim().isEmpty()) {
            throw new BusinessException("Commit message cannot be empty");
        }
        if (!hasChanges()) {
            throw new BusinessException("No changes to commit");
        }
        addAll();
        run(List.of("commit", "-m", message.trim()));
        return getCommitHash();
    }

    public String getCommitHash() {
        return currentCommit();
    }

    public List<String> changedFiles() {
        List<String> files = new ArrayList<>();
        files.addAll(readLines(run(List.of("diff", "--name-only")).stdout()));
        files.addAll(readLines(run(List.of("diff", "--cached", "--name-only")).stdout()));
        return files.stream().distinct().sorted().toList();
    }

    public List<String> changedFiles(String range) {
        if (range == null || range.isBlank()) {
            return changedFiles();
        }
        return readLines(run(List.of("diff", "--name-only", range)).stdout()).stream().distinct().sorted().toList();
    }

    public boolean hasChanges() {
        return !gitStatus().stdout().trim().isEmpty();
    }

    public boolean branchExists(String branchName) {
        validateBranchName(branchName);
        GitCommandResult result = runRaw(List.of("show-ref", "--verify", "--quiet", "refs/heads/" + branchName));
        return result.exitCode() == 0;
    }

    public Path repoPath() {
        return repoPath;
    }

    private void validateRepository() {
        if (!Files.isDirectory(repoPath)) {
            throw new BusinessException("Git repo path is not a directory: " + repoPath);
        }
        GitCommandResult result = runRaw(List.of("rev-parse", "--is-inside-work-tree"));
        if (result.exitCode() != 0 || !"true".equals(result.stdout().trim())) {
            throw new BusinessException("Path is not a git repository: " + repoPath);
        }
    }

    private void validateBranchName(String branchName) {
        if (branchName == null
                || !branchName.matches("^[A-Za-z0-9][A-Za-z0-9_./-]{0,127}$")
                || branchName.contains("..")
                || branchName.endsWith("/")
                || branchName.contains("@{")) {
            throw new BusinessException("Invalid branch name: " + branchName);
        }
    }

    private GitCommandResult run(List<String> args) {
        GitCommandResult result = runRaw(args);
        if (result.exitCode() != 0) {
            throw new BusinessException("git " + String.join(" ", args) + " failed: " + result.stderrOrStdout());
        }
        return result;
    }

    private GitCommandResult runRaw(List<String> args) {
        List<String> command = new ArrayList<>();
        command.add("git");
        command.addAll(args);
        try {
            Process process = new ProcessBuilder(command)
                    .directory(repoPath.toFile())
                    .start();
            boolean exited = process.waitFor(TIMEOUT_SECONDS, TimeUnit.SECONDS);
            if (!exited) {
                process.destroyForcibly();
                throw new BusinessException("Git command timed out: git " + String.join(" ", args));
            }
            String stdout = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
            String stderr = new String(process.getErrorStream().readAllBytes(), StandardCharsets.UTF_8);
            return new GitCommandResult(command, process.exitValue(), stdout, stderr);
        } catch (IOException exception) {
            throw new BusinessException("Failed to run git command", exception);
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            throw new BusinessException("Git command interrupted", exception);
        }
    }

    private List<String> readLines(String value) {
        return value.lines().map(String::trim).filter(line -> !line.isBlank()).toList();
    }

    public record GitCommandResult(List<String> command, int exitCode, String stdout, String stderr) {

        public String stderrOrStdout() {
            return stderr == null || stderr.isBlank() ? stdout : stderr;
        }
    }
}
