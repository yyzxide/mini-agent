package com.yuzhe.codeagent.runner;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.Optional;
import org.springframework.stereotype.Component;

@Component
public class RunnerEventParser {

    public static final String EVENT_PREFIX = "MINI_AGENT_EVENT ";

    private final ObjectMapper objectMapper;

    public RunnerEventParser(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    public Optional<RunnerEvent> parseLine(String line) {
        return parseLineDetailed(line).getEvent();
    }

    public RunnerEventParseResult parseLineDetailed(String line) {
        if (line == null || !line.startsWith(EVENT_PREFIX)) {
            return RunnerEventParseResult.empty();
        }

        String json = line.substring(EVENT_PREFIX.length()).trim();
        try {
            JsonNode node = objectMapper.readTree(json);
            String type = readText(node, "type");
            if (type == null || type.isBlank()) {
                return RunnerEventParseResult.error("MINI_AGENT_EVENT is missing type");
            }

            return RunnerEventParseResult.event(RunnerEvent.builder()
                    .id(readText(node, "id"))
                    .sessionId(readText(node, "sessionId"))
                    .type(type)
                    .timestamp(readText(node, "timestamp"))
                    .payload(node.path("payload"))
                    .build());
        } catch (Exception exception) {
            return RunnerEventParseResult.error("Failed to parse MINI_AGENT_EVENT: " + exception.getMessage());
        }
    }

    private String readText(JsonNode node, String fieldName) {
        JsonNode value = node.get(fieldName);
        return value == null || value.isNull() ? null : value.asText();
    }
}
