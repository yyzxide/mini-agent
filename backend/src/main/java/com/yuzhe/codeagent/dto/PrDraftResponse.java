package com.yuzhe.codeagent.dto;

import lombok.Builder;
import lombok.Getter;

@Getter
@Builder
public class PrDraftResponse {

    private String title;
    private String description;
    private String sourceBranch;
    private String targetBranch;
}
