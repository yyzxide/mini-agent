package com.yuzhe.codeagent.runner;

import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Component;

@Component
public class RunnerProcessHolder {

    private final Map<Long, Process> processes = new ConcurrentHashMap<>();

    public void put(Long taskId, Process process) {
        processes.put(taskId, process);
    }

    public Optional<Process> get(Long taskId) {
        return Optional.ofNullable(processes.get(taskId));
    }

    public void remove(Long taskId) {
        processes.remove(taskId);
    }
}
