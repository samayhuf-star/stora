import type { z } from 'zod';

export interface LLMUsage {
  input: number;
  output: number;
}

export interface JsonRequest<T> {
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  maxTokens?: number;
  temperature?: number;
}

export interface LLM {
  readonly provider: 'anthropic' | 'google' | 'mock' | 'none';
  readonly model: string;
  /** False when no API key is configured: agents then use their heuristic path */
  readonly available: boolean;
  usage(): LLMUsage;
  /** Structured generation: the reply is parsed and validated against `schema` (one automatic repair attempt) */
  json<T>(req: JsonRequest<T>): Promise<T>;
  /** New handle with fresh token counters (one per agent step) */
  fork(): LLM;
}

export interface CreateLLMOptions {
  provider?: 'anthropic' | 'google' | 'none';
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export const DEFAULT_MODELS = {
  anthropic: 'claude-sonnet-5-5',
  google: 'gemini-2.0-flash',
} as const;

/** Picks a provider from env: explicit STORA_LLM_PROVIDER, else whichever key exists. */
export function createLLM(opts: CreateLLMOptions = {}): LLM {
  const env = process.env;
  let provider = opts.provider ?? (env.STORA_LLM_PROVIDER as CreateLLMOptions['provider']);
  const anthropicKey = opts.apiKey ?? env.ANTHROPIC_API_KEY;
  const googleKey = opts.apiKey ?? env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!provider) provider = env.ANTHROPIC_API_KEY ? 'anthropic' : env.GOOGLE_GENERATIVE_AI_API_KEY ? 'google' : 'none';

  if (provider === 'none') return new NoLLM();
  const apiKey = provider === 'anthropic' ? anthropicKey : googleKey;
  if (!apiKey) return new NoLLM();
  return new HttpLLM({
    provider,
    apiKey,
    model: opts.model ?? env.STORA_LLM_MODEL ?? DEFAULT_MODELS[provider],
    baseUrl: opts.baseUrl,
    fetchImpl: opts.fetch ?? fetch,
    timeoutMs: opts.timeoutMs ?? 90_000,
  });
}

class NoLLM implements LLM {
  readonly provider = 'none' as const;
  readonly model = 'none';
  readonly available = false;
  usage() {
    return { input: 0, output: 0 };
  }
  async json<T>(): Promise<T> {
    throw new Error('No LLM configured (set ANTHROPIC_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY)');
  }
  fork() {
    return this;
  }
}

/** Tolerant JSON extraction: strips code fences and surrounding prose. */
export function extractJson(text: string): unknown {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.search(/[\[{]/);
  if (start > 0) t = t.slice(start);
  const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (end >= 0) t = t.slice(0, end + 1);
  return JSON.parse(t);
}

interface HttpOpts {
  provider: 'anthropic' | 'google';
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}

class HttpLLM implements LLM {
  readonly available = true;
  readonly provider: 'anthropic' | 'google';
  readonly model: string;
  private used: LLMUsage = { input: 0, output: 0 };

  constructor(private o: HttpOpts) {
    this.provider = o.provider;
    this.model = o.model;
  }

  usage() {
    return { ...this.used };
  }

  fork(): LLM {
    return new HttpLLM(this.o);
  }

  async json<T>(req: JsonRequest<T>): Promise<T> {
    const system = `${req.system}\n\nRespond with a single JSON object only. No prose, no markdown fences.`;
    let prompt = req.prompt;
    let lastError = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const text = await this.complete(system, prompt, req.maxTokens ?? 4096, req.temperature ?? 0.3);
      try {
        return req.schema.parse(extractJson(text));
      } catch (e) {
        lastError = e instanceof Error ? e.message.slice(0, 600) : String(e);
        prompt = `${req.prompt}\n\nYour previous reply was invalid: ${lastError}\nReturn corrected JSON only.`;
      }
    }
    throw new Error(`LLM returned invalid JSON after repair attempt: ${lastError}`);
  }

  private async complete(system: string, prompt: string, maxTokens: number, temperature: number): Promise<string> {
    const { provider, apiKey, model, fetchImpl, timeoutMs } = this.o;
    const url =
      provider === 'anthropic'
        ? `${this.o.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`
        : `${this.o.baseUrl ?? 'https://generativelanguage.googleapis.com'}/v1beta/models/${model}:generateContent`;
    const headers: Record<string, string> =
      provider === 'anthropic'
        ? { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
        : { 'content-type': 'application/json', 'x-goog-api-key': apiKey };
    const body =
      provider === 'anthropic'
        ? { model, max_tokens: maxTokens, temperature, system, messages: [{ role: 'user', content: prompt }] }
        : {
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: 'application/json', maxOutputTokens: maxTokens, temperature },
          };

    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status === 429 || res.status >= 500) throw new Error(`LLM HTTP ${res.status}`);
        if (!res.ok) {
          // 4xx other than 429 will not get better on retry
          const detail = (await res.text()).slice(0, 300);
          throw Object.assign(new Error(`LLM HTTP ${res.status}: ${detail}`), { fatal: true });
        }
        const data = (await res.json()) as any;
        if (provider === 'anthropic') {
          this.used.input += data.usage?.input_tokens ?? 0;
          this.used.output += data.usage?.output_tokens ?? 0;
          return (data.content ?? []).map((c: { text?: string }) => c.text ?? '').join('');
        }
        this.used.input += data.usageMetadata?.promptTokenCount ?? 0;
        this.used.output += data.usageMetadata?.candidatesTokenCount ?? 0;
        return (data.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? '').join('');
      } catch (e) {
        lastErr = e as Error;
        if ((e as { fatal?: boolean }).fatal) break;
        await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
      }
    }
    throw lastErr ?? new Error('LLM request failed');
  }
}

/**
 * Deterministic in-process LLM for tests and offline demos. `handler` receives each
 * request and returns the object the model "would" reply with; it is still validated
 * against the caller's zod schema, so schema/contract bugs surface in tests.
 */
export function createScriptedLLM(handler: (req: { system: string; prompt: string }) => unknown): LLM {
  class Scripted implements LLM {
    readonly provider = 'mock' as const;
    readonly model = 'scripted';
    readonly available = true;
    private used = { input: 0, output: 0 };
    usage() {
      return { ...this.used };
    }
    fork() {
      return new Scripted();
    }
    async json<T>(req: JsonRequest<T>): Promise<T> {
      const out = await handler({ system: req.system, prompt: req.prompt });
      this.used.input += Math.ceil((req.system.length + req.prompt.length) / 4);
      this.used.output += Math.ceil(JSON.stringify(out).length / 4);
      return req.schema.parse(out);
    }
  }
  return new Scripted();
}
