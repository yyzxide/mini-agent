package com.yuzhe.codeagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.yuzhe.codeagent.config.CodeAgentProperties;
import com.yuzhe.codeagent.domain.AgentTask;
import com.yuzhe.codeagent.dto.CreateAgentTaskRequest;
import com.yuzhe.codeagent.enums.AgentExecutionMode;
import com.yuzhe.codeagent.enums.AgentTaskStatus;
import com.yuzhe.codeagent.repository.AgentSandboxRepository;
import com.yuzhe.codeagent.repository.AgentTaskEventRepository;
import com.yuzhe.codeagent.repository.AgentTaskLogRepository;
import com.yuzhe.codeagent.repository.AgentTaskRepository;
import com.yuzhe.codeagent.service.AgentTaskService;
import com.yuzhe.codeagent.service.DockerSandboxService;
import com.yuzhe.codeagent.service.EventReadService;
import com.yuzhe.codeagent.service.PathSecurityService;
import com.yuzhe.codeagent.service.RunnerProcessService;
import com.yuzhe.codeagent.service.SessionReadService;
import com.yuzhe.codeagent.service.WorkspaceService;
import com.yuzhe.codeagent.service.WorkspaceService.WorkspacePaths;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.mockito.Mockito;

class AgentTaskServiceTest {

    @TempDir
    Path tempDir;

    @Test
    void createsLocalTaskAndStartsRunner() throws Exception {
        Path repo = Files.createDirectory(tempDir.resolve("repo"));
        CodeAgentProperties properties = properties();
        AgentTaskRepository taskRepository = Mockito.mock(AgentTaskRepository.class);
        RunnerProcessService runnerProcessService = Mockito.mock(RunnerProcessService.class);
        DockerSandboxService dockerSandboxService = Mockito.mock(DockerSandboxService.class);
        AgentSandboxRepository sandboxRepository = Mockito.mock(AgentSandboxRepository.class);
        AtomicReference<AgentTask> saved = mockTaskRepository(taskRepository);
        when(sandboxRepository.findByTaskId(1L)).thenReturn(Optional.empty());

        AgentTaskService service = newService(
                taskRepository,
                runnerProcessService,
                dockerSandboxService,
                Mockito.mock(WorkspaceService.class),
                sandboxRepository,
                properties);

        CreateAgentTaskRequest request = request(repo, AgentExecutionMode.LOCAL);

        var response = service.createAndStart(request);

        assertThat(response.getId()).isEqualTo(1L);
        assertThat(response.getExecutionMode()).isEqualTo(AgentExecutionMode.LOCAL);
        verify(runnerProcessService).startTask(saved.get());
        verify(dockerSandboxService, never()).startTask(any());
    }

    @Test
    void createsDockerTaskAndStartsSandbox() throws Exception {
        Path repo = Files.createDirectory(tempDir.resolve("repo"));
        Path workspace = Files.createDirectories(tempDir.resolve("sandboxes/task_1"));
        Path repoWorkspace = Files.createDirectories(workspace.resolve("repo"));
        CodeAgentProperties properties = properties();
        AgentTaskRepository taskRepository = Mockito.mock(AgentTaskRepository.class);
        RunnerProcessService runnerProcessService = Mockito.mock(RunnerProcessService.class);
        DockerSandboxService dockerSandboxService = Mockito.mock(DockerSandboxService.class);
        WorkspaceService workspaceService = Mockito.mock(WorkspaceService.class);
        AgentSandboxRepository sandboxRepository = Mockito.mock(AgentSandboxRepository.class);
        AtomicReference<AgentTask> saved = mockTaskRepository(taskRepository);
        when(workspaceService.createWorkspace(1L, repo.toRealPath())).thenReturn(new WorkspacePaths(workspace, repoWorkspace, workspace.resolve("logs")));
        when(sandboxRepository.findByTaskId(1L)).thenReturn(Optional.empty());

        AgentTaskService service = newService(
                taskRepository,
                runnerProcessService,
                dockerSandboxService,
                workspaceService,
                sandboxRepository,
                properties);

        var response = service.createAndStart(request(repo, AgentExecutionMode.DOCKER));

        assertThat(response.getExecutionMode()).isEqualTo(AgentExecutionMode.DOCKER);
        assertThat(saved.get().getWorkspacePath()).isEqualTo(workspace.toString());
        verify(dockerSandboxService).startTask(saved.get());
        verify(runnerProcessService, never()).startTask(any());
    }

    @Test
    void updatesTaskStatus() {
        CodeAgentProperties properties = properties();
        AgentTaskRepository taskRepository = Mockito.mock(AgentTaskRepository.class);
        AgentSandboxRepository sandboxRepository = Mockito.mock(AgentSandboxRepository.class);
        AgentTask task = savedTask(tempDir, AgentExecutionMode.LOCAL);
        when(taskRepository.findById(1L)).thenReturn(Optional.of(task));
        when(taskRepository.save(any(AgentTask.class))).thenAnswer(invocation -> invocation.getArgument(0));
        when(sandboxRepository.findByTaskId(1L)).thenReturn(Optional.empty());

        AgentTaskService service = newService(
                taskRepository,
                Mockito.mock(RunnerProcessService.class),
                Mockito.mock(DockerSandboxService.class),
                Mockito.mock(WorkspaceService.class),
                sandboxRepository,
                properties);

        var response = service.updateStatus(1L, AgentTaskStatus.COMPLETED);

        assertThat(response.getStatus()).isEqualTo(AgentTaskStatus.COMPLETED);
        assertThat(response.getFinishedAt()).isNotNull();
    }

    @Test
    void cancelLocalTaskUsesRunnerProcessService() {
        CodeAgentProperties properties = properties();
        AgentTaskRepository taskRepository = Mockito.mock(AgentTaskRepository.class);
        RunnerProcessService runnerProcessService = Mockito.mock(RunnerProcessService.class);
        DockerSandboxService dockerSandboxService = Mockito.mock(DockerSandboxService.class);
        AgentSandboxRepository sandboxRepository = Mockito.mock(AgentSandboxRepository.class);
        AgentTask task = savedTask(tempDir, AgentExecutionMode.LOCAL);
        when(taskRepository.findById(1L)).thenReturn(Optional.of(task));
        when(taskRepository.save(any(AgentTask.class))).thenAnswer(invocation -> invocation.getArgument(0));
        when(sandboxRepository.findByTaskId(1L)).thenReturn(Optional.empty());

        AgentTaskService service = newService(
                taskRepository,
                runnerProcessService,
                dockerSandboxService,
                Mockito.mock(WorkspaceService.class),
                sandboxRepository,
                properties);

        var response = service.cancel(1L);

        verify(runnerProcessService).cancelTask(1L);
        verify(dockerSandboxService, never()).cancelTask(1L);
        assertThat(response.getStatus()).isEqualTo(AgentTaskStatus.CANCELLED);
    }

    @Test
    void cancelDockerTaskUsesDockerSandboxService() {
        CodeAgentProperties properties = properties();
        AgentTaskRepository taskRepository = Mockito.mock(AgentTaskRepository.class);
        RunnerProcessService runnerProcessService = Mockito.mock(RunnerProcessService.class);
        DockerSandboxService dockerSandboxService = Mockito.mock(DockerSandboxService.class);
        AgentSandboxRepository sandboxRepository = Mockito.mock(AgentSandboxRepository.class);
        AgentTask task = savedTask(tempDir, AgentExecutionMode.DOCKER);
        when(taskRepository.findById(1L)).thenReturn(Optional.of(task));
        when(taskRepository.save(any(AgentTask.class))).thenAnswer(invocation -> invocation.getArgument(0));
        when(sandboxRepository.findByTaskId(1L)).thenReturn(Optional.empty());

        AgentTaskService service = newService(
                taskRepository,
                runnerProcessService,
                dockerSandboxService,
                Mockito.mock(WorkspaceService.class),
                sandboxRepository,
                properties);

        service.cancel(1L);

        verify(dockerSandboxService).cancelTask(1L);
        verify(runnerProcessService, never()).cancelTask(1L);
    }

    private AgentTaskService newService(
            AgentTaskRepository taskRepository,
            RunnerProcessService runnerProcessService,
            DockerSandboxService dockerSandboxService,
            WorkspaceService workspaceService,
            AgentSandboxRepository sandboxRepository,
            CodeAgentProperties properties) {
        return new AgentTaskService(
                taskRepository,
                Mockito.mock(AgentTaskEventRepository.class),
                Mockito.mock(AgentTaskLogRepository.class),
                runnerProcessService,
                dockerSandboxService,
                workspaceService,
                sandboxRepository,
                Mockito.mock(SessionReadService.class),
                Mockito.mock(EventReadService.class),
                new PathSecurityService(properties),
                properties);
    }

    private AtomicReference<AgentTask> mockTaskRepository(AgentTaskRepository taskRepository) {
        AtomicReference<AgentTask> saved = new AtomicReference<>();
        when(taskRepository.save(any(AgentTask.class))).thenAnswer(invocation -> {
            AgentTask task = invocation.getArgument(0);
            task.setId(1L);
            saved.set(task);
            return task;
        });
        when(taskRepository.findById(1L)).thenAnswer(invocation -> Optional.of(saved.get()));
        return saved;
    }

    private CreateAgentTaskRequest request(Path repo, AgentExecutionMode executionMode) {
        CreateAgentTaskRequest request = new CreateAgentTaskRequest();
        request.setRepoPath(repo.toString());
        request.setUserGoal("demo");
        request.setExecutionMode(executionMode);
        return request;
    }

    private CodeAgentProperties properties() {
        CodeAgentProperties properties = new CodeAgentProperties();
        properties.setWorkspaceRoot(tempDir.toString());
        properties.getSandbox().setWorkspaceRoot(tempDir.resolve("sandboxes").toString());
        return properties;
    }

    private AgentTask savedTask(Path repo, AgentExecutionMode executionMode) {
        AgentTask task = new AgentTask();
        task.setId(1L);
        task.setTaskNo("TASK-1");
        task.setRepoPath(repo.toString());
        task.setSourceRepoPath(repo.toString());
        task.setExecutionMode(executionMode);
        task.setUserGoal("demo");
        task.setStatus(AgentTaskStatus.RUNNING);
        task.setMaxSteps(20);
        return task;
    }
}
