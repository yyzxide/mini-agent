package com.yuzhe.codeagent.repository;

import com.yuzhe.codeagent.domain.AgentSandbox;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

public interface AgentSandboxRepository extends JpaRepository<AgentSandbox, Long> {

    Optional<AgentSandbox> findByTaskId(Long taskId);
}
