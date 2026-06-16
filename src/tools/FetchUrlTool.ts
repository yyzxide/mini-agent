import net from "node:net";
import { z } from "zod";
import { PermissionLevel } from "../permission/PermissionLevel.js";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import { toolFailure, toolSuccess } from "./Tool.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 200_000;
const HARD_MAX_BYTES = 1_000_000;
const DEFAULT_MAX_OUTPUT_CHARS = 20_000;

const fetchUrlInputSchema = z.object({
  url: z.string().trim().url(),
  timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS),
  maxBytes: z.number().int().positive().max(HARD_MAX_BYTES).default(DEFAULT_MAX_BYTES),
  extractText: z.boolean().default(true),
});

type FetchUrlInput = z.infer<typeof fetchUrlInputSchema>;

export interface FetchUrlData {
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

export class FetchUrlTool implements Tool<FetchUrlInput, FetchUrlData> {
  readonly name = "fetch_url";
  readonly description = "Fetch a public HTTP(S) URL and return bounded text content.";
  readonly inputSchema = fetchUrlInputSchema;
  readonly permissionLevel = PermissionLevel.SAFE;

  async execute(input: FetchUrlInput, context: ToolContext): Promise<ToolResult<FetchUrlData>> {
    let parsedUrl: URL;

    try {
      parsedUrl = new URL(input.url);
    } catch {
      return toolFailure("INVALID_URL", `Invalid URL: ${input.url}`, { url: input.url });
    }

    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return toolFailure("UNSUPPORTED_URL_PROTOCOL", "Only http and https URLs are supported", {
        protocol: parsedUrl.protocol,
      });
    }

    if (isBlockedNetworkTarget(parsedUrl.hostname)) {
      return toolFailure("BLOCKED_NETWORK_TARGET", "Refusing to fetch localhost or private network targets", {
        hostname: parsedUrl.hostname,
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs);

    try {
      const response = await fetch(parsedUrl, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "accept": "text/html,application/xhtml+xml,application/json,text/plain,application/xml;q=0.9,*/*;q=0.1",
          "user-agent": "mini-coding-agent/0.1",
        },
      });

      const contentType = response.headers.get("content-type") ?? "";
      if (!isReadableContentType(contentType)) {
        return toolFailure("UNSUPPORTED_CONTENT_TYPE", "URL did not return readable text content", {
          contentType,
          status: response.status,
        });
      }

      const body = await readBoundedResponseBody(response, input.maxBytes);
      const rawText = body.bytes.length > 0 ? new TextDecoder("utf-8", { fatal: false }).decode(body.bytes) : "";
      const normalizedText = input.extractText && contentType.toLowerCase().includes("html")
        ? htmlToText(rawText)
        : normalizeText(rawText);
      const maxOutputChars = context.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
      const outputTruncated = normalizedText.length > maxOutputChars;
      const text = outputTruncated ? normalizedText.slice(0, maxOutputChars) : normalizedText;

      return toolSuccess(
        {
          url: parsedUrl.toString(),
          finalUrl: response.url || parsedUrl.toString(),
          status: response.status,
          statusText: response.statusText,
          contentType,
          text,
          bytesRead: body.bytesRead,
          truncated: body.truncated,
          outputTruncated,
        },
        {
          timeoutMs: input.timeoutMs,
          maxBytes: input.maxBytes,
          maxOutputChars,
        },
      );
    } catch (error) {
      if (isAbortError(error)) {
        return toolFailure("FETCH_URL_TIMEOUT", `URL fetch timed out after ${input.timeoutMs}ms`, {
          url: parsedUrl.toString(),
          timeoutMs: input.timeoutMs,
        });
      }

      return toolFailure("FETCH_URL_FAILED", error instanceof Error ? error.message : "URL fetch failed", {
        url: parsedUrl.toString(),
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function readBoundedResponseBody(response: Response, maxBytes: number): Promise<{
  bytes: Uint8Array;
  bytesRead: number;
  truncated: boolean;
}> {
  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    return {
      bytes: buffer.slice(0, maxBytes),
      bytesRead: Math.min(buffer.length, maxBytes),
      truncated: buffer.length > maxBytes,
    };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      const remaining = maxBytes - bytesRead;
      if (value.length > remaining) {
        chunks.push(value.slice(0, remaining));
        bytesRead += remaining;
        truncated = true;
        await reader.cancel();
        break;
      }

      chunks.push(value);
      bytesRead += value.length;

      if (bytesRead >= maxBytes) {
        truncated = true;
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  return { bytes, bytesRead, truncated };
}

function isReadableContentType(contentType: string): boolean {
  if (!contentType) {
    return true;
  }

  const normalized = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return normalized.startsWith("text/")
    || normalized === "application/json"
    || normalized === "application/ld+json"
    || normalized === "application/xml"
    || normalized === "application/xhtml+xml"
    || normalized === "application/javascript"
    || normalized === "application/x-javascript"
    || normalized.endsWith("+json")
    || normalized.endsWith("+xml");
}

function isBlockedNetworkTarget(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (
    normalized === "localhost"
    || normalized.endsWith(".localhost")
    || normalized.endsWith(".local")
  ) {
    return true;
  }

  const ipVersion = net.isIP(normalized);
  if (ipVersion === 4) {
    return isPrivateIpv4(normalized);
  }

  if (ipVersion === 6) {
    return isPrivateIpv6(normalized);
  }

  return false;
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }

  const [first = 0, second = 0] = parts;
  return first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 198 && (second === 18 || second === 19))
    || first >= 224;
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  return normalized === "::"
    || normalized === "::1"
    || normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || normalized.startsWith("fe80:")
    || normalized.startsWith("::ffff:127.")
    || normalized.startsWith("::ffff:10.")
    || normalized.startsWith("::ffff:192.168.");
}

function htmlToText(html: string): string {
  return normalizeText(decodeHtmlEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  ));
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => {
      const value = Number.parseInt(code, 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : "";
    });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
