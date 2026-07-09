import { execFile } from "node:child_process";
import dns from "node:dns/promises";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ListFilesTool } from "../../src/tools/ListFilesTool.js";
import { ReadFileTool } from "../../src/tools/ReadFileTool.js";
import {
  createDefaultToolRegistry,
  ToolRegistry,
} from "../../src/tools/ToolRegistry.js";
import type { ToolResult } from "../../src/tools/Tool.js";

const execFileAsync = promisify(execFile);

interface ListFilesData {
  items: Array<{ path: string; type: "file" | "directory" }>;
}

interface ReadFileData {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
}

interface SearchCodeData {
  query: string;
  results: Array<{ path: string; line: number; text: string }>;
}

interface GitStatusData {
  status: string;
}

interface GitDiffData {
  diff: string;
  truncated: boolean;
}

interface FetchUrlData {
  url: string;
  finalUrl: string;
  status: number;
  statusText: string;
  contentType: string;
  text: string;
  bytesRead: number;
  truncated: boolean;
  outputTruncated: boolean;
}

interface WebSearchData {
  query: string;
  provider: "duckduckgo_html" | "duckduckgo_lite" | "auto";
  results: Array<{ title: string; url: string; snippet: string }>;
}

let tempRoot: string;
let repoPath: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-agent-tools-"));
  repoPath = path.join(tempRoot, "repo");

  await fs.mkdir(path.join(repoPath, "src"), { recursive: true });
  await fs.mkdir(path.join(repoPath, "node_modules", "left-pad"), { recursive: true });
  await fs.writeFile(path.join(repoPath, "README.md"), "# Demo Repo\n\nhello upload\n", "utf8");
  await fs.writeFile(path.join(repoPath, "src", "App.ts"), "export class UploadService {}\n", "utf8");
  await fs.writeFile(path.join(repoPath, "node_modules", "left-pad", "index.js"), "ignored\n", "utf8");
  await fs.writeFile(path.join(tempRoot, "outside.txt"), "outside\n", "utf8");

  await execFileAsync("git", ["init"], { cwd: repoPath });
  await execFileAsync("git", ["add", "README.md"], { cwd: repoPath });
  await fs.appendFile(path.join(repoPath, "README.md"), "\nchanged line\n", "utf8");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("ToolRegistry", () => {
  it("registers and executes tools with input validation", async () => {
    const registry = new ToolRegistry();
    registry.register(new ListFilesTool());

    expect(registry.list()).toEqual([
      {
        name: "list_files",
        description: "List files and directories under a repository path.",
        permissionLevel: "SAFE",
      },
    ]);

    const result = await registry.execute("list_files", { path: "." }, { repoPath });
    expectSuccess<ListFilesData>(result);
    expect(result.data.items.some((item) => item.path === "README.md")).toBe(true);
  });

  it("returns a structured error when a tool does not exist", async () => {
    const registry = createDefaultToolRegistry();

    const result = await registry.execute("missing_tool", {}, { repoPath });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("TOOL_NOT_FOUND");
  });

  it("returns a structured error when input is invalid", async () => {
    const registry = createDefaultToolRegistry();

    const result = await registry.execute("read_file", { path: "README.md", maxLines: 999 }, { repoPath });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INVALID_TOOL_INPUT");
  });

  it("marks fetch_url as a review-level tool", () => {
    const registry = createDefaultToolRegistry();

    expect(registry.list()).toContainEqual(expect.objectContaining({
      name: "fetch_url",
      permissionLevel: "REVIEW",
    }));
  });

  it("exposes a tool manifest with capability annotations", () => {
    const registry = createDefaultToolRegistry();

    expect(registry.listManifest()).toContainEqual(expect.objectContaining({
      name: "web_search",
      source: "local",
      category: "web",
      annotations: expect.objectContaining({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      }),
    }));
    expect(registry.listManifest()).toContainEqual(expect.objectContaining({
      name: "apply_patch",
      category: "patch",
      annotations: expect.objectContaining({
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      }),
    }));
  });

  it("exports local tools as MCP-style descriptors", () => {
    const registry = createDefaultToolRegistry();
    const descriptors = registry.listMcpToolDescriptors();

    expect(descriptors).toContainEqual(expect.objectContaining({
      name: "read_file",
      inputSchema: expect.objectContaining({ type: "object" }),
      annotations: expect.objectContaining({
        readOnlyHint: true,
        destructiveHint: false,
      }),
      metadata: expect.objectContaining({
        source: "local",
        permissionLevel: "SAFE",
      }),
    }));
  });
});

describe("read-only repository tools", () => {
  it("list_files lists files and ignores configured directories", async () => {
    const registry = createDefaultToolRegistry();

    const result = await registry.execute("list_files", { path: ".", maxDepth: 2 }, { repoPath });

    expectSuccess<ListFilesData>(result);
    expect(result.data.items).toContainEqual({ path: "README.md", type: "file" });
    expect(result.data.items).toContainEqual({ path: "src", type: "directory" });
    expect(result.data.items).toContainEqual({ path: "src/App.ts", type: "file" });
    expect(result.data.items.some((item) => item.path.startsWith("node_modules"))).toBe(false);
    expect(result.data.items.some((item) => item.path.startsWith(".git"))).toBe(false);
  });

  it("read_file reads a selected file range", async () => {
    const registry = createDefaultToolRegistry();

    const result = await registry.execute("read_file", {
      path: "README.md",
      startLine: 1,
      maxLines: 2,
    }, { repoPath });

    expectSuccess<ReadFileData>(result);
    expect(result.data.path).toBe("README.md");
    expect(result.data.startLine).toBe(1);
    expect(result.data.endLine).toBe(2);
    expect(result.data.content).toContain("# Demo Repo");
  });

  it("read_file prevents access outside the repository", async () => {
    const registry = createDefaultToolRegistry();

    const result = await registry.execute("read_file", { path: "../outside.txt" }, { repoPath });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("PATH_OUTSIDE_REPOSITORY");
    expect(result.error?.message).toBe("Path is outside repository");
  });

  it("search_code finds matching code with ripgrep", async () => {
    if (!(await hasRipgrep())) {
      return;
    }

    const registry = createDefaultToolRegistry();

    const result = await registry.execute("search_code", { query: "UploadService", path: "." }, { repoPath });

    expectSuccess<SearchCodeData>(result);
    expect(result.data.results).toContainEqual({
      path: "src/App.ts",
      line: 1,
      text: "export class UploadService {}",
    });
  });

  it("git_status returns status in a git repository", async () => {
    const registry = createDefaultToolRegistry();

    const result = await registry.execute("git_status", {}, { repoPath });

    expectSuccess<GitStatusData>(result);
    expect(result.data.status).toContain("README.md");
  });

  it("git_diff returns the current working tree diff", async () => {
    const registry = createDefaultToolRegistry();

    const result = await registry.execute("git_diff", {}, { repoPath });

    expectSuccess<GitDiffData>(result);
    expect(result.data.diff).toContain("+changed line");
    expect(result.data.truncated).toBe(false);
  });

  it("fetch_url returns bounded text content from a public URL", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const fetchMock = vi.fn(async () => new Response(
      "<html><head><style>.hidden{}</style></head><body><h1>Docs</h1><script>bad()</script><p>Hello &amp; welcome.</p></body></html>",
      {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/html; charset=utf-8" },
      },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const registry = createDefaultToolRegistry();

    const result = await registry.execute("fetch_url", {
      url: "https://example.com/docs",
      maxBytes: 500,
    }, fetchUrlContext());

    expectSuccess<FetchUrlData>(result);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
    expect(result.data.status).toBe(200);
    expect(result.data.contentType).toContain("text/html");
    expect(result.data.text).toContain("Docs");
    expect(result.data.text).toContain("Hello & welcome.");
    expect(result.data.text).not.toContain("bad()");
    expect(result.data.truncated).toBe(false);
  });

  it("fetch_url refuses localhost and private network targets", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const registry = createDefaultToolRegistry();

    const result = await registry.execute("fetch_url", { url: "http://localhost:8080" }, { repoPath });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("BLOCKED_NETWORK_TARGET");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetch_url refuses hostnames that resolve to private addresses", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const registry = createDefaultToolRegistry();

    const result = await registry.execute("fetch_url", { url: "https://example.com/private" }, fetchUrlContext());

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("BLOCKED_NETWORK_TARGET");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetch_url validates redirect targets before following them", async () => {
    const lookupMock = vi.spyOn(dns, "lookup");
    lookupMock.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]);
    const fetchMock = vi.fn(async () => new Response("", {
      status: 302,
      headers: { location: "http://127.0.0.1/admin" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const registry = createDefaultToolRegistry();

    const result = await registry.execute("fetch_url", { url: "https://example.com/start" }, fetchUrlContext());

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("BLOCKED_NETWORK_TARGET");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("fetch_url follows public redirects manually", async () => {
    const lookupMock = vi.spyOn(dns, "lookup");
    lookupMock
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValueOnce([{ address: "93.184.216.35", family: 4 }]);
    const fetchMock = vi.fn(async (url: URL) => {
      if (url.toString() === "https://example.com/start") {
        return new Response("", {
          status: 302,
          headers: { location: "https://docs.example.com/final" },
        });
      }

      return new Response("final docs", {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/plain" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const registry = createDefaultToolRegistry();

    const result = await registry.execute("fetch_url", { url: "https://example.com/start" }, fetchUrlContext());

    expectSuccess<FetchUrlData>(result);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.data.finalUrl).toBe("https://docs.example.com/final");
    expect(result.data.text).toBe("final docs");
  });

  it("fetch_url truncates long output by context limit", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("0123456789", {
      status: 200,
      headers: { "content-type": "text/plain" },
    })));
    const registry = createDefaultToolRegistry();

    const result = await registry.execute("fetch_url", {
      url: "https://example.com/plain",
      maxBytes: 100,
    }, { ...fetchUrlContext(), maxOutputChars: 4 });

    expectSuccess<FetchUrlData>(result);
    expect(result.data.text).toBe("0123");
    expect(result.data.outputTruncated).toBe(true);
  });

  it("fetch_url requires review permission", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const registry = createDefaultToolRegistry();

    const result = await registry.execute("fetch_url", { url: "https://example.com/plain" }, {
      repoPath,
      nonInteractive: true,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("FETCH_URL_PERMISSION_DENIED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("web_search returns parsed public web results", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response([
      "<html><body>",
      "<div class=\"result\">",
      "<a class=\"result__a\" href=\"/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs\">Example &amp; Docs</a>",
      "<a class=\"result__snippet\">A useful &lt;b&gt;documentation&lt;/b&gt; result.</a>",
      "</div>",
      "</body></html>",
    ].join(""), {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "text/html" },
    })));
    const registry = createDefaultToolRegistry();

    const result = await registry.execute("web_search", {
      query: "example docs",
      maxResults: 3,
    }, { repoPath });

    expectSuccess<WebSearchData>(result);
    expect(result.data.provider).toBe("duckduckgo_html");
    expect(result.data.results).toEqual([
      {
        title: "Example & Docs",
        url: "https://example.com/docs",
        snippet: "A useful documentation result.",
      },
    ]);
  });

  it("web_search falls back to duckduckgo lite when html results are empty", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const urlText = String(url);
      if (urlText.includes("duckduckgo.com/html")) {
        return new Response("<html><body><p>no parsed results</p></body></html>", {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "text/html" },
        });
      }

      return new Response([
        "<html><body><table>",
        "<tr><td><a href=\"/l/?uddg=https%3A%2F%2Fexample.com%2Flight\">Light &#x26; Docs</a></td></tr>",
        "<tr><td class=\"result-snippet\">Useful &#x64;ocumentation from lite.</td></tr>",
        "</table></body></html>",
      ].join(""), {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/html" },
      });
    }));
    const registry = createDefaultToolRegistry();

    const result = await registry.execute("web_search", {
      query: "lite docs",
      maxResults: 3,
    }, { repoPath });

    expectSuccess<WebSearchData>(result);
    expect(result.data.provider).toBe("duckduckgo_lite");
    expect(result.data.results).toEqual([
      {
        title: "Light & Docs",
        url: "https://example.com/light",
        snippet: "Useful documentation from lite.",
      },
    ]);
  });
});

function expectSuccess<T>(result: ToolResult<unknown>): asserts result is {
  success: true;
  data: T;
  metadata?: Record<string, unknown>;
} {
  expect(result.success).toBe(true);
  expect(result.data).toBeDefined();
}

async function hasRipgrep(): Promise<boolean> {
  try {
    await execFileAsync("rg", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

function fetchUrlContext(): { repoPath: string; autoApprove: true; nonInteractive: true } {
  return {
    repoPath,
    autoApprove: true,
    nonInteractive: true,
  };
}
