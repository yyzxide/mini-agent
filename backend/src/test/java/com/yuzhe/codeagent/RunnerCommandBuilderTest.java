package com.yuzhe.codeagent;

import static org.assertj.core.api.Assertions.assertThat;

import com.yuzhe.codeagent.config.CodeAgentProperties;
import com.yuzhe.codeagent.domain.AgentTask;
import com.yuzhe.codeagent.runner.RunnerCommandBuilder;
import org.junit.jupiter.api.Test;

class RunnerCommandBuilderTest {

    @Test
    void buildsCommandWithMaxStepsAndEventStream() {
        CodeAgentProperties properties = new CodeAgentProperties();
        properties.setNodePath("node");
        properties.setRunnerPath("../dist/cli/index.js");
        RunnerCommandBuilder builder = new RunnerCommandBuilder(properties);

        AgentTask task = new AgentTask();
        task.setUserGoal("demo task");
        task.setMaxSteps(20);

        assertThat(builder.buildCommand(task))
                .contains("node", "run", "demo task", "--max-steps", "20", "--event-stream")
                .doesNotContain("--yes", "--mock", "--real");
    }

    @Test
    void buildsRealModelCommand() {
        CodeAgentProperties properties = new CodeAgentProperties();
        RunnerCommandBuilder builder = new RunnerCommandBuilder(properties);

        AgentTask task = new AgentTask();
        task.setUserGoal("real task");
        task.setMaxSteps(30);

        assertThat(builder.buildCommand(task))
                .contains("run", "real task", "--max-steps", "30", "--event-stream")
                .doesNotContain("--yes", "--mock", "--real");
    }
}
