import { embedText } from "./MemoryText.js";

export interface EmbeddingProvider {
  readonly id: string;
  embed(text: string): Promise<number[]>;
}

export class LocalHashEmbeddingProvider implements EmbeddingProvider {
  readonly id = "local-hash-v2";
  async embed(text: string): Promise<number[]> { return embedText(text); }
}

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;

  constructor(private readonly options: {
    baseUrl: string;
    apiKey: string;
    model: string;
    timeoutMs?: number;
  }) {
    this.id = `openai-compatible:${options.model}`;
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.options.apiKey}`,
      },
      body: JSON.stringify({ model: this.options.model, input: text }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
    });
    if (!response.ok) throw new Error(`Embedding API ${response.status}: ${await response.text()}`);
    const payload = await response.json() as { data?: Array<{ embedding?: unknown }> };
    const vector = payload.data?.[0]?.embedding;
    if (!Array.isArray(vector) || !vector.every((item) => typeof item === "number")) {
      throw new Error("Embedding API returned an invalid vector");
    }
    return vector;
  }
}

export function createEmbeddingProviderFromEnvironment(): EmbeddingProvider {
  const model = process.env.MINI_AGENT_EMBEDDING_MODEL;
  const apiKey = process.env.MINI_AGENT_EMBEDDING_API_KEY ?? process.env.MINI_AGENT_API_KEY;
  const baseUrl = process.env.MINI_AGENT_EMBEDDING_BASE_URL ?? process.env.MINI_AGENT_BASE_URL;
  return model && apiKey && baseUrl
    ? new OpenAICompatibleEmbeddingProvider({ model, apiKey, baseUrl })
    : new LocalHashEmbeddingProvider();
}
