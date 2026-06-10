package com.yuzhe.codeagent.runner;

import com.yuzhe.codeagent.config.CodeAgentProperties;
import com.yuzhe.codeagent.domain.AgentTask;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.springframework.stereotype.Component;

@Component
public class RunnerCommandBuilder {

    private final CodeAgentProperties properties;

    public RunnerCommandBuilder(CodeAgentProperties properties) {
        this.properties = properties;
    }

    public List<String> buildCommand(AgentTask task) {
        List<String> command = new ArrayList<>();
        Path runnerPath = resolveRunnerPath();
        command.add(properties.getNodePath());
        command.add(runnerPath.toString());
        command.add("run");
        command.add(task.getUserGoal());
        command.add(task.getUseRealModel() ? "--real" : "--mock");

        if (Boolean.TRUE.equals(task.getAutoApprove())) {
            command.add("--yes");
        }

        command.add("--max-steps");
        command.add(String.valueOf(task.getMaxSteps()));
        command.add("--event-stream");
        return command;
    }

    public String toCommandLine(List<String> command) {
        return String.join(" ", command.stream().map(this::quoteIfNeeded).toList());
    }

    private Path resolveRunnerPath() {
        Path path = Path.of(properties.getRunnerPath());
        return path.isAbsolute() ? path.normalize() : Path.of("").toAbsolutePath().resolve(path).normalize();
    }

    private String quoteIfNeeded(String value) {
        if (value.matches("[A-Za-z0-9_./:=@+-]+")) {
            return value;
        }
        return "'" + value.replace("'", "'\\''") + "'";
    }
}
