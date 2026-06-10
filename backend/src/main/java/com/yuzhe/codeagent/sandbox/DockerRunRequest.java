package com.yuzhe.codeagent.sandbox;

import lombok.Builder;
import lombok.Getter;

@Getter
@Builder
public class DockerRunRequest {

    private Long taskId;
    private String image;
    private String containerName;
    private String repoWorkspacePath;
    private String runnerHostPath;
    private String runnerMountPath;
    private String userGoal;
    private boolean useRealModel;
    private boolean autoApprove;
    private int maxSteps;
    private String cpuLimit;
    private String memoryLimit;
    private boolean networkEnabled;
    private boolean autoRemoveContainer;
    private String containerWorkdir;
}
