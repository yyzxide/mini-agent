package com.yuzhe.codeagent;

import static org.assertj.core.api.Assertions.assertThat;

import com.yuzhe.codeagent.sandbox.DockerCommandBuilder;
import com.yuzhe.codeagent.sandbox.DockerRunRequest;
import org.junit.jupiter.api.Test;

class DockerCommandBuilderTest {

    @Test
    void buildsDockerRunCommandWithLimitsNetworkNoneMountsAndMockRunner() {
        DockerCommandBuilder builder = new DockerCommandBuilder();

        var command = builder.buildCommand(baseRequest(false, true));

        assertThat(command)
                .containsSubsequence("docker", "run", "--name", "mini-agent-task-1")
                .containsSubsequence("--cpus", "2")
                .containsSubsequence("--memory", "2g")
                .containsSubsequence("--network", "none")
                .containsSubsequence("-v", "/tmp/workspace/repo:/workspace")
                .containsSubsequence("-v", "/tmp/mini-agent:/opt/mini-agent:ro")
                .containsSubsequence("-w", "/workspace", "mini-coding-agent-sandbox:latest")
                .containsSubsequence("node", "/opt/mini-agent/dist/cli/index.js", "run", "给 demo.txt 增加 hello")
                .contains("--mock", "--yes", "--event-stream")
                .containsSubsequence("--max-steps", "20");
    }

    @Test
    void buildsRealModelCommandWithoutNetworkNoneWhenEnabled() {
        DockerCommandBuilder builder = new DockerCommandBuilder();

        var command = builder.buildCommand(baseRequest(true, false));

        assertThat(command).contains("--real").doesNotContain("--mock", "--yes", "--network", "none");
    }

    private DockerRunRequest baseRequest(boolean useRealModel, boolean autoApprove) {
        return DockerRunRequest.builder()
                .taskId(1L)
                .image("mini-coding-agent-sandbox:latest")
                .containerName("mini-agent-task-1")
                .repoWorkspacePath("/tmp/workspace/repo")
                .runnerHostPath("/tmp/mini-agent")
                .runnerMountPath("/opt/mini-agent")
                .userGoal("给 demo.txt 增加 hello")
                .useRealModel(useRealModel)
                .autoApprove(autoApprove)
                .maxSteps(20)
                .cpuLimit("2")
                .memoryLimit("2g")
                .networkEnabled(useRealModel)
                .autoRemoveContainer(true)
                .containerWorkdir("/workspace")
                .build();
    }
}
