package com.yuzhe.codeagent.git;

import java.util.List;
import org.springframework.stereotype.Component;

@Component
public class CommitMessageGenerator {

    public String generate(String userGoal, List<String> changedFiles) {
        String goal = userGoal == null ? "" : userGoal.trim();
        String normalized = goal.toLowerCase();
        String type = "feat";
        if (goal.contains("修复") || normalized.contains("fix")) {
            type = "fix";
        } else if (goal.contains("测试") || normalized.contains("test")) {
            type = "test";
        } else if (goal.contains("重构") || normalized.contains("refactor")) {
            type = "refactor";
        }

        String scope = inferScope(changedFiles);
        String summary = goal.isBlank() ? "完成 Agent 任务代码修改" : goal.replaceAll("\\s+", " ");
        if (summary.length() > 80) {
            summary = summary.substring(0, 80);
        }
        return type + "(" + scope + "): " + summary;
    }

    private String inferScope(List<String> changedFiles) {
        if (changedFiles == null || changedFiles.isEmpty()) {
            return "agent";
        }
        if (changedFiles.stream().allMatch(path -> path.startsWith("backend/"))) {
            return "backend";
        }
        if (changedFiles.stream().allMatch(path -> path.startsWith("frontend/"))) {
            return "frontend";
        }
        if (changedFiles.stream().allMatch(path -> path.startsWith("src/") || path.startsWith("tests/"))) {
            return "agent";
        }
        return "agent";
    }
}
