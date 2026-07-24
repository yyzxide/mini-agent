import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { z } from "zod";
import { PermissionLevel } from "../permission/PermissionLevel.js";
import { PermissionManager } from "../permission/PermissionManager.js";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import { toolFailure, toolSuccess } from "./Tool.js";
import { formatNetworkError } from "../utils/network.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 200_000;
const HARD_MAX_BYTES = 1_000_000;
const DEFAULT_MAX_OUTPUT_CHARS = 20_000;
const MAX_REDIRECTS = 5;
type TestFetchTransport = (url: URL, signal: AbortSignal) => Promise<Response>;
let testFetchTransport: TestFetchTransport | undefined;

export function setFetchUrlTransportForTesting(transport: TestFetchTransport | undefined): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Fetch URL test transport can only be configured in the test environment");
  }
  testFetchTransport = transport;
}

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
  readonly permissionLevel = PermissionLevel.REVIEW;
  readonly metadata = {
    category: "web" as const,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  };

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
    if (parsedUrl.username || parsedUrl.password) {
      return toolFailure("URL_CREDENTIALS_NOT_ALLOWED", "Credentials embedded in URLs are not allowed");
    }

    if (isBlockedNetworkTarget(parsedUrl.hostname)) {
      return toolFailure("BLOCKED_NETWORK_TARGET", "Refusing to fetch localhost or private network targets", {
        hostname: parsedUrl.hostname,
      });
    }

    const permissionManager = context.permissionManager ?? new PermissionManager();
    const permission = await permissionManager.check({
      level: PermissionLevel.REVIEW,
      action: "fetch_url",
      description: `Fetch public URL: ${parsedUrl.toString()}`,
      ...(context.nonInteractive === undefined ? {} : { nonInteractive: context.nonInteractive }),
      ...(context.autoApprove === undefined ? {} : { autoApprove: context.autoApprove }),
    });

    if (!permission.allowed) {
      return toolFailure("FETCH_URL_PERMISSION_DENIED", permission.reason ?? "URL fetch permission denied", {
        permission,
        url: parsedUrl.toString(),
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs);

    try {
      const fetched = await fetchWithValidatedRedirects(parsedUrl, controller.signal, input.maxBytes);
      const response = fetched.response;
      if (!response.ok) {
        return toolFailure("FETCH_URL_HTTP_ERROR", `URL returned HTTP ${String(response.status)} ${response.statusText}`.trim(), {
          url: parsedUrl.toString(),
          finalUrl: fetched.finalUrl.toString(),
          status: response.status,
          statusText: response.statusText,
        });
      }

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
      const unusableContent = classifyUnusableFetchedContent(rawText, normalizedText);
      if (unusableContent) {
        return toolFailure("FETCH_URL_CONTENT_UNUSABLE", "URL returned an access challenge, login shell, or other non-article response instead of readable evidence", {
          url: parsedUrl.toString(),
          finalUrl: fetched.finalUrl.toString(),
          status: response.status,
          reason: unusableContent,
        });
      }
      const maxOutputChars = context.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
      const outputTruncated = normalizedText.length > maxOutputChars;
      const text = outputTruncated ? normalizedText.slice(0, maxOutputChars) : normalizedText;

      return toolSuccess(
        {
          url: parsedUrl.toString(),
          finalUrl: fetched.finalUrl.toString(),
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

      if (error instanceof BlockedNetworkTargetError) {
        return toolFailure("BLOCKED_NETWORK_TARGET", "Refusing to fetch localhost or private network targets", {
          target: error.target,
          reason: error.message,
        });
      }

      if (error instanceof TooManyRedirectsError) {
        return toolFailure("TOO_MANY_REDIRECTS", error.message, {
          url: parsedUrl.toString(),
          maxRedirects: MAX_REDIRECTS,
        });
      }

      if (error instanceof UnsupportedRedirectError) {
        return toolFailure("UNSUPPORTED_REDIRECT", error.message, {
          url: parsedUrl.toString(),
          location: error.location,
        });
      }

      return toolFailure("FETCH_URL_FAILED", formatNetworkError(error, "URL fetch failed"), {
        url: parsedUrl.toString(),
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function fetchWithValidatedRedirects(
  startUrl: URL,
  signal: AbortSignal,
  maxBytes: number,
): Promise<{ response: Response; finalUrl: URL }> {
  let currentUrl = startUrl;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const addresses = await resolvePublicHttpAddresses(currentUrl);
    const response = testFetchTransport
      ? await testFetchTransport(currentUrl, signal)
      : await requestPinned(currentUrl, addresses[0]!, signal, maxBytes + 1);

    if (!isRedirectStatus(response.status)) {
      return { response, finalUrl: currentUrl };
    }

    const location = response.headers.get("location");
    if (!location) {
      return { response, finalUrl: currentUrl };
    }

    const nextUrl = new URL(location, currentUrl);
    if (nextUrl.protocol !== "http:" && nextUrl.protocol !== "https:") {
      throw new UnsupportedRedirectError(`Redirect target uses unsupported protocol: ${nextUrl.protocol}`, location);
    }

    currentUrl = nextUrl;
  }

  throw new TooManyRedirectsError(`URL redirected more than ${MAX_REDIRECTS} times`);
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

async function resolvePublicHttpAddresses(url: URL): Promise<ResolvedAddress[]> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsupportedRedirectError(`Unsupported protocol: ${url.protocol}`, url.toString());
  }
  if (url.username || url.password) {
    throw new UnsupportedRedirectError("Credentials embedded in redirect URLs are not allowed", url.toString());
  }

  if (isBlockedNetworkTarget(url.hostname)) {
    throw new BlockedNetworkTargetError(`Blocked hostname: ${url.hostname}`, url.hostname);
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const literalFamily = net.isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    return [{ address: hostname, family: literalFamily }];
  }

  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) {
    throw new Error(`DNS lookup returned no addresses for ${url.hostname}`);
  }

  for (const address of addresses) {
    if (isBlockedNetworkTarget(address.address)) {
      throw new BlockedNetworkTargetError(
        `DNS lookup for ${url.hostname} resolved to blocked address ${address.address}`,
        `${url.hostname} -> ${address.address}`,
      );
    }
  }
  return addresses.map((address) => {
    if (address.family !== 4 && address.family !== 6) {
      throw new Error(`DNS lookup returned unsupported address family ${String(address.family)}`);
    }
    return { address: address.address, family: address.family };
  });
}

function requestHeaders(): Record<string, string> {
  return {
    "accept": "text/html,application/xhtml+xml,application/json,text/plain,application/xml;q=0.9,*/*;q=0.1",
    "user-agent": "mini-coding-agent/0.1",
  };
}

async function requestPinned(
  url: URL,
  address: ResolvedAddress,
  signal: AbortSignal,
  maxBytes: number,
): Promise<Response> {
  return await new Promise<Response>((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(url, {
      method: "GET",
      headers: requestHeaders(),
      lookup: createPinnedLookup(address),
    }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        const headers = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) value.forEach((item) => headers.append(key, item));
          else if (value !== undefined) headers.set(key, value);
        }
        resolve(new Response(Buffer.concat(chunks, Math.min(bytes, maxBytes)), {
          status: response.statusCode ?? 500,
          statusText: response.statusMessage ?? "",
          headers,
        }));
      };
      response.on("data", (chunk: Buffer) => {
        const remaining = maxBytes - bytes;
        if (remaining <= 0) return;
        chunks.push(chunk.subarray(0, remaining));
        bytes += Math.min(chunk.length, remaining);
        if (bytes >= maxBytes) {
          finish();
          response.destroy();
        }
      });
      response.once("end", finish);
      response.once("error", (error) => {
        if (!settled) reject(error);
      });
    });
    request.once("error", reject);
    const abort = (): void => {
      request.destroy(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    request.once("close", () => signal.removeEventListener("abort", abort));
    request.end();
  });
}

export function createPinnedLookup(address: ResolvedAddress): net.LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all === true) {
      callback(null, [{ address: address.address, family: address.family }]);
      return;
    }
    callback(null, address.address, address.family);
  };
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
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
  const ipv4MappedAddress = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4MappedAddress?.[1]) {
    return isPrivateIpv4(ipv4MappedAddress[1]);
  }

  return normalized === "::"
    || normalized === "::1"
    || normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || normalized.startsWith("fe80:");
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

function classifyUnusableFetchedContent(rawText: string, normalizedText: string): string | undefined {
  const raw = rawText.trim().toLowerCase();
  const text = normalizedText.toLowerCase();

  if (
    /^["{[]/.test(raw)
    && /(?:["_](?:waf|captcha)[\w-]*"|"(?:captcha|challenge|verify_url|risk_control)")\s*:/i.test(raw)
  ) {
    return "structured access-challenge payload";
  }

  const strongChallenge = /(?:verify you are human|checking your browser|attention required.{0,20}cloudflare|cloudflare ray id|enable javascript and cookies to continue|访问过于频繁|安全验证|人机验证|请输入验证码|滑动验证|请完成验证|waf verification)/i;
  if (strongChallenge.test(text)) {
    return "access challenge or CAPTCHA";
  }

  if (
    text.length < 1_200
    && /(?:access denied|request blocked|temporarily blocked|登录后(?:查看|继续)|请先登录|需要登录)|(?:sign in|log in).{0,24}(?:continue|view|access)/i.test(text)
  ) {
    return "access-denied or login-only shell";
  }

  return undefined;
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

class BlockedNetworkTargetError extends Error {
  readonly target: string;

  constructor(message: string, target: string) {
    super(message);
    this.name = "BlockedNetworkTargetError";
    this.target = target;
  }
}

class TooManyRedirectsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TooManyRedirectsError";
  }
}

class UnsupportedRedirectError extends Error {
  readonly location: string;

  constructor(message: string, location: string) {
    super(message);
    this.name = "UnsupportedRedirectError";
    this.location = location;
  }
}
