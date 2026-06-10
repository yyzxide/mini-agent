package com.yuzhe.codeagent.dto;

import com.yuzhe.codeagent.domain.AgentTaskLog;
import java.time.LocalDateTime;
import lombok.Builder;
import lombok.Getter;

@Getter
@Builder
public class AgentTaskLogResponse {

    private Long id;
    private Long taskId;
    private String streamType;
    private String content;
    private LocalDateTime createdAt;

    public static AgentTaskLogResponse from(AgentTaskLog log) {
        return AgentTaskLogResponse.builder()
                .id(log.getId())
                .taskId(log.getTaskId())
                .streamType(log.getStreamType())
                .content(log.getContent())
                .createdAt(log.getCreatedAt())
                .build();
    }
}
