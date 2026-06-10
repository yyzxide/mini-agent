package com.yuzhe.codeagent.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.yuzhe.codeagent.common.BusinessException;
import com.yuzhe.codeagent.domain.AgentTask;
import com.yuzhe.codeagent.domain.AgentTaskEvent;
import com.yuzhe.codeagent.domain.AgentTaskLog;
import com.yuzhe.codeagent.dto.RunnerStartResult;
import com.yuzhe.codeagent.enums.AgentEventType;
import com.yuzhe.codeagent.enums.AgentTaskStatus;
import com.yuzhe.codeagent.repository.AgentTaskEventRepository;
import com.yuzhe.codeagent.repository.AgentTaskLogRepository;
import com.yuzhe.codeagent.repository.AgentTaskRepository;
import com.yuzhe.codeagent.runner.RunnerCommandBuilder;
import com.yuzhe.codeagent.runner.RunnerEvent;
import com.yuzhe.codeagent.runner.RunnerEventParseResult;
import com.yuzhe.codeagent.runner.RunnerEventParser;
import com.yuzhe.codeagent.runner.RunnerProcessHolder;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.time.LocalDateTime;
import java.util.List;
import java.util.concurrent.TimeUnit;
import org.springframework.stereotype.Service;

@Service
public class RunnerProcessService {

    private final RunnerCommandBuilder commandBuilder;
    private final RunnerEventParser eventParser;
    private final RunnerProcessHolder processHolder;
    private final AgentTaskRepository taskRepository;
    private final AgentTaskEventRepository eventRepository;
    private final AgentTaskLogRepository logRepository;
    private final SessionReadService sessionReadService;
    private final ObjectMapper objectMapper;

    public RunnerProcessService(
            RunnerCommandBuilder commandBuilder,
            RunnerEventParser eventParser,
            RunnerProcessHolder processHolder,
            AgentTaskRepository taskRepository,
            AgentTaskEventRepository eventRepository,
            AgentTaskLogRepository logRepository,
            SessionReadService sessionReadService,
            ObjectMapper objectMapper) {
        this.commandBuilder = commandBuilder;
        this.eventParser = eventParser;
        this.processHolder = processHolder;
        this.taskRepository = taskRepository;
        this.eventRepository = eventRepository;
        this.logRepository = logRepository;
        this.sessionReadService = sessionReadService;
        this.objectMapper = objectMapper;
    }

    public RunnerStartResult startTask(AgentTask task) {
        updateStatus(task.getId(), AgentTaskStatus.STARTING, null);
        List<String> command = commandBuilder.buildCommand(task);

        try {
            ProcessBuilder processBuilder = new ProcessBuilder(command);
            processBuilder.directory(java.nio.file.Path.of(task.getRepoPath()).toFile());
            Process process = processBuilder.start();
            processHolder.put(task.getId(), process);

            AgentTask runningTask = requireTask(task.getId());
            runningTask.setStatus(AgentTaskStatus.RUNNING);
            runningTask.setRunnerPid(process.pid());
            runningTask.setStartedAt(LocalDateTime.now());
            taskRepository.save(runningTask);

            startStreamThread(task.getId(), "stdout", process.getInputStream());
            startStreamThread(task.getId(), "stderr", process.getErrorStream());
            startWaitThread(task.getId(), process);

            return RunnerStartResult.builder()
                    .pid(process.pid())
                    .commandLine(commandBuilder.toCommandLine(command))
                    .build();
        } catch (Exception exception) {
            failTask(task.getId(), "Failed to start runner: " + exception.getMessage());
            throw new BusinessException("Failed to start runner", exception);
        }
    }

    public void cancelTask(Long taskId) {
        processHolder.get(taskId).ifPresent(process -> {
            if (process.isAlive()) {
                process.destroy();
                try {
                    if (!process.waitFor(3, TimeUnit.SECONDS)) {
                        process.destroyForcibly();
                    }
                } catch (InterruptedException exception) {
                    Thread.currentThread().interrupt();
                    process.destroyForcibly();
                }
            }
        });
        processHolder.remove(taskId);
        appendLog(taskId, "stdout", "Task cancelled by user");
        appendEvent(taskId, null, AgentEventType.CANCELLED, "{\"reason\":\"cancelled by user\"}");
        AgentTask task = requireTask(taskId);
        task.setStatus(AgentTaskStatus.CANCELLED);
        task.setFinishedAt(LocalDateTime.now());
        taskRepository.save(task);
    }

    private void startStreamThread(Long taskId, String streamType, InputStream inputStream) {
        Thread thread = new Thread(() -> readStream(taskId, streamType, inputStream), "runner-" + taskId + "-" + streamType);
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
            appendLog(taskId, "stderr", "Failed to read " + streamType + ": " + exception.getMessage());
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

    private void startWaitThread(Long taskId, Process process) {
        Thread thread = new Thread(() -> {
            try {
                int exitCode = process.waitFor();
                finishAfterExit(taskId, exitCode);
            } catch (InterruptedException exception) {
                Thread.currentThread().interrupt();
                failTask(taskId, "Runner wait interrupted");
            } finally {
                processHolder.remove(taskId);
            }
        }, "runner-" + taskId + "-wait");
        thread.setDaemon(true);
        thread.start();
    }

    private void finishAfterExit(Long taskId, int exitCode) {
        AgentTask task = requireTask(taskId);
        if (task.getSessionId() != null) {
            task.setFinalDiff(sessionReadService.readFinalDiff(task, task.getSessionId()));
        }

        if (task.getStatus() != AgentTaskStatus.COMPLETED
                && task.getStatus() != AgentTaskStatus.FAILED
                && task.getStatus() != AgentTaskStatus.CANCELLED) {
            task.setStatus(exitCode == 0 ? AgentTaskStatus.COMPLETED : AgentTaskStatus.FAILED);
            if (exitCode != 0) {
                task.setErrorMessage("Runner exited with code " + exitCode);
            }
        }
        task.setFinishedAt(LocalDateTime.now());
        taskRepository.save(task);
    }

    private void updateStatus(Long taskId, AgentTaskStatus status, String errorMessage) {
        AgentTask task = requireTask(taskId);
        task.setStatus(status);
        task.setErrorMessage(errorMessage);
        taskRepository.save(task);
    }

    private void failTask(Long taskId, String message) {
        AgentTask task = requireTask(taskId);
        task.setStatus(AgentTaskStatus.FAILED);
        task.setErrorMessage(message);
        task.setFinishedAt(LocalDateTime.now());
        taskRepository.save(task);
        appendLog(taskId, "stderr", message);
    }

    private AgentTask requireTask(Long taskId) {
        return taskRepository.findById(taskId)
                .orElseThrow(() -> new BusinessException("Task not found: " + taskId));
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
