package com.yuzhe.codeagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.yuzhe.codeagent.config.CodeAgentProperties;
import com.yuzhe.codeagent.domain.AgentTask;
import com.yuzhe.codeagent.enums.AgentExecutionMode;
import com.yuzhe.codeagent.enums.AgentTaskStatus;
import com.yuzhe.codeagent.service.EventReadService;
import com.yuzhe.codeagent.service.PathSecurityService;
import com.yuzhe.codeagent.service.SessionReadService;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class SessionAndEventReadServiceTest {

    @TempDir
    Path workspace;

    @Test
    void readsSessionRecordsAndEvents() throws Exception {
        Path repo = Files.createDirectory(workspace.resolve("repo"));
        Path mini = Files.createDirectories(repo.resolve(".mini-agent"));
        Files.createDirectories(mini.resolve("sessions"));
        Files.createDirectories(mini.resolve("events"));
        Files.writeString(mini.resolve("index.json"), "{\"version\":1,\"sessions\":[{\"sessionId\":\"s1\"}]}");
        Files.writeString(mini.resolve("sessions/s1.jsonl"), "{\"timestamp\":\"2026-01-01T00:00:00Z\",\"type\":\"USER_MESSAGE\"}\n\n");
        Files.writeString(mini.resolve("events/s1.jsonl"), "{\"timestamp\":\"2026-01-01T00:00:00Z\",\"type\":\"TASK_FINISHED\"}\n");

        CodeAgentProperties properties = new CodeAgentProperties();
        properties.setWorkspaceRoot(workspace.toString());
        PathSecurityService pathSecurityService = new PathSecurityService(properties);
        ObjectMapper objectMapper = new ObjectMapper();
        SessionReadService sessionReadService = new SessionReadService(objectMapper, pathSecurityService);
        EventReadService eventReadService = new EventReadService(objectMapper, pathSecurityService);

        assertThat(sessionReadService.readSessionRecords(repo.toString(), "s1")).hasSize(1);
        assertThat(sessionReadService.readSessionMeta(repo.toString(), "s1").path("sessionId").asText()).isEqualTo("s1");
        assertThat(eventReadService.readEvents(repo.toString(), "s1")).hasSize(1);
        assertThat(eventReadService.tailEvents(repo.toString(), "s1", 1)).hasSize(1);
    }

    @Test
    void rejectsRepoPathOutsideWorkspace() throws Exception {
        Path outside = Files.createDirectory(workspace.getParent().resolve("outside-" + System.nanoTime()));
        CodeAgentProperties properties = new CodeAgentProperties();
        properties.setWorkspaceRoot(workspace.toString());
        PathSecurityService pathSecurityService = new PathSecurityService(properties);

        try {
            assertThatThrownBy(() -> pathSecurityService.validateRepoPath(outside.toString()))
                    .hasMessageContaining("outside workspace-root");
        } finally {
            Files.deleteIfExists(outside);
        }
    }

    @Test
    void readsSessionRecordsAndEventsFromDockerWorkspace() throws Exception {
        Path sandboxRoot = Files.createDirectories(workspace.resolve("sandboxes"));
        Path taskWorkspace = Files.createDirectories(sandboxRoot.resolve("task_1"));
        Path repo = Files.createDirectories(taskWorkspace.resolve("repo"));
        Path mini = Files.createDirectories(repo.resolve(".mini-agent"));
        Files.createDirectories(mini.resolve("sessions"));
        Files.createDirectories(mini.resolve("events"));
        Files.writeString(mini.resolve("index.json"), "{\"version\":1,\"sessions\":[{\"sessionId\":\"s1\"}]}");
        Files.writeString(mini.resolve("sessions/s1.jsonl"), "{\"timestamp\":\"2026-01-01T00:00:00Z\",\"type\":\"USER_MESSAGE\"}\n");
        Files.writeString(mini.resolve("events/s1.jsonl"), "{\"timestamp\":\"2026-01-01T00:00:00Z\",\"type\":\"TASK_FINISHED\"}\n");

        CodeAgentProperties properties = new CodeAgentProperties();
        properties.setWorkspaceRoot(workspace.toString());
        properties.getSandbox().setWorkspaceRoot(sandboxRoot.toString());
        PathSecurityService pathSecurityService = new PathSecurityService(properties);
        ObjectMapper objectMapper = new ObjectMapper();
        SessionReadService sessionReadService = new SessionReadService(objectMapper, pathSecurityService);
        EventReadService eventReadService = new EventReadService(objectMapper, pathSecurityService);

        AgentTask task = new AgentTask();
        task.setId(1L);
        task.setTaskNo("TASK-1");
        task.setRepoPath(workspace.resolve("source").toString());
        task.setExecutionMode(AgentExecutionMode.DOCKER);
        task.setWorkspacePath(taskWorkspace.toString());
        task.setUserGoal("demo");
        task.setStatus(AgentTaskStatus.COMPLETED);
        task.setMaxSteps(20);
        task.setAutoApprove(true);
        task.setUseRealModel(false);

        assertThat(sessionReadService.readSessionRecords(task, "s1")).hasSize(1);
        assertThat(eventReadService.readEvents(task, "s1")).hasSize(1);
        assertThat(eventReadService.tailEvents(task, "s1", 1)).hasSize(1);
    }
}
