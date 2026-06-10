package com.yuzhe.codeagent;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.yuzhe.codeagent.runner.RunnerEventParser;
import org.junit.jupiter.api.Test;

class RunnerEventParserTest {

    private final RunnerEventParser parser = new RunnerEventParser(new ObjectMapper());

    @Test
    void parsesValidMiniAgentEventLine() {
        var event = parser.parseLine("MINI_AGENT_EVENT {\"type\":\"TASK_FINISHED\",\"sessionId\":\"s1\",\"payload\":{\"summary\":\"done\"}}");

        assertThat(event).isPresent();
        assertThat(event.get().getType()).isEqualTo("TASK_FINISHED");
        assertThat(event.get().getSessionId()).isEqualTo("s1");
        assertThat(event.get().getPayload().path("summary").asText()).isEqualTo("done");
    }

    @Test
    void ignoresOrdinaryLogLines() {
        assertThat(parser.parseLine("[tool] search_code")).isEmpty();
    }

    @Test
    void invalidJsonDoesNotThrow() {
        var result = parser.parseLineDetailed("MINI_AGENT_EVENT {not-json");

        assertThat(result.getEvent()).isEmpty();
        assertThat(result.getErrorMessage()).contains("Failed to parse MINI_AGENT_EVENT");
    }
}
