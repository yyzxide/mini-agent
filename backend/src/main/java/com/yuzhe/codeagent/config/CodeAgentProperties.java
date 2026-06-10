package com.yuzhe.codeagent.config;

import com.yuzhe.codeagent.enums.AgentExecutionMode;
import lombok.Getter;
import lombok.Setter;
import org.springframework.boot.context.properties.ConfigurationProperties;

@Getter
@Setter
@ConfigurationProperties(prefix = "code-agent")
public class CodeAgentProperties {

    private String runnerPath = "../dist/cli/index.js";
    private String nodePath = "node";
    private String workspaceRoot = "../";
    private int defaultMaxSteps = 20;
    private int defaultTimeoutSeconds = 600;
    private AgentExecutionMode executionMode = AgentExecutionMode.DOCKER;
    private Sandbox sandbox = new Sandbox();

    @Getter
    @Setter
    public static class Sandbox {

        private boolean enabled = true;
        private String dockerImage = "mini-coding-agent-sandbox:latest";
        private String workspaceRoot = "./data/workspaces";
        private String containerWorkdir = "/workspace";
        private String cpuLimit = "2";
        private String memoryLimit = "2g";
        private boolean networkEnabled = false;
        private boolean autoRemoveContainer = true;
        private int containerTimeoutSeconds = 600;
        private String runnerMountPath = "/opt/mini-agent";
        private String runnerHostPath = "../";
    }
}
