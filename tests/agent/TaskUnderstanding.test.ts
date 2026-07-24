import { describe, expect, it } from "vitest";
import { understandTask } from "../../src/agent/TaskUnderstanding.js";

describe("TaskUnderstanding", () => {
  it("produces one structured interpretation for downstream policy", () => {
    expect(understandTask("请完整检查 src/core.ts 是否存在缺陷")).toMatchObject({
      operation: "REVIEW_REPOSITORY",
      target: "REPOSITORY",
      explicitRepositoryTarget: true,
      explicitMutation: false,
      completeFileRead: true,
    });
    expect(understandTask("更新 src/core.ts 并运行测试")).toMatchObject({
      operation: "CHANGE_REPOSITORY",
      target: "REPOSITORY",
      explicitMutation: true,
    });
  });

  it("separates general concepts from repository actions with similar words", () => {
    expect(understandTask("什么是项目管理")).toMatchObject({
      operation: "ANSWER",
      explicitRepositoryTarget: false,
    });
    expect(understandTask("What is a file system?")).toMatchObject({
      operation: "ANSWER",
      explicitRepositoryTarget: false,
    });
    expect(understandTask("How do I create an account?")).toMatchObject({
      operation: "ANSWER",
      explicitMutation: false,
    });
  });

  it("keeps evidence decisions and answer shape in the same record", () => {
    expect(understandTask("这家公司有多少个公开披露的分支机构？")).toMatchObject({
      operation: "RESEARCH",
      target: "WORLD",
      answerShape: "COUNT",
      externalFactPolicy: "VERIFICATION_REQUIRED",
    });
    expect(understandTask("什么是内容寻址存储")).toMatchObject({
      operation: "ANSWER",
      answerShape: "DEFINITION",
    });
  });

  it("routes explicit natural-language subagent work to the repository runtime", () => {
    expect(understandTask("请用两个subagent，一个写功能代码，一个review")).toMatchObject({
      operation: "CHANGE_REPOSITORY",
      target: "REPOSITORY",
      explicitMutation: true,
      signals: expect.arrayContaining(["explicit-delegation"]),
    });
    expect(understandTask("我们有subagent能力吗？")).toMatchObject({
      operation: "LOCAL_STATE",
      target: "PRODUCT",
      explicitMutation: false,
    });
  });
});
