package com.yuzhe.codeagent.dto;

import lombok.Builder;
import lombok.Getter;

@Getter
@Builder
public class RunnerStartResult {

    private Long pid;
    private String commandLine;
}
