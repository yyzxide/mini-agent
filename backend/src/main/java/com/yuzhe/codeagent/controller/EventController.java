package com.yuzhe.codeagent.controller;

import com.fasterxml.jackson.databind.JsonNode;
import com.yuzhe.codeagent.common.ApiResponse;
import com.yuzhe.codeagent.service.EventReadService;
import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/sessions")
public class EventController {

    private final EventReadService eventReadService;

    public EventController(EventReadService eventReadService) {
        this.eventReadService = eventReadService;
    }

    @GetMapping("/{sessionId}/events")
    public ApiResponse<List<JsonNode>> getSessionEvents(
            @PathVariable String sessionId,
            @RequestParam String repoPath,
            @RequestParam(required = false) Integer limit) {
        if (limit != null) {
            return ApiResponse.ok(eventReadService.tailEvents(repoPath, sessionId, limit));
        }
        return ApiResponse.ok(eventReadService.readEvents(repoPath, sessionId));
    }
}
