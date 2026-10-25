import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import { createLLM, extractJson } from '../src/index.js';

type Handler = (req: { url: string; headers: Record<string, any>; body: any }, n: number) => { status?: number; json: unknown };

async function fake(handler: Handler) {
  const calls: Array<{ url: string; headers: Record<string, any>; body: any }> = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const entry = { url: req.url!, headers: req.headers as any, body: JSON.parse(raw || '{}') };
      calls.push(entry);
      const out = handler(entry, calls.length);
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.json));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const anthropicReply = (text: string, i = 10, o = 5) => ({ json: { content: [{ type: 'text', text }], usage: { input_tokens: i, output_tokens: o } } });
const schema = z.object({ answer: z.number() });
let srv: Awaited<ReturnType<typeof fake>> | null = null;
afterEach(async () => {
  await srv?.close();
  srv = null;
});

describe('extractJson', () => {
  it('handles fences and surrounding prose', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! Here you go: {"a": {"b": [1,2]}} hope that helps')).toEqual({ a: { b: [1, 2] } });
  });
});

describe('Anthropic client', () => {
  it('sends the right request, parses fenced JSON and tracks tokens per fork', async () => {
    srv = await fake(() => anthropicReply('```json\n{"answer": 42}\n```', 120, 30));
    const llm = createLLM({ provider: 'anthropic', apiKey: 'sk-test', baseUrl: srv.baseUrl });
    expect(llm.available).toBe(true);
    expect(llm.model).toBe('claude-sonnet-5-5');
    const a = llm.fork();
    expect(await a.json({ system: 'sys', prompt: 'p', schema, maxTokens: 100 })).toEqual({ answer: 42 });
    expect(a.usage()).toEqual({ input: 120, output: 30 });
    expect(llm.fork().usage()).toEqual({ input: 0, output: 0 });
    const c = srv.calls[0];
    expect(c.url).toBe('/v1/messages');
    expect(c.headers['x-api-key']).toBe('sk-test');
    expect(c.headers['anthropic-version']).toBe('2023-06-01');
    expect(c.body).toMatchObject({ model: 'claude-sonnet-5-5', max_tokens: 100, messages: [{ role: 'user', content: 'p' }] });
    expect(c.body.system).toContain('sys');
  });

  it('makes one repair attempt on invalid output, then succeeds', async () => {
    srv = await fake((_r, n) => anthropicReply(n === 1 ? '{"answer": "not a number"}' : '{"answer": 7}'));
    const llm = createLLM({ provider: 'anthropic', apiKey: 'k', baseUrl: srv.baseUrl });
    expect(await llm.json({ system: 's', prompt: 'p', schema })).toEqual({ answer: 7 });
    expect(srv.calls).toHaveLength(2);
    expect(srv.calls[1].body.messages[0].content).toContain('previous reply was invalid');
  });

  it('throws after the repair attempt also fails', async () => {
    srv = await fake(() => anthropicReply('I cannot do that'));
    const llm = createLLM({ provider: 'anthropic', apiKey: 'k', baseUrl: srv.baseUrl });
    await expect(llm.json({ system: 's', prompt: 'p', schema })).rejects.toThrow(/invalid JSON/);
    expect(srv.calls).toHaveLength(2);
  });

  it('retries 5xx with backoff but not 4xx', async () => {
    srv = await fake((_r, n) => (n < 3 ? { status: 529, json: { error: 'overloaded' } } : anthropicReply('{"answer": 1}')));
    const llm = createLLM({ provider: 'anthropic', apiKey: 'k', baseUrl: srv.baseUrl });
    expect(await llm.json({ system: 's', prompt: 'p', schema })).toEqual({ answer: 1 });
    expect(srv.calls).toHaveLength(3);
    await srv.close();

    srv = await fake(() => ({ status: 401, json: { error: 'bad key' } }));
    const bad = createLLM({ provider: 'anthropic', apiKey: 'k', baseUrl: srv.baseUrl });
    await expect(bad.json({ system: 's', prompt: 'p', schema })).rejects.toThrow(/HTTP 401/);
    expect(srv.calls).toHaveLength(1);
  });
});

describe('Gemini client', () => {
  it('uses generateContent with JSON mime type and reads usage metadata', async () => {
    srv = await fake(() => ({ json: { candidates: [{ content: { parts: [{ text: '{"answer": 3}' }] } }], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 8 } } }));
    const llm = createLLM({ provider: 'google', apiKey: 'g-key', baseUrl: srv.baseUrl });
    const f = llm.fork();
    expect(await f.json({ system: 's', prompt: 'p', schema })).toEqual({ answer: 3 });
    expect(f.usage()).toEqual({ input: 50, output: 8 });
    const c = srv.calls[0];
    expect(c.url).toBe('/v1beta/models/gemini-2.0-flash:generateContent');
    expect(c.headers['x-goog-api-key']).toBe('g-key');
    expect(c.body.generationConfig.responseMimeType).toBe('application/json');
  });
});

describe('provider selection', () => {
  it('is unavailable without a key and throws a clear error if used anyway', async () => {
    const saved = { a: process.env.ANTHROPIC_API_KEY, g: process.env.GOOGLE_GENERATIVE_AI_API_KEY, p: process.env.STORA_LLM_PROVIDER };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    delete process.env.STORA_LLM_PROVIDER;
    try {
      const llm = createLLM();
      expect(llm.available).toBe(false);
      await expect(llm.json({ system: '', prompt: '', schema })).rejects.toThrow(/No LLM configured/);
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'x';
      expect(createLLM().provider).toBe('google');
      process.env.ANTHROPIC_API_KEY = 'y';
      expect(createLLM().provider).toBe('anthropic');
    } finally {
      for (const [k, v] of [['ANTHROPIC_API_KEY', saved.a], ['GOOGLE_GENERATIVE_AI_API_KEY', saved.g], ['STORA_LLM_PROVIDER', saved.p]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
