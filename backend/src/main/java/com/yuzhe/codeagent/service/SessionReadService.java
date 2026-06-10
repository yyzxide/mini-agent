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
public class SessionReadService {

    private final ObjectMapper objectMapper;
    private final PathSecurityService pathSecurityService;

    public SessionReadService(ObjectMapper objectMapper, PathSecurityService pathSecurityService) {
        this.objectMapper = objectMapper;
        this.pathSecurityService = pathSecurityService;
    }

    public List<JsonNode> readSessionRecords(String repoPath, String sessionId) {
        return readJsonLines(pathSecurityService.resolveMiniAgentFile(repoPath, sessionId, "sessions"));
    }

    public List<JsonNode> readSessionRecords(AgentTask task, String sessionId) {
        return readJsonLines(pathSecurityService.resolveMiniAgentFile(task, sessionId, "sessions"));
    }

    public JsonNode readSessionMeta(String repoPath, String sessionId) {
        JsonNode index = readJsonFile(pathSecurityService.resolveMiniAgentIndex(repoPath));
        for (JsonNode session : index.path("sessions")) {
            if (sessionId.equals(session.path("sessionId").asText())) {
                return session;
            }
        }
        throw new BusinessException("Session not found: " + sessionId);
    }

    public JsonNode readSessionMeta(AgentTask task, String sessionId) {
        JsonNode index = readJsonFile(pathSecurityService.resolveMiniAgentIndex(task));
        for (JsonNode session : index.path("sessions")) {
            if (sessionId.equals(session.path("sessionId").asText())) {
                return session;
            }
        }
        throw new BusinessException("Session not found: " + sessionId);
    }

    public JsonNode listSessions(String repoPath) {
        return readJsonFile(pathSecurityService.resolveMiniAgentIndex(repoPath)).path("sessions");
    }

    public JsonNode listSessions(AgentTask task) {
        return readJsonFile(pathSecurityService.resolveMiniAgentIndex(task)).path("sessions");
    }

    public String readFinalDiff(String repoPath, String sessionId) {
        List<JsonNode> records = readSessionRecords(repoPath, sessionId);
        return extractFinalDiff(records);
    }

    public String readFinalDiff(AgentTask task, String sessionId) {
        List<JsonNode> records = readSessionRecords(task, sessionId);
        return extractFinalDiff(records);
    }

    private String extractFinalDiff(List<JsonNode> records) {
        for (int index = records.size() - 1; index >= 0; index--) {
            JsonNode record = records.get(index);
            if ("DIFF_SUMMARY".equals(record.path("type").asText())) {
                return record.path("payload").path("diff").asText("");
            }
        }
        return "";
    }

    private JsonNode readJsonFile(Path file) {
        try {
            if (!Files.exists(file)) {
                throw new BusinessException("File not found: " + file);
            }
            return objectMapper.readTree(file.toFile());
        } catch (IOException exception) {
            throw new BusinessException("Failed to read JSON file: " + file, exception);
        }
    }

    private List<JsonNode> readJsonLines(Path file) {
        try {
            if (!Files.exists(file)) {
                return List.of();
            }
            List<JsonNode> records = Files.readAllLines(file).stream()
                    .filter(line -> !line.isBlank())
                    .map(this::parseJsonLine)
                    .sorted(Comparator.comparing(node -> node.path("timestamp").asText("")))
                    .toList();
            return records;
        } catch (IOException exception) {
            throw new BusinessException("Failed to read JSONL file: " + file, exception);
        }
    }

    private JsonNode parseJsonLine(String line) {
        try {
            return objectMapper.readTree(line);
        } catch (IOException exception) {
            throw new BusinessException("Invalid JSONL line", exception);
        }
    }
}
