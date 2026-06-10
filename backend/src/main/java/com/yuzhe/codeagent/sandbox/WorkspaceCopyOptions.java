package com.yuzhe.codeagent.sandbox;

import java.util.Set;

public record WorkspaceCopyOptions(Set<String> excludedDirectoryNames) {

    public static WorkspaceCopyOptions defaults() {
        return new WorkspaceCopyOptions(Set.of(
                ".mini-agent",
                "node_modules",
                "target",
                "dist",
                "build",
                ".idea",
                ".vscode"));
    }

    public boolean shouldExcludeDirectory(String directoryName) {
        return excludedDirectoryNames.contains(directoryName);
    }
}
