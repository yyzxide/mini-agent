package com.yuzhe.codeagent.repository;

import com.yuzhe.codeagent.domain.AgentTaskEvent;
import java.time.LocalDateTime;
import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;

public interface AgentTaskEventRepository extends JpaRepository<AgentTaskEvent, Long> {

    List<AgentTaskEvent> findByTaskIdOrderByCreatedAtAsc(Long taskId);

    List<AgentTaskEvent> findByTaskIdAndCreatedAtAfterOrderByCreatedAtAsc(Long taskId, LocalDateTime createdAt);
}
