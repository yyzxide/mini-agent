package com.yuzhe.codeagent.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.yuzhe.codeagent.common.BusinessException;
import com.yuzhe.codeagent.config.CodeAgentProperties;
import com.yuzhe.codeagent.domain.AgentSandbox;
import com.yuzhe.codeagent.domain.AgentTask;
import com.yuzhe.codeagent.domain.AgentTaskEvent;
import com.yuzhe.codeagent.domain.AgentTaskLog;
import com.yuzhe.codeagent.enums.AgentEventType;
import com.yuzhe.codeagent.enums.AgentTaskStatus;
import com.yuzhe.codeagent.enums.SandboxStatus;
import com.yuzhe.codeagent.repository.AgentSandboxRepository;
import com.yuzhe.codeagent.repository.AgentTaskEventRepository;
import com.yuzhe.codeagent.repository.AgentTaskLogRepository;
import com.yuzhe.codeagent.repository.AgentTaskRepository;
import com.yuzhe.codeagent.runner.RunnerEvent;
import com.yuzhe.codeagent.runner.RunnerEventParseResult;
import com.yuzhe.codeagent.runner.RunnerEventParser;
import com.yuzhe.codeagent.sandbox.DockerCommandBuilder;
import com.yuzhe.codeagent.sandbox.DockerRunRequest;
import com.yuzhe.codeagent.sandbox.DockerSandboxRunner;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.LocalDateTime;
import java.util.List;
import java.util.concurrent.TimeUnit;
import org.springframework.stereotype.Service;

@Service
public class DockerSandboxService {

    private final CodeAgentProperties properties;
    private final DockerCommandBuilder commandBuilder;
    private final DockerSandboxRunner sandboxRunner;
    private final RunnerEventParser eventParser;
    private final AgentTaskRepository taskRepository;
    private final AgentSandboxRepository sandboxRepository;
    private final AgentTaskEventRepository eventRepository;
    private final AgentTaskLogRepository logRepository;
    private final SessionReadService sessionReadService;
    private final PathSecurityService pathSecurityService;
    private final ObjectMapper objectMapper;

    public DockerSandboxService(
            CodeAgentProperties properties,
            DockerCommandBuilder commandBuilder,
            DockerSandboxRunner sandboxRunner,
            RunnerEventParser eventParser,
            AgentTaskRepository taskRepository,
            AgentSandboxRepository sandboxRepository,
            AgentTaskEventRepository eventRepository,
            AgentTaskLogRepository logRepository,
            SessionReadService sessionReadService,
            PathSecurityService pathSecurityService,
            ObjectMapper objectMapper) {
        this.properties = properties;
        this.commandBuilder = commandBuilder;
        this.sandboxRunner = sandboxRunner;
        this.eventParser = eventParser;
        this.taskRepository = taskRepository;
        this.sandboxRepository = sandboxRepository;
        this.eventRepository = eventRepository;
        this.logRepository = logRepository;
        this.sessionReadService = sessionReadService;
        this.pathSecurityService = pathSecurityService;
        this.objectMapper = objectMapper;
    }

    public void startTask(AgentTask task) {
        if (!properties.getSandbox().isEnabled()) {
            throw new BusinessException("Docker sandbox is disabled");
        }

        Path workspacePath = pathSecurityService.validateSandboxWorkspacePath(task.getWorkspacePath());
        Path repoWorkspacePath = pathSecurityService.resolveTaskRepoPath(task);
        AgentSandbox sandbox = createSandbox(task, workspacePath, repoWorkspacePath);
        task.setSandboxId(sandbox.getId());
        taskRepository.save(task);

        List<String> command = commandBuilder.buildCommand(toRunRequest(task, sandbox));
        appendLog(task.getId(), "stdout", "Starting docker sandbox: " + commandBuilder.toSafeCommandLine(command));

        try {
            updateTaskStatus(task.getId(), AgentTaskStatus.STARTING, null);
            updateSandboxStatus(sandbox.getId(), SandboxStatus.STARTING, null);

            Process process = sandboxRunner.start(task.getId(), sandbox.getContainerName(), command);
            AgentTask runningTask = requireTask(task.getId());
            runningTask.setStatus(AgentTaskStatus.RUNNING);
            runningTask.setRunnerPid(process.pid());
            runningTask.setStartedAt(LocalDateTime.now());
            taskRepository.save(runningTask);

            AgentSandbox runningSandbox = requireSandbox(sandbox.getId());
            runningSandbox.setStatus(SandboxStatus.RUNNING);
            runningSandbox.setStartedAt(LocalDateTime.now());
            runningSandbox.setContainerId(inspectContainerId(sandbox.getContainerName()));
            sandboxRepository.save(runningSandbox);

            startStreamThread(task.getId(), "stdout", process.getInputStream());
            startStreamThread(task.getId(), "stderr", process.getErrorStream());
            startWaitThread(task.getId(), sandbox.getId(), process);
        } catch (Exception exception) {
            failTask(task.getId(), sandbox.getId(), "Failed to start docker sandbox: " + exception.getMessage());
            throw new BusinessException("Failed to start docker sandbox", exception);
        }
    }

    public void cancelTask(Long taskId) {
        AgentSandbox sandbox = sandboxRepository.findByTaskId(taskId)
                .orElseThrow(() -> new BusinessException("Sandbox not found for task: " + taskId));
        sandbox.setStatus(SandboxStatus.STOPPING);
        sandboxRepository.save(sandbox);

        try {
            sandboxRunner.stopContainer(sandbox.getContainerName());
        } catch (Exception exception) {
            appendLog(taskId, "stderr", "Failed to stop docker container: " + exception.getMessage());
        }
        sandboxRunner.getProcess(taskId).ifPresent(process -> {
            if (process.isAlive()) {
                process.destroy();
            }
        });
        sandboxRunner.remove(taskId);

        sandbox.setStatus(properties.getSandbox().isAutoRemoveContainer() ? SandboxStatus.REMOVED : SandboxStatus.STOPPED);
        sandbox.setFinishedAt(LocalDateTime.now());
        sandboxRepository.save(sandbox);

        appendLog(taskId, "stdout", "Docker sandbox cancelled by user");
        appendEvent(taskId, null, AgentEventType.CANCELLED, "{\"reason\":\"cancelled by user\"}");

        AgentTask task = requireTask(taskId);
        task.setStatus(AgentTaskStatus.CANCELLED);
        task.setFinishedAt(LocalDateTime.now());
        taskRepository.save(task);
    }

    private AgentSandbox createSandbox(AgentTask task, Path workspacePath, Path repoWorkspacePath) {
        AgentSandbox sandbox = new AgentSandbox();
        sandbox.setTaskId(task.getId());
        sandbox.setContainerName("mini-agent-task-" + task.getId());
        sandbox.setImage(properties.getSandbox().getDockerImage());
        sandbox.setWorkspacePath(workspacePath.toString());
        sandbox.setRepoWorkspacePath(repoWorkspacePath.toString());
        sandbox.setStatus(SandboxStatus.CREATED);
        sandbox.setCpuLimit(properties.getSandbox().getCpuLimit());
        sandbox.setMemoryLimit(properties.getSandbox().getMemoryLimit());
        sandbox.setNetworkEnabled(properties.getSandbox().isNetworkEnabled());
        return sandboxRepository.save(sandbox);
    }

    private DockerRunRequest toRunRequest(AgentTask task, AgentSandbox sandbox) {
        return DockerRunRequest.builder()
                .taskId(task.getId())
                .image(sandbox.getImage())
                .containerName(sandbox.getContainerName())
                .repoWorkspacePath(sandbox.getRepoWorkspacePath())
                .runnerHostPath(properties.getSandbox().getRunnerHostPath())
                .runnerMountPath(properties.getSandbox().getRunnerMountPath())
                .userGoal(task.getUserGoal())
                .useRealModel(Boolean.TRUE.equals(task.getUseRealModel()))
                .autoApprove(Boolean.TRUE.equals(task.getAutoApprove()))
                .maxSteps(task.getMaxSteps())
                .cpuLimit(sandbox.getCpuLimit())
                .memoryLimit(sandbox.getMemoryLimit())
                .networkEnabled(Boolean.TRUE.equals(sandbox.getNetworkEnabled()))
                .autoRemoveContainer(properties.getSandbox().isAutoRemoveContainer())
                .containerWorkdir(properties.getSandbox().getContainerWorkdir())
                .build();
    }

    private void startStreamThread(Long taskId, String streamType, InputStream inputStream) {
        Thread thread = new Thread(() -> readStream(taskId, streamType, inputStream), "docker-sandbox-" + taskId + "-" + streamType);
        thread.setDaemon(true);
        thread.start();
    }

    private void readStream(Long taskId, String streamType, InputStream inputStream) {
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(inputStream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                appendLog(taskId, streamType, line);
                if ("stdout".equals(streamType)) {
                    handleStdoutLine(taskId, line);
                }
            }
        } catch (Exception exception) {
            appendLog(taskId, "stderr", "Failed to read docker " + streamType + ": " + exception.getMessage());
        }
    }

    private void handleStdoutLine(Long taskId, String line) {
        RunnerEventParseResult result = eventParser.parseLineDetailed(line);
        result.getEvent().ifPresent(event -> handleRunnerEvent(taskId, event));
        if (result.getErrorMessage() != null) {
            appendLog(taskId, "stdout", result.getErrorMessage());
            appendEvent(taskId, null, AgentEventType.PARSE_ERROR, "{\"line\":\"event parse failed\"}");
        }
    }

    private void handleRunnerEvent(Long taskId, RunnerEvent event) {
        AgentEventType eventType = toEventType(event.getType());
        appendEvent(taskId, event.getSessionId(), eventType, toJson(event.getPayload()));

        AgentTask task = requireTask(taskId);
        if (task.getSessionId() == null && event.getSessionId() != null) {
            task.setSessionId(event.getSessionId());
        }
        if (eventType == AgentEventType.TASK_FINISHED) {
            task.setStatus(AgentTaskStatus.COMPLETED);
            task.setFinalSummary(event.getPayload().path("summary").asText(task.getFinalSummary()));
        } else if (eventType == AgentEventType.TASK_FAILED) {
            task.setStatus(AgentTaskStatus.FAILED);
            task.setErrorMessage(event.getPayload().path("error").asText(task.getErrorMessage()));
        }
        taskRepository.save(task);
    }

    private void startWaitThread(Long taskId, Long sandboxId, Process process) {
        Thread thread = new Thread(() -> {
            try {
                boolean exited = process.waitFor(properties.getSandbox().getContainerTimeoutSeconds(), TimeUnit.SECONDS);
                if (!exited) {
                    appendLog(taskId, "stderr", "Docker sandbox timed out");
                    sandboxRunner.getContainerName(taskId).ifPresent(sandboxRunner::stopContainer);
                    process.destroyForcibly();
                    finishAfterExit(taskId, sandboxId, -1, true);
                } else {
                    finishAfterExit(taskId, sandboxId, process.exitValue(), false);
                }
            } catch (InterruptedException exception) {
                Thread.currentThread().interrupt();
                failTask(taskId, sandboxId, "Docker sandbox wait interrupted");
            } finally {
                sandboxRunner.remove(taskId);
            }
        }, "docker-sandbox-" + taskId + "-wait");
        thread.setDaemon(true);
        thread.start();
    }

    private void finishAfterExit(Long taskId, Long sandboxId, int exitCode, boolean timedOut) {
        AgentTask task = requireTask(taskId);
        if (task.getSessionId() != null) {
            task.setFinalDiff(sessionReadService.readFinalDiff(task, task.getSessionId()));
        }

        if (task.getStatus() != AgentTaskStatus.COMPLETED
                && task.getStatus() != AgentTaskStatus.FAILED
                && task.getStatus() != AgentTaskStatus.CANCELLED) {
            task.setStatus(exitCode == 0 ? AgentTaskStatus.COMPLETED : AgentTaskStatus.FAILED);
            if (timedOut) {
                task.setErrorMessage("Docker sandbox timed out");
            } else if (exitCode != 0) {
                task.setErrorMessage("Docker sandbox exited with code " + exitCode);
            }
        }
        task.setFinishedAt(LocalDateTime.now());
        taskRepository.save(task);

        AgentSandbox sandbox = requireSandbox(sandboxId);
        if (task.getStatus() == AgentTaskStatus.CANCELLED) {
            sandbox.setStatus(properties.getSandbox().isAutoRemoveContainer() ? SandboxStatus.REMOVED : SandboxStatus.STOPPED);
        } else if (task.getStatus() == AgentTaskStatus.FAILED) {
            sandbox.setStatus(SandboxStatus.FAILED);
            sandbox.setErrorMessage(task.getErrorMessage());
        } else {
            sandbox.setStatus(properties.getSandbox().isAutoRemoveContainer() ? SandboxStatus.REMOVED : SandboxStatus.STOPPED);
        }
        sandbox.setFinishedAt(LocalDateTime.now());
        sandboxRepository.save(sandbox);
    }

    private String inspectContainerId(String containerName) {
        try {
            Process process = new ProcessBuilder("docker", "inspect", "-f", "{{.Id}}", containerName).start();
            if (!process.waitFor(3, TimeUnit.SECONDS) || process.exitValue() != 0) {
                return null;
            }
            return new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8).trim();
        } catch (Exception ignored) {
            return null;
        }
    }

    private void updateTaskStatus(Long taskId, AgentTaskStatus status, String errorMessage) {
        AgentTask task = requireTask(taskId);
        task.setStatus(status);
        task.setErrorMessage(errorMessage);
        taskRepository.save(task);
    }

    private void updateSandboxStatus(Long sandboxId, SandboxStatus status, String errorMessage) {
        AgentSandbox sandbox = requireSandbox(sandboxId);
        sandbox.setStatus(status);
        sandbox.setErrorMessage(errorMessage);
        sandboxRepository.save(sandbox);
    }

    private void failTask(Long taskId, Long sandboxId, String message) {
        AgentTask task = requireTask(taskId);
        task.setStatus(AgentTaskStatus.FAILED);
        task.setErrorMessage(message);
        task.setFinishedAt(LocalDateTime.now());
        taskRepository.save(task);

        AgentSandbox sandbox = requireSandbox(sandboxId);
        sandbox.setStatus(SandboxStatus.FAILED);
        sandbox.setErrorMessage(message);
        sandbox.setFinishedAt(LocalDateTime.now());
        sandboxRepository.save(sandbox);

        appendLog(taskId, "stderr", message);
    }

    private AgentTask requireTask(Long taskId) {
        return taskRepository.findById(taskId)
                .orElseThrow(() -> new BusinessException("Task not found: " + taskId));
    }

    private AgentSandbox requireSandbox(Long sandboxId) {
        return sandboxRepository.findById(sandboxId)
                .orElseThrow(() -> new BusinessException("Sandbox not found: " + sandboxId));
    }

    private void appendLog(Long taskId, String streamType, String content) {
        AgentTaskLog log = new AgentTaskLog();
        log.setTaskId(taskId);
        log.setStreamType(streamType);
        log.setContent(content);
        logRepository.save(log);
    }

    private void appendEvent(Long taskId, String sessionId, AgentEventType eventType, String payload) {
        AgentTaskEvent event = new AgentTaskEvent();
        event.setTaskId(taskId);
        event.setSessionId(sessionId);
        event.setEventType(eventType);
        event.setPayload(payload);
        eventRepository.save(event);
    }

    private AgentEventType toEventType(String value) {
        try {
            return AgentEventType.valueOf(value);
        } catch (Exception ignored) {
            return AgentEventType.UNKNOWN;
        }
    }

    private String toJson(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (Exception exception) {
            return "{}";
        }
    }
}
