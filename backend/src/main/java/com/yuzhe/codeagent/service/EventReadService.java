package com.yuzhe.codeagent.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.yuzhe.codeagent.common.BusinessException;
import com.yuzhe.codeagent.domain.AgentTask;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.List;
import org.springframework.stereotype.Service;

@Service
public class EventReadService {

    private final ObjectMapper objectMapper;
    private final PathSecurityService pathSecurityService;

    public EventReadService(ObjectMapper objectMapper, PathSecurityService pathSecurityService) {
        this.objectMapper = objectMapper;
        this.pathSecurityService = pathSecurityService;
    }

    public List<JsonNode> readEvents(String repoPath, String sessionId) {
        Path file = pathSecurityService.resolveMiniAgentFile(repoPath, sessionId, "events");
        return readEventFile(file);
    }

    public List<JsonNode> readEvents(AgentTask task, String sessionId) {
        Path file = pathSecurityService.resolveMiniAgentFile(task, sessionId, "events");
        return readEventFile(file);
    }

    public List<JsonNode> tailEvents(String repoPath, String sessionId, int limit) {
        List<JsonNode> events = readEvents(repoPath, sessionId);
        int safeLimit = Math.max(0, limit);
        return events.subList(Math.max(0, events.size() - safeLimit), events.size());
    }

    public List<JsonNode> tailEvents(AgentTask task, String sessionId, int limit) {
        List<JsonNode> events = readEvents(task, sessionId);
        int safeLimit = Math.max(0, limit);
        return events.subList(Math.max(0, events.size() - safeLimit), events.size());
    }

    private List<JsonNode> readEventFile(Path file) {
        try {
            if (!Files.exists(file)) {
                return List.of();
            }
            return Files.readAllLines(file).stream()
                    .filter(line -> !line.isBlank())
                    .map(this::parseJsonLine)
                    .sorted(Comparator.comparing(node -> node.path("timestamp").asText("")))
                    .toList();
        } catch (IOException exception) {
            throw new BusinessException("Failed to read event JSONL file: " + file, exception);
        }
    }

    private JsonNode parseJsonLine(String line) {
        try {
            return objectMapper.readTree(line);
        } catch (IOException exception) {
            throw new BusinessException("Invalid event JSONL line", exception);
        }
    }
}
