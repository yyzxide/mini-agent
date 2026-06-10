package com.yuzhe.codeagent.runner;

import com.fasterxml.jackson.databind.JsonNode;
import lombok.Builder;
import lombok.Getter;

@Getter
@Builder
public class RunnerEvent {

    private String id;
    private String sessionId;
    private String type;
    private JsonNode payload;
    private String timestamp;
}
