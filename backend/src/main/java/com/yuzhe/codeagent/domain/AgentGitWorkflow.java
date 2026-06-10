package com.yuzhe.codeagent.domain;

import com.yuzhe.codeagent.enums.GitWorkflowStatus;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Lob;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;
import java.time.LocalDateTime;
import lombok.Getter;
import lombok.Setter;

@Getter
@Setter
@Entity
@Table(name = "agent_git_workflow")
public class AgentGitWorkflow {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "task_id", nullable = false, unique = true)
    private Long taskId;

    @Column(name = "repo_path", nullable = false, length = 1024)
    private String repoPath;

    @Column(name = "workspace_repo_path", length = 1024)
    private String workspaceRepoPath;

    @Column(name = "base_branch", length = 256)
    private String baseBranch;

    @Column(name = "work_branch", length = 256)
    private String workBranch;

    @Column(name = "base_commit", length = 64)
    private String baseCommit;

    @Column(name = "commit_hash", length = 64)
    private String commitHash;

    @Column(name = "commit_message", length = 512)
    private String commitMessage;

    @Column(name = "pr_title", length = 512)
    private String prTitle;

    @Lob
    @Column(name = "pr_description")
    private String prDescription;

    @Enumerated(EnumType.STRING)
    @Column(name = "status", nullable = false, length = 32)
    private GitWorkflowStatus status;

    @Column(name = "created_at", nullable = false)
    private LocalDateTime createdAt;

    @Column(name = "updated_at", nullable = false)
    private LocalDateTime updatedAt;

    @Lob
    @Column(name = "error_message")
    private String errorMessage;

    @PrePersist
    public void prePersist() {
        LocalDateTime now = LocalDateTime.now();
        createdAt = now;
        updatedAt = now;
    }

    @PreUpdate
    public void preUpdate() {
        updatedAt = LocalDateTime.now();
    }
}
