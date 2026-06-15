package com.yuzhe.codeagent.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Positive;
import com.yuzhe.codeagent.enums.AgentExecutionMode;
import lombok.Getter;
import lombok.Setter;

@Getter
@Setter
public class CreateAgentTaskRequest {

    @NotBlank
    private String repoPath;

    @NotBlank
    private String userGoal;

    @Positive
    private Integer maxSteps;

    private AgentExecutionMode executionMode;
}
