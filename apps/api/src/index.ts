import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { PrismaClient, Prisma } from '@prisma/client';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const app = express();
const db = new PrismaClient();
const port = Number(process.env.PORT ?? 4000);
const hashKey = (raw: string) => createHash('sha256').update(raw).digest('hex');
app.use(helmet());
app.use(cors({ origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173' }));
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'rentok-gateway' }));

const requireAdmin: express.RequestHandler = (req, res, next) => {
  const configured = process.env.ADMIN_API_KEY;
  const supplied = req.header('authorization')?.replace(/^Bearer\s+/i, '');
  if (!configured) return res.status(503).json({ error: { message: 'Admin API is not configured.' } });
  if (!supplied || !timingSafeEqual(Buffer.from(hashKey(supplied)), Buffer.from(hashKey(configured)))) {
    return res.status(401).json({ error: { message: 'A valid admin bearer token is required.', type: 'authentication_error' } });
  }
  next();
};
app.use(['/v1/keys', '/v1/usage'], requireAdmin);

app.post('/v1/keys', async (req, res, next) => {
  try {
    const body = z.object({ name: z.string().min(1).max(60), budget: z.number().int().min(1).max(100000) }).parse(req.body);
    const raw = `rk_live_${randomBytes(20).toString('hex')}`;
    const key = await db.apiKey.create({ data: { name: body.name, budget: body.budget, prefix: raw.slice(0, 15), hash: hashKey(raw) } });
    res.status(201).json({ id: key.id, name: key.name, prefix: key.prefix, budget: key.budget, secret: raw, warning: 'Copy this key now. It cannot be retrieved again.' });
  } catch (e) { next(e); }
});

app.get('/v1/keys', async (_req, res, next) => {
  try { res.json(await db.apiKey.findMany({ select: { id: true, name: true, prefix: true, budget: true, used: true, active: true, createdAt: true }, orderBy: { createdAt: 'desc' } })); }
  catch (e) { next(e); }
});

app.patch('/v1/keys/:id', async (req, res, next) => {
  try {
    const body = z.object({ active: z.boolean().optional(), budget: z.number().int().min(1).max(100000).optional() }).refine(v => Object.keys(v).length > 0).parse(req.body);
    const result = await db.apiKey.updateMany({ where: { id: req.params.id }, data: body });
    if (!result.count) return res.status(404).json({ error: { message: 'API key not found.' } });
    const key = await db.apiKey.findUniqueOrThrow({ where: { id: req.params.id }, select: { id: true, name: true, prefix: true, budget: true, used: true, active: true, createdAt: true } });
    res.json(key);
  } catch (e) { next(e); }
});

app.get('/v1/usage', async (req, res, next) => {
  try {
    const keyId = typeof req.query.keyId === 'string' ? req.query.keyId : undefined;
    const rows = await db.usage.findMany({ where: keyId ? { keyId } : {}, include: { key: { select: { name: true, prefix: true } } }, orderBy: { createdAt: 'desc' }, take: 100 });
    const totals = await db.usage.aggregate({ where: keyId ? { keyId } : {}, _sum: { costUsd: true, inputTokens: true, outputTokens: true }, _count: true });
    res.json({ rows, totals: { costUsd: totals._sum.costUsd ?? 0, inputTokens: totals._sum.inputTokens ?? 0, outputTokens: totals._sum.outputTokens ?? 0, requests: totals._count } });
  } catch (e) { next(e); }
});

const requestSchema = z.object({ model: z.string().default('gpt-4o-mini'), messages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() })).min(1), temperature: z.number().min(0).max(2).optional() });
app.post('/v1/chat/completions', async (req, res, next) => {
  const started = Date.now();
  try {
    const auth = req.header('authorization')?.replace(/^Bearer\s+/i, '');
    if (!auth) return res.status(401).json({ error: { message: 'A gateway key is required.', type: 'authentication_error' } });
    const key = await db.apiKey.findUnique({ where: { hash: hashKey(auth) } });
    if (!key || !key.active) return res.status(401).json({ error: { message: 'Invalid or inactive gateway key.', type: 'authentication_error' } });
    const input = requestSchema.parse(req.body);
    // Atomically reserve one request before contacting the provider. Concurrent calls cannot overspend.
    const reserve = await db.apiKey.updateMany({ where: { id: key.id, active: true, used: { lt: key.budget } }, data: { used: { increment: 1 } } });
    if (reserve.count !== 1) return res.status(429).json({ error: { message: 'Request budget reached. Increase the key cap to continue.', type: 'budget_exceeded' } });

    let provider = 'openai';
    let status = 'success';
    let answer: string;
    let inputTokens: number;
    let outputTokens: number;
    if (process.env.OPENAI_API_KEY) {
      try {
        const upstream = await fetch(`${process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'}/chat/completions`, {
          method: 'POST', headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
          body: JSON.stringify(input), signal: AbortSignal.timeout(20000)
        });
        if (!upstream.ok) throw new Error(`Provider returned ${upstream.status}`);
        const result = await upstream.json() as any;
        answer = result.choices?.[0]?.message?.content ?? '';
        inputTokens = result.usage?.prompt_tokens ?? 0;
        outputTokens = result.usage?.completion_tokens ?? 0;
      } catch {
        provider = 'mock'; status = 'fallback';
        answer = 'The primary model is temporarily unavailable. RentOk has safely routed this request to its local fallback. Your gateway is ready for the next request.';
        inputTokens = Math.ceil(JSON.stringify(input.messages).length / 4); outputTokens = Math.ceil(answer.length / 4);
      }
    } else {
      provider = 'mock'; status = 'fallback';
      const last = input.messages.at(-1)?.content ?? '';
      answer = `I received your message: “${last.slice(0, 140)}”. This response came from the local fallback because no provider credential is configured.`;
      inputTokens = Math.ceil(JSON.stringify(input.messages).length / 4); outputTokens = Math.ceil(answer.length / 4);
    }
    const rates: Record<string, [number, number]> = { 'gpt-4o-mini': [0.15, 0.6], 'gpt-4o': [2.5, 10] };
    const [inRate, outRate] = rates[input.model] ?? rates['gpt-4o-mini'];
    const costUsd = (inputTokens * inRate + outputTokens * outRate) / 1_000_000;
    await db.usage.create({ data: { keyId: key.id, model: input.model, inputTokens, outputTokens, costUsd, status, provider, latencyMs: Date.now() - started } });
    res.json({ id: `chatcmpl_${randomBytes(8).toString('hex')}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: input.model, choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }], usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens }, gateway: { provider, status } });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: { message: 'Invalid request body.', details: e.flatten() } });
    next(e);
  }
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err instanceof Error ? err.message : 'Unknown error');
  if (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === 'P2021'
  ) return res.status(503).json({ error: { message: 'Database is not initialized. Run the Prisma migration first.' } });
  res.status(500).json({ error: { message: 'Gateway could not complete the request.' } });
});

export { app, db };
if (process.env.NODE_ENV !== 'test') app.listen(port, () => console.log(`RentOk gateway listening on :${port}`));
