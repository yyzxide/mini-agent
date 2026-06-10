package com.yuzhe.codeagent.sandbox;

import java.io.IOException;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.TimeUnit;
import org.springframework.stereotype.Component;

@Component
public class DockerSandboxRunner {

    private final ConcurrentMap<Long, Process> processes = new ConcurrentHashMap<>();
    private final ConcurrentMap<Long, String> containerNames = new ConcurrentHashMap<>();

    public Process start(Long taskId, String containerName, List<String> command) throws IOException {
        Process process = new ProcessBuilder(command).start();
        processes.put(taskId, process);
        containerNames.put(taskId, containerName);
        return process;
    }

    public Optional<Process> getProcess(Long taskId) {
        return Optional.ofNullable(processes.get(taskId));
    }

    public Optional<String> getContainerName(Long taskId) {
        return Optional.ofNullable(containerNames.get(taskId));
    }

    public void remove(Long taskId) {
        processes.remove(taskId);
        containerNames.remove(taskId);
    }

    public void stopContainer(String containerName) {
        try {
            Process process = new ProcessBuilder("docker", "stop", containerName).start();
            if (!process.waitFor(10, TimeUnit.SECONDS)) {
                process.destroyForcibly();
            }
        } catch (IOException exception) {
            throw new IllegalStateException("Failed to stop docker container: " + containerName, exception);
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Interrupted while stopping docker container: " + containerName, exception);
        }
    }
}
