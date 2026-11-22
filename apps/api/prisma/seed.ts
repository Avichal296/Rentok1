import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';

const db = new PrismaClient();
async function main() {
  const raw = 'rk_live_demo_8c1f40a291';
  const hash = createHash('sha256').update(raw).digest('hex');
  await db.apiKey.upsert({ where: { hash }, update: {}, create: { name: 'Product team', prefix: 'rk_live_demo', hash, budget: 1000 } });
  const key = await db.apiKey.findUniqueOrThrow({ where: { hash } });
  if ((await db.usage.count({ where: { keyId: key.id } })) === 0) {
    const now = Date.now();
    await db.usage.createMany({ data: [
      { keyId: key.id, model: 'gpt-4o-mini', inputTokens: 480, outputTokens: 216, costUsd: .00017, status: 'success', provider: 'openai', latencyMs: 842, createdAt: new Date(now - 180000) },
      { keyId: key.id, model: 'gpt-4o-mini', inputTokens: 238, outputTokens: 94, costUsd: .00008, status: 'success', provider: 'openai', latencyMs: 690, createdAt: new Date(now - 420000) },
      { keyId: key.id, model: 'gpt-4o', inputTokens: 940, outputTokens: 386, costUsd: .0077, status: 'fallback', provider: 'mock', latencyMs: 1200, createdAt: new Date(now - 860000) }
    ] });
    await db.apiKey.update({ where: { id: key.id }, data: { used: 3 } });
  }
  console.log(`Demo key (shown once): ${raw}`);
}
main().finally(() => db.$disconnect());
