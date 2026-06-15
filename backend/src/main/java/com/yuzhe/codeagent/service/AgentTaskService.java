package com.yuzhe.codeagent.service;

import com.yuzhe.codeagent.common.BusinessException;
import com.yuzhe.codeagent.config.CodeAgentProperties;
import com.yuzhe.codeagent.domain.AgentSandbox;
import com.yuzhe.codeagent.domain.AgentTask;
import com.yuzhe.codeagent.domain.AgentTaskEvent;
import com.yuzhe.codeagent.domain.AgentTaskLog;
import com.yuzhe.codeagent.dto.AgentTaskEventResponse;
import com.yuzhe.codeagent.dto.AgentTaskLogResponse;
import com.yuzhe.codeagent.dto.AgentTaskResponse;
import com.yuzhe.codeagent.dto.CreateAgentTaskRequest;
import com.yuzhe.codeagent.dto.SandboxInfoResponse;
import com.yuzhe.codeagent.enums.AgentExecutionMode;
import com.yuzhe.codeagent.enums.AgentTaskStatus;
import com.yuzhe.codeagent.repository.AgentSandboxRepository;
import com.yuzhe.codeagent.repository.AgentTaskEventRepository;
import com.yuzhe.codeagent.repository.AgentTaskLogRepository;
import com.yuzhe.codeagent.repository.AgentTaskRepository;
import com.yuzhe.codeagent.service.WorkspaceService.WorkspacePaths;
import com.fasterxml.jackson.databind.JsonNode;
import java.nio.file.Path;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Service;

@Service
public class AgentTaskService {

    private final AgentTaskRepository taskRepository;
    private final AgentTaskEventRepository eventRepository;
    private final AgentTaskLogRepository logRepository;
    private final RunnerProcessService runnerProcessService;
    private final DockerSandboxService dockerSandboxService;
    private final WorkspaceService workspaceService;
    private final AgentSandboxRepository sandboxRepository;
    private final SessionReadService sessionReadService;
    private final EventReadService eventReadService;
    private final PathSecurityService pathSecurityService;
    private final CodeAgentProperties properties;

    public AgentTaskService(
            AgentTaskRepository taskRepository,
            AgentTaskEventRepository eventRepository,
            AgentTaskLogRepository logRepository,
            RunnerProcessService runnerProcessService,
            DockerSandboxService dockerSandboxService,
            WorkspaceService workspaceService,
            AgentSandboxRepository sandboxRepository,
            SessionReadService sessionReadService,
            EventReadService eventReadService,
            PathSecurityService pathSecurityService,
            CodeAgentProperties properties) {
        this.taskRepository = taskRepository;
        this.eventRepository = eventRepository;
        this.logRepository = logRepository;
        this.runnerProcessService = runnerProcessService;
        this.dockerSandboxService = dockerSandboxService;
        this.workspaceService = workspaceService;
        this.sandboxRepository = sandboxRepository;
        this.sessionReadService = sessionReadService;
        this.eventReadService = eventReadService;
        this.pathSecurityService = pathSecurityService;
        this.properties = properties;
    }

    public AgentTaskResponse createAndStart(CreateAgentTaskRequest request) {
        Path repo = pathSecurityService.validateRepoPath(request.getRepoPath());
        AgentExecutionMode executionMode = request.getExecutionMode() == null ? properties.getExecutionMode() : request.getExecutionMode();
        AgentTask task = new AgentTask();
        task.setTaskNo(createTaskNo());
        task.setRepoPath(repo.toString());
        task.setSourceRepoPath(repo.toString());
        task.setExecutionMode(executionMode);
        task.setUserGoal(request.getUserGoal());
        task.setStatus(AgentTaskStatus.CREATED);
        task.setMaxSteps(request.getMaxSteps() == null ? properties.getDefaultMaxSteps() : request.getMaxSteps());

        AgentTask saved = taskRepository.save(task);
        try {
            if (executionMode == AgentExecutionMode.DOCKER) {
                WorkspacePaths workspacePaths = workspaceService.createWorkspace(saved.getId(), repo);
                saved.setWorkspacePath(workspacePaths.workspacePath().toString());
                saved = taskRepository.save(saved);
                dockerSandboxService.startTask(saved);
            } else {
                runnerProcessService.startTask(saved);
            }
            return responseFor(requireTask(saved.getId()));
        } catch (RuntimeException exception) {
            markFailed(saved.getId(), exception.getMessage());
            throw exception;
        }
    }

    public List<AgentTaskResponse> listTasks(AgentTaskStatus status, String repoPath) {
        List<AgentTask> tasks;
        if (status != null && repoPath != null && !repoPath.isBlank()) {
            tasks = taskRepository.findByStatusAndRepoPathOrderByCreatedAtDesc(status, pathSecurityService.validateRepoPath(repoPath).toString());
        } else if (status != null) {
            tasks = taskRepository.findByStatusOrderByCreatedAtDesc(status);
        } else if (repoPath != null && !repoPath.isBlank()) {
            tasks = taskRepository.findByRepoPathOrderByCreatedAtDesc(pathSecurityService.validateRepoPath(repoPath).toString());
        } else {
            tasks = taskRepository.findAllByOrderByCreatedAtDesc();
        }
        return tasks.stream().map(this::responseFor).toList();
    }

    public AgentTaskResponse getTask(Long id) {
        return responseFor(requireTask(id));
    }

    public List<AgentTaskEventResponse> getEvents(Long id) {
        requireTask(id);
        return eventRepository.findByTaskIdOrderByCreatedAtAsc(id).stream()
                .map(AgentTaskEventResponse::from)
                .toList();
    }

    public List<AgentTaskLogResponse> getLogs(Long id) {
        requireTask(id);
        return logRepository.findByTaskIdOrderByCreatedAtAsc(id).stream()
                .map(AgentTaskLogResponse::from)
                .toList();
    }

    public String getDiff(Long id) {
        AgentTask task = requireTask(id);
        return task.getFinalDiff() == null ? "" : task.getFinalDiff();
    }

    public SandboxInfoResponse getSandbox(Long id) {
        requireTask(id);
        return SandboxInfoResponse.from(sandboxRepository.findByTaskId(id)
                .orElseThrow(() -> new BusinessException("Sandbox not found for task: " + id)));
    }

    public List<JsonNode> getSessionRecords(Long id) {
        AgentTask task = requireTask(id);
        if (task.getSessionId() == null) {
            return List.of();
        }
        return sessionReadService.readSessionRecords(task, task.getSessionId());
    }

    public List<JsonNode> getSessionEvents(Long id, Integer limit) {
        AgentTask task = requireTask(id);
        if (task.getSessionId() == null) {
            return List.of();
        }
        if (limit != null) {
            return eventReadService.tailEvents(task, task.getSessionId(), limit);
        }
        return eventReadService.readEvents(task, task.getSessionId());
    }

    public AgentTaskResponse cancel(Long id) {
        AgentTask task = requireTask(id);
        if (task.getStatus() == AgentTaskStatus.COMPLETED
                || task.getStatus() == AgentTaskStatus.FAILED
                || task.getStatus() == AgentTaskStatus.CANCELLED) {
            throw new BusinessException("Task already finished");
        }
        if (task.getExecutionMode() == AgentExecutionMode.DOCKER) {
            dockerSandboxService.cancelTask(id);
        } else {
            runnerProcessService.cancelTask(id);
        }
        task = requireTask(id);
        task.setStatus(AgentTaskStatus.CANCELLED);
        task.setFinishedAt(LocalDateTime.now());
        taskRepository.save(task);
        return responseFor(requireTask(id));
    }

    public AgentTask requireTask(Long id) {
        return taskRepository.findById(id)
                .orElseThrow(() -> new BusinessException("Task not found: " + id));
    }

    public AgentTaskResponse updateStatus(Long id, AgentTaskStatus status) {
        AgentTask task = requireTask(id);
        task.setStatus(status);
        if (status == AgentTaskStatus.COMPLETED || status == AgentTaskStatus.FAILED || status == AgentTaskStatus.CANCELLED) {
            task.setFinishedAt(LocalDateTime.now());
        }
        return responseFor(taskRepository.save(task));
    }

    private AgentTaskResponse responseFor(AgentTask task) {
        AgentSandbox sandbox = sandboxRepository.findByTaskId(task.getId()).orElse(null);
        return AgentTaskResponse.from(task, sandbox);
    }

    private void markFailed(Long taskId, String message) {
        AgentTask task = requireTask(taskId);
        task.setStatus(AgentTaskStatus.FAILED);
        task.setErrorMessage(message);
        task.setFinishedAt(LocalDateTime.now());
        taskRepository.save(task);
    }

    private String createTaskNo() {
        String timestamp = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMMddHHmmss"));
        String suffix = UUID.randomUUID().toString().substring(0, 8);
        return "TASK-" + timestamp + "-" + suffix;
    }
}
