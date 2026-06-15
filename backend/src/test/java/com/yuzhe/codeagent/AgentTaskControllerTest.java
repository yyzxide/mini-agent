package com.yuzhe.codeagent;

import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.yuzhe.codeagent.controller.AgentTaskController;
import com.yuzhe.codeagent.dto.AgentTaskEventResponse;
import com.yuzhe.codeagent.dto.AgentTaskLogResponse;
import com.yuzhe.codeagent.dto.AgentTaskResponse;
import com.yuzhe.codeagent.enums.AgentEventType;
import com.yuzhe.codeagent.enums.AgentTaskStatus;
import com.yuzhe.codeagent.service.AgentTaskService;
import java.time.LocalDateTime;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.test.web.servlet.MockMvc;

@WebMvcTest(AgentTaskController.class)
class AgentTaskControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @MockBean
    private AgentTaskService agentTaskService;

    @Test
    void returnsTaskDetail() throws Exception {
        when(agentTaskService.getTask(1L)).thenReturn(taskResponse());

        mockMvc.perform(get("/api/agent/tasks/1"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.success").value(true))
                .andExpect(jsonPath("$.data.id").value(1))
                .andExpect(jsonPath("$.data.status").value("RUNNING"));
    }

    @Test
    void returnsTaskEvents() throws Exception {
        when(agentTaskService.getEvents(1L)).thenReturn(List.of(AgentTaskEventResponse.builder()
                .id(1L)
                .taskId(1L)
                .sessionId("s1")
                .eventType(AgentEventType.TASK_FINISHED)
                .payload("{}")
                .createdAt(LocalDateTime.now())
                .build()));

        mockMvc.perform(get("/api/agent/tasks/1/events"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data[0].eventType").value("TASK_FINISHED"));
    }

    @Test
    void returnsTaskLogs() throws Exception {
        when(agentTaskService.getLogs(1L)).thenReturn(List.of(AgentTaskLogResponse.builder()
                .id(1L)
                .taskId(1L)
                .streamType("stdout")
                .content("hello")
                .createdAt(LocalDateTime.now())
                .build()));

        mockMvc.perform(get("/api/agent/tasks/1/logs"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data[0].content").value("hello"));
    }

    private AgentTaskResponse taskResponse() {
        return AgentTaskResponse.builder()
                .id(1L)
                .taskNo("TASK-1")
                .repoPath("/repo")
                .userGoal("demo")
                .sessionId("s1")
                .status(AgentTaskStatus.RUNNING)
                .maxSteps(20)
                .build();
    }
}
