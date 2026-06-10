package com.yuzhe.codeagent.git;

import com.yuzhe.codeagent.dto.PrDraftResponse;
import java.util.List;
import org.springframework.stereotype.Component;

@Component
public class PrDescriptionGenerator {

    public PrDraftResponse generate(PrDescriptionInput input) {
        String title = input.commitMessage() == null || input.commitMessage().isBlank()
                ? "Agent task changes"
                : input.commitMessage().trim();
        String description = """
                ## Summary
                %s

                ## Changes
                %s

                ## Test
                %s

                ## Review Notes
                - Review the generated diff before merging.
                - Docker mode commits live only in the task workspace until pushed manually.
                """.formatted(
                input.userGoal() == null || input.userGoal().isBlank() ? "完成 Agent 任务代码修改。" : input.userGoal().trim(),
                formatChangedFiles(input.changedFiles(), input.diffSummary()),
                input.testResult() == null || input.testResult().isBlank() ? "请查看任务日志确认测试结果。" : input.testResult().trim());

        return PrDraftResponse.builder()
                .title(title)
                .description(description)
                .sourceBranch(input.sourceBranch())
                .targetBranch(input.targetBranch())
                .build();
    }

    private String formatChangedFiles(List<String> changedFiles, String diffSummary) {
        StringBuilder builder = new StringBuilder();
        if (diffSummary != null && !diffSummary.isBlank()) {
            builder.append("- ").append(diffSummary.trim()).append('\n');
        }
        if (changedFiles == null || changedFiles.isEmpty()) {
            builder.append("- No changed files detected.");
        } else {
            for (String file : changedFiles) {
                builder.append("- `").append(file).append("`\n");
            }
        }
        return builder.toString().trim();
    }

    public record PrDescriptionInput(
            String userGoal,
            List<String> changedFiles,
            String diffSummary,
            String testResult,
            String commitMessage,
            String sourceBranch,
            String targetBranch) {
    }
}
