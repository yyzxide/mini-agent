package com.yuzhe.codeagent.repository;

import com.yuzhe.codeagent.domain.AgentGitWorkflow;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

public interface AgentGitWorkflowRepository extends JpaRepository<AgentGitWorkflow, Long> {

    Optional<AgentGitWorkflow> findByTaskId(Long taskId);
}
