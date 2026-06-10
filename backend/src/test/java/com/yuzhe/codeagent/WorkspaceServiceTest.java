package com.yuzhe.codeagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.yuzhe.codeagent.common.BusinessException;
import com.yuzhe.codeagent.config.CodeAgentProperties;
import com.yuzhe.codeagent.service.PathSecurityService;
import com.yuzhe.codeagent.service.WorkspaceService;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class WorkspaceServiceTest {

    @TempDir
    Path tempDir;

    @Test
    void createsWorkspaceCopiesRepoAndExcludesHeavyDirectories() throws Exception {
        Path sourceRepo = Files.createDirectories(tempDir.resolve("source"));
        Files.writeString(sourceRepo.resolve("README.md"), "hello");
        Files.createDirectories(sourceRepo.resolve(".git"));
        Files.writeString(sourceRepo.resolve(".git/HEAD"), "ref: refs/heads/main");
        Files.createDirectories(sourceRepo.resolve("node_modules/pkg"));
        Files.writeString(sourceRepo.resolve("node_modules/pkg/index.js"), "ignored");
        Files.createDirectories(sourceRepo.resolve("target"));
        Files.writeString(sourceRepo.resolve("target/out.txt"), "ignored");
        Files.createDirectories(sourceRepo.resolve("dist"));
        Files.createDirectories(sourceRepo.resolve("build"));
        Files.createDirectories(sourceRepo.resolve(".mini-agent"));
        Files.createDirectories(sourceRepo.resolve(".idea"));
        Files.createDirectories(sourceRepo.resolve(".vscode"));

        WorkspaceService service = new WorkspaceService(properties(), new ObjectMapper());

        WorkspaceService.WorkspacePaths paths = service.createWorkspace(7L, sourceRepo);

        assertThat(paths.workspacePath()).isDirectory();
        assertThat(paths.repoWorkspacePath().resolve("README.md")).hasContent("hello");
        assertThat(paths.repoWorkspacePath().resolve(".git/HEAD")).exists();
        assertThat(paths.repoWorkspacePath().resolve("node_modules")).doesNotExist();
        assertThat(paths.repoWorkspacePath().resolve("target")).doesNotExist();
        assertThat(paths.repoWorkspacePath().resolve("dist")).doesNotExist();
        assertThat(paths.repoWorkspacePath().resolve("build")).doesNotExist();
        assertThat(paths.repoWorkspacePath().resolve(".mini-agent")).doesNotExist();
        assertThat(paths.repoWorkspacePath().resolve(".idea")).doesNotExist();
        assertThat(paths.repoWorkspacePath().resolve(".vscode")).doesNotExist();
        assertThat(paths.workspacePath().resolve("metadata.json")).exists();
    }

    @Test
    void rejectsSandboxWorkspaceOutsideRoot() throws Exception {
        CodeAgentProperties properties = properties();
        Files.createDirectories(Path.of(properties.getSandbox().getWorkspaceRoot()));
        PathSecurityService pathSecurityService = new PathSecurityService(properties);
        Path outside = Files.createDirectory(tempDir.resolve("outside"));

        assertThatThrownBy(() -> pathSecurityService.validateSandboxWorkspacePath(outside.toString()))
                .isInstanceOf(BusinessException.class)
                .hasMessageContaining("outside sandbox workspace-root");
    }

    private CodeAgentProperties properties() {
        CodeAgentProperties properties = new CodeAgentProperties();
        properties.getSandbox().setWorkspaceRoot(tempDir.resolve("sandboxes").toString());
        return properties;
    }
}
