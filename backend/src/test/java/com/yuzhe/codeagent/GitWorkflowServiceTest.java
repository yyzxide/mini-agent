package com.yuzhe.codeagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.yuzhe.codeagent.config.CodeAgentProperties;
import com.yuzhe.codeagent.domain.AgentGitWorkflow;
import com.yuzhe.codeagent.domain.AgentTask;
import com.yuzhe.codeagent.domain.AgentTaskEvent;
import com.yuzhe.codeagent.domain.AgentTaskLog;
import com.yuzhe.codeagent.dto.CommitChangesRequest;
import com.yuzhe.codeagent.dto.CreateBranchRequest;
import com.yuzhe.codeagent.dto.GeneratePrRequest;
import com.yuzhe.codeagent.enums.AgentEventType;
import com.yuzhe.codeagent.enums.AgentExecutionMode;
import com.yuzhe.codeagent.enums.AgentTaskStatus;
import com.yuzhe.codeagent.enums.GitWorkflowStatus;
import com.yuzhe.codeagent.git.CommitMessageGenerator;
import com.yuzhe.codeagent.git.PrDescriptionGenerator;
import com.yuzhe.codeagent.repository.AgentGitWorkflowRepository;
import com.yuzhe.codeagent.repository.AgentTaskEventRepository;
import com.yuzhe.codeagent.repository.AgentTaskLogRepository;
import com.yuzhe.codeagent.repository.AgentTaskRepository;
import com.yuzhe.codeagent.service.GitWorkflowService;
import com.yuzhe.codeagent.service.PathSecurityService;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.mockito.Mockito;

class GitWorkflowServiceTest {

    @TempDir
    Path tempDir;

    @Test
    void createsBranchAndWritesEvents() throws Exception {
        Path repo = createRepository("repo");
        Files.writeString(repo.resolve("demo.txt"), "changed\n");
        TestHarness harness = newHarness(task(repo, AgentExecutionMode.LOCAL, null));

        CreateBranchRequest request = new CreateBranchRequest();
        request.setBranchName("agent/task-1-test");
        var response = harness.service().createBranch(1L, request);

        assertThat(response.getStatus()).isEqualTo(GitWorkflowStatus.BRANCH_CREATED);
        assertThat(response.getWorkBranch()).isEqualTo("agent/task-1-test");
        assertThat(harness.eventTypes()).contains(AgentEventType.GIT_BRANCH_CREATE_STARTED, AgentEventType.GIT_BRANCH_CREATED);
    }

    @Test
    void commitsChangesAndGeneratesPrDraft() throws Exception {
        Path repo = createRepository("repo");
        Files.writeString(repo.resolve("demo.txt"), "changed\n");
        TestHarness harness = newHarness(task(repo, AgentExecutionMode.LOCAL, null));

        harness.service().createBranch(1L, new CreateBranchRequest());
        CommitChangesRequest commitRequest = new CommitChangesRequest();
        commitRequest.setCommitMessage("feat(agent): update demo");
        var commit = harness.service().commitChanges(1L, commitRequest);
        GeneratePrRequest prRequest = new GeneratePrRequest();
        prRequest.setTargetBranch("main");
        var draft = harness.service().generatePrDraft(1L, prRequest);

        assertThat(commit.getStatus()).isEqualTo(GitWorkflowStatus.COMMITTED);
        assertThat(commit.getCommitHash()).hasSize(40);
        assertThat(draft.getTitle()).isEqualTo("feat(agent): update demo");
        assertThat(draft.getDescription()).contains("demo.txt");
        assertThat(harness.eventTypes()).contains(AgentEventType.GIT_COMMITTED, AgentEventType.PR_DRAFT_GENERATED);
    }

    @Test
    void dockerModeUsesWorkspaceRepository() throws Exception {
        Path originalRepo = createRepository("source");
        Path sandboxRoot = Files.createDirectories(tempDir.resolve("sandboxes"));
        Path taskWorkspace = Files.createDirectories(sandboxRoot.resolve("task_1"));
        Path workspaceRepo = Files.createDirectories(taskWorkspace.resolve("repo"));
        initRepository(workspaceRepo);
        Files.writeString(workspaceRepo.resolve("demo.txt"), "workspace change\n");

        CodeAgentProperties properties = properties();
        properties.getSandbox().setWorkspaceRoot(sandboxRoot.toString());
        AgentTask task = task(originalRepo, AgentExecutionMode.DOCKER, taskWorkspace);
        TestHarness harness = newHarness(task, properties);

        var response = harness.service().createBranch(1L, new CreateBranchRequest());

        assertThat(response.getRepoPath()).isEqualTo(originalRepo.toString());
        assertThat(response.getWorkspaceRepoPath()).isEqualTo(workspaceRepo.toRealPath().toString());
        assertThat(readCurrentBranch(originalRepo)).isNotEqualTo(response.getWorkBranch());
        assertThat(readCurrentBranch(workspaceRepo)).isEqualTo(response.getWorkBranch());
    }

    private TestHarness newHarness(AgentTask task) {
        return newHarness(task, properties());
    }

    private TestHarness newHarness(AgentTask task, CodeAgentProperties properties) {
        AgentTaskRepository taskRepository = Mockito.mock(AgentTaskRepository.class);
        AgentGitWorkflowRepository workflowRepository = Mockito.mock(AgentGitWorkflowRepository.class);
        AgentTaskEventRepository eventRepository = Mockito.mock(AgentTaskEventRepository.class);
        AgentTaskLogRepository logRepository = Mockito.mock(AgentTaskLogRepository.class);
        AtomicReference<AgentGitWorkflow> workflow = new AtomicReference<>();
        List<AgentTaskEvent> events = new ArrayList<>();

        when(taskRepository.findById(1L)).thenReturn(Optional.of(task));
        when(workflowRepository.findByTaskId(1L)).thenAnswer(invocation -> Optional.ofNullable(workflow.get()));
        when(workflowRepository.save(any(AgentGitWorkflow.class))).thenAnswer(invocation -> {
            AgentGitWorkflow saved = invocation.getArgument(0);
            if (saved.getId() == null) {
                saved.setId(1L);
            }
            workflow.set(saved);
            return saved;
        });
        when(eventRepository.save(any(AgentTaskEvent.class))).thenAnswer(invocation -> {
            AgentTaskEvent event = invocation.getArgument(0);
            events.add(event);
            return event;
        });
        when(logRepository.save(any(AgentTaskLog.class))).thenAnswer(invocation -> invocation.getArgument(0));

        GitWorkflowService service = new GitWorkflowService(
                taskRepository,
                workflowRepository,
                eventRepository,
                logRepository,
                new PathSecurityService(properties),
                new CommitMessageGenerator(),
                new PrDescriptionGenerator(),
                new ObjectMapper());
        return new TestHarness(service, events);
    }

    private CodeAgentProperties properties() {
        CodeAgentProperties properties = new CodeAgentProperties();
        properties.setWorkspaceRoot(tempDir.toString());
        properties.getSandbox().setWorkspaceRoot(tempDir.resolve("sandboxes").toString());
        return properties;
    }

    private AgentTask task(Path repo, AgentExecutionMode mode, Path workspacePath) {
        AgentTask task = new AgentTask();
        task.setId(1L);
        task.setTaskNo("TASK-1");
        task.setRepoPath(repo.toString());
        task.setSourceRepoPath(repo.toString());
        task.setExecutionMode(mode);
        task.setWorkspacePath(workspacePath == null ? null : workspacePath.toString());
        task.setUserGoal("demo: update demo file");
        task.setStatus(AgentTaskStatus.COMPLETED);
        task.setMaxSteps(20);
        task.setFinalSummary("tests passed");
        return task;
    }

    private Path createRepository(String name) throws Exception {
        Path repo = Files.createDirectory(tempDir.resolve(name));
        initRepository(repo);
        return repo.toRealPath();
    }

    private void initRepository(Path repo) throws Exception {
        run(repo, "git", "init");
        run(repo, "git", "config", "user.email", "mini-agent@example.com");
        run(repo, "git", "config", "user.name", "Mini Agent");
        Files.writeString(repo.resolve("demo.txt"), "initial\n");
        run(repo, "git", "add", "demo.txt");
        run(repo, "git", "commit", "-m", "init");
    }

    private String readCurrentBranch(Path repo) throws Exception {
        Process process = new ProcessBuilder("git", "branch", "--show-current")
                .directory(repo.toFile())
                .start();
        int exitCode = process.waitFor();
        if (exitCode != 0) {
            throw new IllegalStateException(new String(process.getErrorStream().readAllBytes()));
        }
        return new String(process.getInputStream().readAllBytes()).trim();
    }

    private void run(Path cwd, String... command) throws Exception {
        Process process = new ProcessBuilder(command)
                .directory(cwd.toFile())
                .start();
        int exitCode = process.waitFor();
        if (exitCode != 0) {
            throw new IllegalStateException(new String(process.getErrorStream().readAllBytes()));
        }
    }

    private record TestHarness(GitWorkflowService service, List<AgentTaskEvent> events) {

        List<AgentEventType> eventTypes() {
            return events.stream().map(AgentTaskEvent::getEventType).toList();
        }
    }
}
