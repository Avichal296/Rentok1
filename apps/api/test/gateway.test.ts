import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { app, db } from '../src/index';

const adminKey = process.env.ADMIN_API_KEY ?? 'local-test-admin-token';
let appServer: Server | undefined;
let baseUrl: string;

before(async () => {
  const configuredUrl = process.env.DATABASE_URL;
  if (!configuredUrl || !new URL(configuredUrl).pathname.endsWith('_test')) {
    throw new Error('Integration tests require a dedicated database whose name ends with _test; refusing to clean any other database.');
  }
  await db.usage.deleteMany();
  await db.apiKey.deleteMany();
  appServer = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => appServer.once('listening', resolve));
  const address = appServer.address();
  if (!address || typeof address === 'string') throw new Error('Unable to start test server');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (appServer) await new Promise<void>(resolve => appServer!.close(() => resolve()));
  await db.$disconnect();
});

async function createKey(name: string, budget: number) {
  const response = await fetch(`${baseUrl}/v1/keys`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name, budget })
  });
  assert.equal(response.status, 201);
  return response.json() as Promise<{ id: string; secret: string; prefix: string; budget: number }>;
}

async function chat(secret: string, messages: unknown[] = [{ role: 'user', content: 'Hello from the gateway' }]) {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini', messages })
  });
}

test('gateway lifecycle, access, fallback, usage, and atomic budget enforcement', async () => {
  const health = await fetch(`${baseUrl}/health`).then(r => r.json()) as { status: string };
  assert.equal(health.status, 'ok');

  assert.equal((await fetch(`${baseUrl}/v1/keys`)).status, 401, 'admin routes reject missing credentials');
  assert.equal((await fetch(`${baseUrl}/v1/keys`, { headers: { authorization: 'Bearer wrong' } })).status, 401);

  const key = await createKey('integration key', 10);
  assert.match(key.secret, /^rk_live_[a-f0-9]{40}$/);
  assert.equal((await chat('rk_live_not-a-real-key')).status, 401);
  assert.equal((await chat(key.secret, [])).status, 400, 'malformed chat is rejected before budget reservation');

  const fallbackResponse = await chat(key.secret);
  assert.equal(fallbackResponse.status, 200);
  const fallback = await fallbackResponse.json() as any;
  assert.equal(fallback.object, 'chat.completion');
  assert.equal(fallback.gateway.provider, 'mock');
  assert.equal(fallback.gateway.status, 'fallback');
  assert.ok(fallback.usage.total_tokens > 0);

  const listed = await fetch(`${baseUrl}/v1/keys`, { headers: { authorization: `Bearer ${adminKey}` } }).then(r => r.json()) as any[];
  assert.equal(listed.length, 1);
  assert.equal(listed[0].hash, undefined, 'key hashes are never returned by the admin API');
  assert.equal(listed[0].secret, undefined, 'key secrets are only returned at creation');

  const usageResponse = await fetch(`${baseUrl}/v1/usage?keyId=${key.id}`, { headers: { authorization: `Bearer ${adminKey}` } });
  assert.equal(usageResponse.status, 200);
  const usage = await usageResponse.json() as any;
  assert.equal(usage.totals.requests, 1);
  assert.ok(usage.rows[0].inputTokens > 0);
  assert.ok(usage.rows[0].costUsd >= 0);
  assert.equal(usage.rows[0].keyId, key.id);
  assert.equal(usage.rows[0].model, 'gpt-4o-mini');
  assert.equal(usage.rows[0].provider, 'mock');
  assert.ok(Number.isFinite(Date.parse(usage.rows[0].createdAt)));

  const capped = await createKey('single request key', 1);
  const concurrent = await Promise.all([chat(capped.secret), chat(capped.secret)]);
  assert.deepEqual(concurrent.map(r => r.status).sort(), [200, 429], 'concurrent requests cannot reserve the final slot twice');

  const disabled = await fetch(`${baseUrl}/v1/keys/${key.id}`, {
    method: 'PATCH', headers: { authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ active: false })
  });
  assert.equal(disabled.status, 200);
  assert.equal((await chat(key.secret)).status, 401, 'revoked key is rejected');

  const providerStub = createServer((_req, res) => { res.writeHead(503); res.end('provider unavailable'); });
  await new Promise<void>(resolve => providerStub.listen(0, '127.0.0.1', resolve));
  const providerAddress = providerStub.address();
  if (!providerAddress || typeof providerAddress === 'string') throw new Error('Unable to start provider stub');
  process.env.OPENAI_API_KEY = 'integration-test-only';
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${providerAddress.port}/v1`;
  try {
    const resilientKey = await createKey('provider fallback key', 2);
    const resilientResponse = await chat(resilientKey.secret);
    const resilient = await resilientResponse.json() as any;
    assert.equal(resilientResponse.status, 200);
    assert.equal(resilient.gateway.status, 'fallback', 'provider 503 falls back instead of leaking provider error');
    assert.equal(resilient.gateway.provider, 'mock');
  } finally {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    await new Promise<void>(resolve => providerStub.close(() => resolve()));
  }
});
