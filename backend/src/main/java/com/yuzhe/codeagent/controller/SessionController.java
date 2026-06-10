package com.yuzhe.codeagent.controller;

import com.fasterxml.jackson.databind.JsonNode;
import com.yuzhe.codeagent.common.ApiResponse;
import com.yuzhe.codeagent.service.SessionReadService;
import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/sessions")
public class SessionController {

    private final SessionReadService sessionReadService;

    public SessionController(SessionReadService sessionReadService) {
        this.sessionReadService = sessionReadService;
    }

    @GetMapping
    public ApiResponse<JsonNode> listSessions(@RequestParam String repoPath) {
        return ApiResponse.ok(sessionReadService.listSessions(repoPath));
    }

    @GetMapping("/{sessionId}")
    public ApiResponse<JsonNode> getSessionMeta(@PathVariable String sessionId, @RequestParam String repoPath) {
        return ApiResponse.ok(sessionReadService.readSessionMeta(repoPath, sessionId));
    }

    @GetMapping("/{sessionId}/records")
    public ApiResponse<List<JsonNode>> getSessionRecords(@PathVariable String sessionId, @RequestParam String repoPath) {
        return ApiResponse.ok(sessionReadService.readSessionRecords(repoPath, sessionId));
    }
}
