package com.yuzhe.codeagent.controller;

import com.yuzhe.codeagent.common.ApiResponse;
import com.yuzhe.codeagent.dto.CommitChangesRequest;
import com.yuzhe.codeagent.dto.CompleteGitWorkflowRequest;
import com.yuzhe.codeagent.dto.CreateBranchRequest;
import com.yuzhe.codeagent.dto.GeneratePrRequest;
import com.yuzhe.codeagent.dto.GitWorkflowResponse;
import com.yuzhe.codeagent.dto.PrDraftResponse;
import com.yuzhe.codeagent.service.GitWorkflowService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/agent/tasks/{taskId}/git")
public class GitWorkflowController {

    private final GitWorkflowService gitWorkflowService;

    public GitWorkflowController(GitWorkflowService gitWorkflowService) {
        this.gitWorkflowService = gitWorkflowService;
    }

    @GetMapping("/workflow")
    public ApiResponse<GitWorkflowResponse> getWorkflow(@PathVariable Long taskId) {
        return ApiResponse.ok(gitWorkflowService.getWorkflow(taskId));
    }

    @PostMapping("/branch")
    public ApiResponse<GitWorkflowResponse> createBranch(
            @PathVariable Long taskId,
            @RequestBody(required = false) CreateBranchRequest request) {
        return ApiResponse.ok(gitWorkflowService.createBranch(taskId, request));
    }

    @PostMapping("/commit")
    public ApiResponse<GitWorkflowResponse> commitChanges(
            @PathVariable Long taskId,
            @RequestBody(required = false) CommitChangesRequest request) {
        return ApiResponse.ok(gitWorkflowService.commitChanges(taskId, request));
    }

    @PostMapping("/pr-draft")
    public ApiResponse<PrDraftResponse> generatePrDraft(
            @PathVariable Long taskId,
            @RequestBody(required = false) GeneratePrRequest request) {
        return ApiResponse.ok(gitWorkflowService.generatePrDraft(taskId, request));
    }

    @PostMapping("/complete")
    public ApiResponse<PrDraftResponse> completeWorkflow(
            @PathVariable Long taskId,
            @RequestBody(required = false) CompleteGitWorkflowRequest request) {
        return ApiResponse.ok(gitWorkflowService.completeWorkflow(taskId, request));
    }
}
