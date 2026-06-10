package com.yuzhe.codeagent.domain;

import com.yuzhe.codeagent.enums.SandboxStatus;
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
@Table(name = "agent_sandbox")
public class AgentSandbox {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "task_id", nullable = false)
    private Long taskId;

    @Column(name = "container_id", length = 128)
    private String containerId;

    @Column(name = "container_name", nullable = false, length = 128)
    private String containerName;

    @Column(name = "image", nullable = false, length = 256)
    private String image;

    @Column(name = "workspace_path", nullable = false, length = 1024)
    private String workspacePath;

    @Column(name = "repo_workspace_path", nullable = false, length = 1024)
    private String repoWorkspacePath;

    @Enumerated(EnumType.STRING)
    @Column(name = "status", nullable = false, length = 32)
    private SandboxStatus status;

    @Column(name = "cpu_limit", length = 32)
    private String cpuLimit;

    @Column(name = "memory_limit", length = 32)
    private String memoryLimit;

    @Column(name = "network_enabled", nullable = false)
    private Boolean networkEnabled;

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
