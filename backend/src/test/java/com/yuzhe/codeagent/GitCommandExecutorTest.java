package com.yuzhe.codeagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.yuzhe.codeagent.common.BusinessException;
import com.yuzhe.codeagent.git.GitCommandExecutor;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class GitCommandExecutorTest {

    @TempDir
    Path tempDir;

    @Test
    void readsBranchCommitCreatesAndChecksOutBranch() throws Exception {
        Path repo = createRepository("repo");
        GitCommandExecutor git = new GitCommandExecutor(repo);
        String baseBranch = git.currentBranch();
        String baseCommit = git.currentCommit();

        git.createBranch("agent/test-branch");
        git.checkoutBranch("agent/test-branch");

        assertThat(baseBranch).isNotBlank();
        assertThat(baseCommit).hasSize(40);
        assertThat(git.currentBranch()).isEqualTo("agent/test-branch");
    }

    @Test
    void detectsChangedFilesAndCommitsChanges() throws Exception {
        Path repo = createRepository("repo");
        Files.writeString(repo.resolve("demo.txt"), "changed\n");
        GitCommandExecutor git = new GitCommandExecutor(repo);

        assertThat(git.changedFiles()).containsExactly("demo.txt");
        assertThat(git.hasChanges()).isTrue();

        String commitHash = git.commit("feat(agent): update demo");

        assertThat(commitHash).hasSize(40);
        assertThat(git.hasChanges()).isFalse();
    }

    @Test
    void rejectsInvalidBranchName() throws Exception {
        Path repo = createRepository("repo");
        GitCommandExecutor git = new GitCommandExecutor(repo);

        assertThatThrownBy(() -> git.createBranch("bad;branch"))
                .isInstanceOf(BusinessException.class)
                .hasMessageContaining("Invalid branch name");
    }

    @Test
    void rejectsCommitWithoutChanges() throws Exception {
        Path repo = createRepository("repo");
        GitCommandExecutor git = new GitCommandExecutor(repo);

        assertThatThrownBy(() -> git.commit("feat(agent): no changes"))
                .isInstanceOf(BusinessException.class)
                .hasMessageContaining("No changes to commit");
    }

    private Path createRepository(String name) throws Exception {
        Path repo = Files.createDirectory(tempDir.resolve(name));
        run(repo, "git", "init");
        run(repo, "git", "config", "user.email", "mini-agent@example.com");
        run(repo, "git", "config", "user.name", "Mini Agent");
        Files.writeString(repo.resolve("demo.txt"), "initial\n");
        run(repo, "git", "add", "demo.txt");
        run(repo, "git", "commit", "-m", "init");
        return repo.toRealPath();
    }

    private void run(Path cwd, String... command) throws Exception {
        Process process = new ProcessBuilder(command)
                .directory(cwd.toFile())
                .start();
        int exitCode = process.waitFor();
        if (exitCode != 0) {
            throw new IllegalStateException(new String(process.getErrorStream().readAllBytes()));
        }
    }
}
