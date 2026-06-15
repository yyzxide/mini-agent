package com.yuzhe.codeagent.sandbox;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.springframework.stereotype.Component;

@Component
public class DockerCommandBuilder {

    private static final List<String> MODEL_ENV_KEYS = List.of(
            "MINI_AGENT_BASE_URL",
            "MINI_AGENT_API_KEY",
            "MINI_AGENT_MODEL",
            "MINI_AGENT_TEMPERATURE",
            "MINI_AGENT_MAX_TOKENS",
            "MINI_AGENT_TIMEOUT_MS");

    public List<String> buildCommand(DockerRunRequest request) {
        List<String> command = new ArrayList<>();
        command.add("docker");
        command.add("run");
        command.add("--name");
        command.add(request.getContainerName());

        if (hasText(request.getCpuLimit())) {
            command.add("--cpus");
            command.add(request.getCpuLimit());
        }
        if (hasText(request.getMemoryLimit())) {
            command.add("--memory");
            command.add(request.getMemoryLimit());
        }
        if (!request.isNetworkEnabled()) {
            command.add("--network");
            command.add("none");
        }
        if (request.isAutoRemoveContainer()) {
            command.add("--rm");
        }

        if (request.isUseRealModel()) {
            MODEL_ENV_KEYS.forEach(key -> {
                if (System.getenv(key) != null) {
                    command.add("-e");
                    command.add(key);
                }
            });
        }

        command.add("-v");
        command.add(toAbsolutePath(request.getRepoWorkspacePath()) + ":" + request.getContainerWorkdir());
        command.add("-v");
        command.add(toAbsolutePath(request.getRunnerHostPath()) + ":" + request.getRunnerMountPath() + ":ro");
        command.add("-w");
        command.add(request.getContainerWorkdir());
        command.add(request.getImage());
        command.add("node");
        command.add(request.getRunnerMountPath() + "/dist/cli/index.js");
        command.add("run");
        command.add(request.getUserGoal());
        command.add(request.isUseRealModel() ? "--real" : "--mock");

        command.add("--max-steps");
        command.add(String.valueOf(request.getMaxSteps()));
        command.add("--event-stream");
        return command;
    }

    public String toCommandLine(List<String> command) {
        return String.join(" ", command.stream().map(this::quoteIfNeeded).toList());
    }

    public String toSafeCommandLine(List<String> command) {
        List<String> safe = new ArrayList<>();
        for (int index = 0; index < command.size(); index++) {
            String value = command.get(index);
            if ("-e".equals(value) && index + 1 < command.size()) {
                safe.add(value);
                String envKey = command.get(++index);
                safe.add("MINI_AGENT_API_KEY".equals(envKey) ? "MINI_AGENT_API_KEY=<redacted>" : envKey);
            } else {
                safe.add(value);
            }
        }
        return toCommandLine(safe);
    }

    private String toAbsolutePath(String value) {
        return Path.of(value).toAbsolutePath().normalize().toString();
    }

    private boolean hasText(String value) {
        return value != null && !value.isBlank();
    }

    private String quoteIfNeeded(String value) {
        if (value.matches("[A-Za-z0-9_./:=@+-]+")) {
            return value;
        }
        return "'" + value.replace("'", "'\\''") + "'";
    }
}
