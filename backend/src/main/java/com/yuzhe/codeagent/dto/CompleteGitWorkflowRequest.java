package com.yuzhe.codeagent.dto;

import lombok.Getter;
import lombok.Setter;

@Getter
@Setter
public class CompleteGitWorkflowRequest {

    private String branchName;
    private String commitMessage;
    private String targetBranch;
}
