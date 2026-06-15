package com.yuzhe.codeagent.domain;

import com.yuzhe.codeagent.enums.AgentTaskStatus;
import com.yuzhe.codeagent.enums.AgentExecutionMode;
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
@Table(name = "agent_task")
public class AgentTask {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "task_no", nullable = false, unique = true, length = 64)
    private String taskNo;

    @Column(name = "repo_path", nullable = false, length = 1024)
    private String repoPath;

    @Enumerated(EnumType.STRING)
    @Column(name = "execution_mode", nullable = false, length = 32)
    private AgentExecutionMode executionMode;

    @Column(name = "source_repo_path", length = 1024)
    private String sourceRepoPath;

    @Column(name = "workspace_path", length = 1024)
    private String workspacePath;

    @Column(name = "sandbox_id")
    private Long sandboxId;

    @Lob
    @Column(name = "user_goal", nullable = false)
    private String userGoal;

    @Column(name = "session_id", length = 128)
    private String sessionId;

    @Enumerated(EnumType.STRING)
    @Column(name = "status", nullable = false, length = 32)
    private AgentTaskStatus status;

    @Column(name = "max_steps", nullable = false)
    private Integer maxSteps;

    @Column(name = "runner_pid")
    private Long runnerPid;

    @Column(name = "started_at")
    private LocalDateTime startedAt;

    @Column(name = "finished_at")
    private LocalDateTime finishedAt;

    @Column(name = "created_at", nullable = false)
    private LocalDateTime createdAt;

    @Column(name = "updated_at", nullable = false)
    private LocalDateTime updatedAt;

    @Lob
    @Column(name = "error_message")
    private String errorMessage;

    @Lob
    @Column(name = "final_summary")
    private String finalSummary;

    @Lob
    @Column(name = "final_diff")
    private String finalDiff;

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
