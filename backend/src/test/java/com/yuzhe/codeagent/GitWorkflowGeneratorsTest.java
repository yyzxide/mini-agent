package com.yuzhe.codeagent;

import static org.assertj.core.api.Assertions.assertThat;

import com.yuzhe.codeagent.git.CommitMessageGenerator;
import com.yuzhe.codeagent.git.PrDescriptionGenerator;
import com.yuzhe.codeagent.git.PrDescriptionGenerator.PrDescriptionInput;
import java.util.List;
import org.junit.jupiter.api.Test;

class GitWorkflowGeneratorsTest {

    @Test
    void generatesCommitMessageTypesFromGoal() {
        CommitMessageGenerator generator = new CommitMessageGenerator();

        assertThat(generator.generate("新增功能", List.of("src/a.ts"))).startsWith("feat(agent):");
        assertThat(generator.generate("修复上传问题", List.of("src/a.ts"))).startsWith("fix(agent):");
        assertThat(generator.generate("补充测试", List.of("src/a.ts"))).startsWith("test(agent):");
        assertThat(generator.generate("refactor service", List.of("backend/A.java"))).startsWith("refactor(backend):");
    }

    @Test
    void generatesPrDraftWithTemplateSections() {
        PrDescriptionGenerator generator = new PrDescriptionGenerator();

        var draft = generator.generate(new PrDescriptionInput(
                "demo task",
                List.of("demo.txt"),
                "1 file changed, 1 insertion(+)",
                "tests passed",
                "feat(agent): demo task",
                "agent/task-1",
                "main"));

        assertThat(draft.getTitle()).isEqualTo("feat(agent): demo task");
        assertThat(draft.getSourceBranch()).isEqualTo("agent/task-1");
        assertThat(draft.getTargetBranch()).isEqualTo("main");
        assertThat(draft.getDescription())
                .contains("## Summary")
                .contains("## Changes")
                .contains("`demo.txt`")
                .contains("## Test")
                .contains("tests passed");
    }
}
