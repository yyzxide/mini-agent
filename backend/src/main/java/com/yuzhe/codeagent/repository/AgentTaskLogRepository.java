package com.yuzhe.codeagent.repository;

import com.yuzhe.codeagent.domain.AgentTaskLog;
import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;

public interface AgentTaskLogRepository extends JpaRepository<AgentTaskLog, Long> {

    List<AgentTaskLog> findByTaskIdOrderByCreatedAtAsc(Long taskId);
}
