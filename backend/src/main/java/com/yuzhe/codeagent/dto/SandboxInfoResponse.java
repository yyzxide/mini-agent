package com.yuzhe.codeagent.dto;

import com.yuzhe.codeagent.domain.AgentSandbox;
import com.yuzhe.codeagent.enums.SandboxStatus;
import java.time.LocalDateTime;
import lombok.Builder;
import lombok.Getter;

@Getter
@Builder
public class SandboxInfoResponse {

    private Long id;
    private Long taskId;
    private String containerId;
    private String containerName;
    private String image;
    private String workspacePath;
    private String repoWorkspacePath;
    private SandboxStatus status;
    private String cpuLimit;
    private String memoryLimit;
    private Boolean networkEnabled;
    private LocalDateTime startedAt;
    private LocalDateTime finishedAt;
    private String errorMessage;

    public static SandboxInfoResponse from(AgentSandbox sandbox) {
        if (sandbox == null) {
            return null;
        }
        return SandboxInfoResponse.builder()
                .id(sandbox.getId())
                .taskId(sandbox.getTaskId())
                .containerId(sandbox.getContainerId())
                .containerName(sandbox.getContainerName())
                .image(sandbox.getImage())
                .workspacePath(sandbox.getWorkspacePath())
                .repoWorkspacePath(sandbox.getRepoWorkspacePath())
                .status(sandbox.getStatus())
                .cpuLimit(sandbox.getCpuLimit())
                .memoryLimit(sandbox.getMemoryLimit())
                .networkEnabled(sandbox.getNetworkEnabled())
                .startedAt(sandbox.getStartedAt())
                .finishedAt(sandbox.getFinishedAt())
                .errorMessage(sandbox.getErrorMessage())
                .build();
    }
}
