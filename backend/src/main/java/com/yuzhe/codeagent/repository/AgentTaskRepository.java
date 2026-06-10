package com.yuzhe.codeagent.repository;

import com.yuzhe.codeagent.domain.AgentTask;
import com.yuzhe.codeagent.enums.AgentTaskStatus;
import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;

public interface AgentTaskRepository extends JpaRepository<AgentTask, Long> {

    List<AgentTask> findByStatusOrderByCreatedAtDesc(AgentTaskStatus status);

    List<AgentTask> findByRepoPathOrderByCreatedAtDesc(String repoPath);

    List<AgentTask> findByStatusAndRepoPathOrderByCreatedAtDesc(AgentTaskStatus status, String repoPath);

    List<AgentTask> findAllByOrderByCreatedAtDesc();
}
