package com.yuzhe.codeagent.controller;

import com.fasterxml.jackson.databind.JsonNode;
import com.yuzhe.codeagent.common.ApiResponse;
import com.yuzhe.codeagent.dto.AgentTaskEventResponse;
import com.yuzhe.codeagent.dto.AgentTaskLogResponse;
import com.yuzhe.codeagent.dto.AgentTaskResponse;
import com.yuzhe.codeagent.dto.CreateAgentTaskRequest;
import com.yuzhe.codeagent.dto.SandboxInfoResponse;
import com.yuzhe.codeagent.enums.AgentTaskStatus;
import com.yuzhe.codeagent.service.AgentTaskService;
import jakarta.validation.Valid;
import java.io.IOException;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

@RestController
@RequestMapping("/api/agent/tasks")
public class AgentTaskController {

    private final AgentTaskService agentTaskService;

    public AgentTaskController(AgentTaskService agentTaskService) {
        this.agentTaskService = agentTaskService;
    }

    @PostMapping
    public ApiResponse<AgentTaskResponse> createTask(@Valid @RequestBody CreateAgentTaskRequest request) {
        return ApiResponse.ok(agentTaskService.createAndStart(request));
    }

    @GetMapping
    public ApiResponse<List<AgentTaskResponse>> listTasks(
            @RequestParam(required = false) AgentTaskStatus status,
            @RequestParam(required = false) String repoPath) {
        return ApiResponse.ok(agentTaskService.listTasks(status, repoPath));
    }

    @GetMapping("/{id}")
    public ApiResponse<AgentTaskResponse> getTask(@PathVariable Long id) {
        return ApiResponse.ok(agentTaskService.getTask(id));
    }

    @GetMapping("/{id}/events")
    public ApiResponse<List<AgentTaskEventResponse>> getEvents(@PathVariable Long id) {
        return ApiResponse.ok(agentTaskService.getEvents(id));
    }

    @GetMapping("/{id}/logs")
    public ApiResponse<List<AgentTaskLogResponse>> getLogs(@PathVariable Long id) {
        return ApiResponse.ok(agentTaskService.getLogs(id));
    }

    @GetMapping("/{id}/diff")
    public ApiResponse<Map<String, String>> getDiff(@PathVariable Long id) {
        return ApiResponse.ok(Map.of("diff", agentTaskService.getDiff(id)));
    }

    @GetMapping("/{id}/sandbox")
    public ApiResponse<SandboxInfoResponse> getSandbox(@PathVariable Long id) {
        return ApiResponse.ok(agentTaskService.getSandbox(id));
    }

    @GetMapping("/{id}/session/records")
    public ApiResponse<List<JsonNode>> getSessionRecords(@PathVariable Long id) {
        return ApiResponse.ok(agentTaskService.getSessionRecords(id));
    }

    @GetMapping("/{id}/session/events")
    public ApiResponse<List<JsonNode>> getSessionEvents(
            @PathVariable Long id,
            @RequestParam(required = false) Integer limit) {
        return ApiResponse.ok(agentTaskService.getSessionEvents(id, limit));
    }

    @PostMapping("/{id}/cancel")
    public ApiResponse<AgentTaskResponse> cancel(@PathVariable Long id) {
        return ApiResponse.ok(agentTaskService.cancel(id));
    }

    @GetMapping("/{id}/stream")
    public SseEmitter stream(@PathVariable Long id) {
        SseEmitter emitter = new SseEmitter(0L);
        Thread thread = new Thread(() -> streamEvents(id, emitter), "task-" + id + "-sse");
        thread.setDaemon(true);
        thread.start();
        return emitter;
    }

    private void streamEvents(Long id, SseEmitter emitter) {
        LocalDateTime lastCreatedAt = LocalDateTime.MIN;
        try {
            while (true) {
                List<AgentTaskEventResponse> events = agentTaskService.getEvents(id);
                for (AgentTaskEventResponse event : events) {
                    if (!event.getCreatedAt().isAfter(lastCreatedAt)) {
                        continue;
                    }
                    emitter.send(SseEmitter.event().name(event.getEventType().name()).data(event));
                    lastCreatedAt = event.getCreatedAt();
                }

                AgentTaskStatus status = agentTaskService.getTask(id).getStatus();
                if (status == AgentTaskStatus.COMPLETED || status == AgentTaskStatus.FAILED || status == AgentTaskStatus.CANCELLED) {
                    emitter.complete();
                    return;
                }
                Thread.sleep(1000);
            }
        } catch (IOException exception) {
            emitter.completeWithError(exception);
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            emitter.completeWithError(exception);
        } catch (Exception exception) {
            emitter.completeWithError(exception);
        }
    }
}
