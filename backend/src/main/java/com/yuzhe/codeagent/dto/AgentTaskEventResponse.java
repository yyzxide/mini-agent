package com.yuzhe.codeagent.dto;

import com.yuzhe.codeagent.domain.AgentTaskEvent;
import com.yuzhe.codeagent.enums.AgentEventType;
import java.time.LocalDateTime;
import lombok.Builder;
import lombok.Getter;

@Getter
@Builder
public class AgentTaskEventResponse {

    private Long id;
    private Long taskId;
    private String sessionId;
    private AgentEventType eventType;
    private String payload;
    private LocalDateTime createdAt;

    public static AgentTaskEventResponse from(AgentTaskEvent event) {
        return AgentTaskEventResponse.builder()
                .id(event.getId())
                .taskId(event.getTaskId())
                .sessionId(event.getSessionId())
                .eventType(event.getEventType())
                .payload(event.getPayload())
                .createdAt(event.getCreatedAt())
                .build();
    }
}
