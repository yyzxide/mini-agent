package com.yuzhe.codeagent.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.yuzhe.codeagent.common.BusinessException;
import com.yuzhe.codeagent.domain.AgentGitWorkflow;
import com.yuzhe.codeagent.domain.AgentTask;
import com.yuzhe.codeagent.domain.AgentTaskEvent;
import com.yuzhe.codeagent.domain.AgentTaskLog;
import com.yuzhe.codeagent.dto.CommitChangesRequest;
import com.yuzhe.codeagent.dto.CompleteGitWorkflowRequest;
import com.yuzhe.codeagent.dto.CreateBranchRequest;
import com.yuzhe.codeagent.dto.GeneratePrRequest;
import com.yuzhe.codeagent.dto.GitWorkflowResponse;
import com.yuzhe.codeagent.dto.PrDraftResponse;
import com.yuzhe.codeagent.enums.AgentEventType;
import com.yuzhe.codeagent.enums.AgentExecutionMode;
import com.yuzhe.codeagent.enums.AgentTaskStatus;
import com.yuzhe.codeagent.enums.GitWorkflowStatus;
import com.yuzhe.codeagent.git.CommitMessageGenerator;
import com.yuzhe.codeagent.git.GitCommandExecutor;
import com.yuzhe.codeagent.git.PrDescriptionGenerator;
import com.yuzhe.codeagent.git.PrDescriptionGenerator.PrDescriptionInput;
import com.yuzhe.codeagent.repository.AgentGitWorkflowRepository;
import com.yuzhe.codeagent.repository.AgentTaskEventRepository;
import com.yuzhe.codeagent.repository.AgentTaskLogRepository;
import com.yuzhe.codeagent.repository.AgentTaskRepository;
import java.nio.file.Path;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Service;

@Service
public class GitWorkflowService {

    private final AgentTaskRepository taskRepository;
    private final AgentGitWorkflowRepository workflowRepository;
    private final AgentTaskEventRepository eventRepository;
    private final AgentTaskLogRepository logRepository;
    private final PathSecurityService pathSecurityService;
    private final CommitMessageGenerator commitMessageGenerator;
    private final PrDescriptionGenerator prDescriptionGenerator;
    private final ObjectMapper objectMapper;

    public GitWorkflowService(
            AgentTaskRepository taskRepository,
            AgentGitWorkflowRepository workflowRepository,
            AgentTaskEventRepository eventRepository,
            AgentTaskLogRepository logRepository,
            PathSecurityService pathSecurityService,
            CommitMessageGenerator commitMessageGenerator,
            PrDescriptionGenerator prDescriptionGenerator,
            ObjectMapper objectMapper) {
        this.taskRepository = taskRepository;
        this.workflowRepository = workflowRepository;
        this.eventRepository = eventRepository;
        this.logRepository = logRepository;
        this.pathSecurityService = pathSecurityService;
        this.commitMessageGenerator = commitMessageGenerator;
        this.prDescriptionGenerator = prDescriptionGenerator;
        this.objectMapper = objectMapper;
    }

    public GitWorkflowResponse getWorkflow(Long taskId) {
        requireTask(taskId);
        return workflowRepository.findByTaskId(taskId)
                .map(GitWorkflowResponse::from)
                .orElse(null);
    }

    public GitWorkflowResponse createBranch(Long taskId, CreateBranchRequest request) {
        AgentTask task = requireCompletedTask(taskId);
        GitCommandExecutor git = gitForTask(task);
        ensureHasDiff(task, git);
        AgentGitWorkflow workflow = getOrCreateWorkflow(task, git);

        if (workflow.getWorkBranch() != null && !workflow.getWorkBranch().isBlank()) {
            String requested = normalizeBlank(request == null ? null : request.getBranchName());
            if (requested != null && !requested.equals(workflow.getWorkBranch())) {
                throw new BusinessException("Git workflow branch already created: " + workflow.getWorkBranch());
            }
            return GitWorkflowResponse.from(workflow);
        }

        String branchName = normalizeBlank(request == null ? null : request.getBranchName());
        if (branchName == null) {
            branchName = defaultBranchName(taskId);
        }

        appendEvent(taskId, AgentEventType.GIT_BRANCH_CREATE_STARTED, Map.of("workBranch", branchName));
        try {
            workflow.setBaseBranch(git.currentBranch());
            workflow.setBaseCommit(git.currentCommit());
            workflow.setWorkBranch(branchName);
            workflowRepository.save(workflow);

            git.createBranch(branchName);
            git.checkoutBranch(branchName);

            workflow.setStatus(GitWorkflowStatus.BRANCH_CREATED);
            workflow.setErrorMessage(null);
            workflow = workflowRepository.save(workflow);
            appendLog(taskId, "stdout", "Created git branch: " + branchName);
            appendEvent(taskId, AgentEventType.GIT_BRANCH_CREATED, Map.of(
                    "baseBranch", nullToEmpty(workflow.getBaseBranch()),
                    "workBranch", branchName,
                    "baseCommit", nullToEmpty(workflow.getBaseCommit())));
            return GitWorkflowResponse.from(workflow);
        } catch (RuntimeException exception) {
            markFailed(taskId, workflow, exception.getMessage());
            throw exception;
        }
    }

    public GitWorkflowResponse commitChanges(Long taskId, CommitChangesRequest request) {
        AgentTask task = requireCompletedTask(taskId);
        GitCommandExecutor git = gitForTask(task);
        AgentGitWorkflow workflow = requireWorkflow(taskId);

        if (workflow.getWorkBranch() == null || workflow.getWorkBranch().isBlank()) {
            throw new BusinessException("Create a git workflow branch before committing");
        }
        if (workflow.getCommitHash() != null && !workflow.getCommitHash().isBlank()) {
            throw new BusinessException("Git workflow already committed: " + workflow.getCommitHash());
        }

        try {
            if (!workflow.getWorkBranch().equals(git.currentBranch())) {
                git.checkoutBranch(workflow.getWorkBranch());
            }
            ensureHasDiff(task, git);
            List<String> changedFiles = git.changedFiles();
            String commitMessage = normalizeBlank(request == null ? null : request.getCommitMessage());
            if (commitMessage == null) {
                commitMessage = commitMessageGenerator.generate(task.getUserGoal(), changedFiles);
            }

            appendEvent(taskId, AgentEventType.GIT_COMMIT_STARTED, Map.of("commitMessage", commitMessage));
            String commitHash = git.commit(commitMessage);
            workflow.setCommitHash(commitHash);
            workflow.setCommitMessage(commitMessage);
            workflow.setStatus(GitWorkflowStatus.COMMITTED);
            workflow.setErrorMessage(null);
            workflow = workflowRepository.save(workflow);
            appendLog(taskId, "stdout", "Committed git workflow changes: " + commitHash);
            appendEvent(taskId, AgentEventType.GIT_COMMITTED, Map.of(
                    "commitHash", commitHash,
                    "commitMessage", commitMessage));
            return GitWorkflowResponse.from(workflow);
        } catch (RuntimeException exception) {
            markFailed(taskId, workflow, exception.getMessage());
            throw exception;
        }
    }

    public PrDraftResponse generatePrDraft(Long taskId, GeneratePrRequest request) {
        AgentTask task = requireCompletedTask(taskId);
        GitCommandExecutor git = gitForTask(task);
        AgentGitWorkflow workflow = requireWorkflow(taskId);
        String sourceBranch = workflow.getWorkBranch() == null || workflow.getWorkBranch().isBlank()
                ? git.currentBranch()
                : workflow.getWorkBranch();
        String targetBranch = normalizeBlank(request == null ? null : request.getTargetBranch());
        if (targetBranch == null) {
            targetBranch = workflow.getBaseBranch() == null || workflow.getBaseBranch().isBlank() ? "main" : workflow.getBaseBranch();
        }

        try {
            String range = workflow.getBaseCommit() != null && workflow.getCommitHash() != null
                    ? workflow.getBaseCommit() + ".." + workflow.getCommitHash()
                    : null;
            List<String> changedFiles = range == null ? git.changedFiles() : git.changedFiles(range);
            String diffSummary = range == null ? git.gitDiffStat().stdout() : git.gitDiffStat(range).stdout();
            String commitMessage = workflow.getCommitMessage();
            if (commitMessage == null || commitMessage.isBlank()) {
                commitMessage = commitMessageGenerator.generate(task.getUserGoal(), changedFiles);
            }

            PrDraftResponse draft = prDescriptionGenerator.generate(new PrDescriptionInput(
                    task.getUserGoal(),
                    changedFiles,
                    diffSummary,
                    task.getFinalSummary(),
                    commitMessage,
                    sourceBranch,
                    targetBranch));

            workflow.setPrTitle(draft.getTitle());
            workflow.setPrDescription(draft.getDescription());
            workflow.setStatus(GitWorkflowStatus.PR_DRAFT_GENERATED);
            workflow.setErrorMessage(null);
            workflowRepository.save(workflow);
            appendLog(taskId, "stdout", "Generated PR draft for branch: " + sourceBranch);
            appendEvent(taskId, AgentEventType.PR_DRAFT_GENERATED, Map.of(
                    "title", draft.getTitle(),
                    "sourceBranch", sourceBranch,
                    "targetBranch", targetBranch));
            return draft;
        } catch (RuntimeException exception) {
            markFailed(taskId, workflow, exception.getMessage());
            throw exception;
        }
    }

    public PrDraftResponse completeWorkflow(Long taskId, CompleteGitWorkflowRequest request) {
        AgentGitWorkflow workflow = workflowRepository.findByTaskId(taskId).orElse(null);
        if (workflow == null || workflow.getWorkBranch() == null || workflow.getWorkBranch().isBlank()) {
            CreateBranchRequest branchRequest = new CreateBranchRequest();
            branchRequest.setBranchName(request == null ? null : request.getBranchName());
            createBranch(taskId, branchRequest);
        }

        workflow = requireWorkflow(taskId);
        if (workflow.getCommitHash() == null || workflow.getCommitHash().isBlank()) {
            CommitChangesRequest commitRequest = new CommitChangesRequest();
            commitRequest.setCommitMessage(request == null ? null : request.getCommitMessage());
            commitChanges(taskId, commitRequest);
        }

        GeneratePrRequest prRequest = new GeneratePrRequest();
        prRequest.setTargetBranch(request == null ? null : request.getTargetBranch());
        return generatePrDraft(taskId, prRequest);
    }

    private AgentGitWorkflow getOrCreateWorkflow(AgentTask task, GitCommandExecutor git) {
        return workflowRepository.findByTaskId(task.getId()).orElseGet(() -> {
            AgentGitWorkflow workflow = new AgentGitWorkflow();
            workflow.setTaskId(task.getId());
            workflow.setRepoPath(task.getRepoPath());
            workflow.setWorkspaceRepoPath(task.getExecutionMode() == AgentExecutionMode.DOCKER ? git.repoPath().toString() : null);
            workflow.setBaseBranch(git.currentBranch());
            workflow.setBaseCommit(git.currentCommit());
            workflow.setStatus(GitWorkflowStatus.CREATED);
            return workflowRepository.save(workflow);
        });
    }

    private AgentGitWorkflow requireWorkflow(Long taskId) {
        return workflowRepository.findByTaskId(taskId)
                .orElseThrow(() -> new BusinessException("Git workflow not found for task: " + taskId));
    }

    private GitCommandExecutor gitForTask(AgentTask task) {
        Path repoPath = pathSecurityService.resolveTaskRepoPath(task);
        return new GitCommandExecutor(repoPath);
    }

    private void ensureHasDiff(AgentTask task, GitCommandExecutor git) {
        if (!git.hasChanges()) {
            throw new BusinessException("Task has no git diff to commit");
        }
    }

    private AgentTask requireCompletedTask(Long taskId) {
        AgentTask task = requireTask(taskId);
        if (task.getStatus() != AgentTaskStatus.COMPLETED) {
            throw new BusinessException("Task is not completed: " + taskId);
        }
        return task;
    }

    private AgentTask requireTask(Long taskId) {
        return taskRepository.findById(taskId)
                .orElseThrow(() -> new BusinessException("Task not found: " + taskId));
    }

    private String defaultBranchName(Long taskId) {
        return "agent/task-" + taskId + "-" + LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMMddHHmmss"));
    }

    private void markFailed(Long taskId, AgentGitWorkflow workflow, String message) {
        workflow.setStatus(GitWorkflowStatus.FAILED);
        workflow.setErrorMessage(message);
        workflowRepository.save(workflow);
        appendLog(taskId, "stderr", "Git workflow failed: " + message);
        appendEvent(taskId, AgentEventType.GIT_WORKFLOW_FAILED, Map.of("error", message == null ? "" : message));
    }

    private void appendLog(Long taskId, String streamType, String content) {
        AgentTaskLog log = new AgentTaskLog();
        log.setTaskId(taskId);
        log.setStreamType(streamType);
        log.setContent(content);
        logRepository.save(log);
    }

    private void appendEvent(Long taskId, AgentEventType eventType, Map<String, ?> payload) {
        AgentTaskEvent event = new AgentTaskEvent();
        event.setTaskId(taskId);
        event.setEventType(eventType);
        event.setPayload(toJson(payload));
        eventRepository.save(event);
    }

    private String toJson(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (Exception exception) {
            return "{}";
        }
    }

    private String normalizeBlank(String value) {
        if (value == null || value.trim().isEmpty()) {
            return null;
        }
        return value.trim();
    }

    private String nullToEmpty(String value) {
        return value == null ? "" : value;
    }
}
