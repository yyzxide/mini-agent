package com.yuzhe.codeagent.runner;

import java.util.Optional;
import lombok.Builder;
import lombok.Getter;

@Getter
@Builder
public class RunnerEventParseResult {

    private Optional<RunnerEvent> event;
    private String errorMessage;

    public static RunnerEventParseResult empty() {
        return RunnerEventParseResult.builder()
                .event(Optional.empty())
                .build();
    }

    public static RunnerEventParseResult event(RunnerEvent event) {
        return RunnerEventParseResult.builder()
                .event(Optional.of(event))
                .build();
    }

    public static RunnerEventParseResult error(String errorMessage) {
        return RunnerEventParseResult.builder()
                .event(Optional.empty())
                .errorMessage(errorMessage)
                .build();
    }
}
