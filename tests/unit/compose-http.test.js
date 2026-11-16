// Реальные локальные HTTP/SSE запросы. Подменяется только платная модель,
// схема, компилятор, маршруты, метрики и Strudel остаются настоящими.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { once } from 'node:events';
import { fallbackSpec, normalizeSpec, repairSpec } from '../../server/music/compose/pipeline.js';
import { TrackSpecSchema } from '../../src/schemas/track-spec.schema.js';
import { compileTrackSpec } from '../../server/music/compiler/index.js';
import { runStrudel } from '../../server/music/strudel-runtime.mjs';

const { completeChat } = vi.hoisted(() => ({ completeChat: vi.fn() }));
vi.mock('../../server/llm/client.js', () => ({ completeChat }));
import router from '../../server/routes/compose.js';

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(router);
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  if (server) await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
});
beforeEach(() => completeChat.mockReset());

async function post(path, body) {
  return fetch(`${base}/api/music/compose${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}
async function stream(body) {
  const response = await post('', body);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const events = (await response.text()).trim().split('\n\n')
    .map((line) => JSON.parse(line.replace(/^data: /, '')));
  expect(events.some((event) => event.type === 'error')).toBe(false);
  return events;
}

describe('канонический TrackSpec через HTTP и SSE', () => {
  it('POST compose сохраняет события и поля протокола, код исполняется', async () => {
    const spec = fallbackSpec('techno', 1);
    completeChat.mockResolvedValue(JSON.stringify(spec));
    const events = await stream({ prompt: 'техно', seed: 1, refine: false });
    expect(events.map((e) => e.type)).toEqual(['style', 'spec', 'compiled', 'scored', 'done']);
    const planned = events.find((e) => e.type === 'spec');
    expect(planned.usedFallback).toBe(false);
    expect(planned.attempts).toBe(1);
    // Спека в ответе — канонизированная моделью: repairSpec проставляет
    // явное поле role (D-100: роль стала атрибутом партии, а не ключом).
    const canonical = repairSpec(normalizeSpec(spec, 'techno'), 'techno');
    expect(TrackSpecSchema.parse(planned.spec)).toEqual(canonical);
    for (const [id, part] of Object.entries(canonical.parts.roles)) {
      expect(part.role, `роль партии ${id}`).toBe(id);
    }
    const compiled = events.find((e) => e.type === 'compiled');
    for (const field of ['code', 'parts', 'sections', 'warnings', 'trace']) expect(compiled).toHaveProperty(field);
    const done = events.at(-1);
    expect(done).toMatchObject({ mode: 'structured', spec, code: compileTrackSpec(spec) });
    expect(done.sections).toEqual(compiled.sections);
    const run = await runStrudel(done.code, { cycles: 32 });
    expect(run.ok, run.error).toBe(true);
    expect(run.order.length).toBeGreaterThan(2);
  });

  it('refine сохраняет каноническую спеку и финальный код', async () => {
    completeChat.mockResolvedValue(JSON.stringify(fallbackSpec('house', 2)));
    const events = await stream({ prompt: 'house', refine: true, iterations: 1 });
    expect(events.map((e) => e.type)).toContain('refined');
    const done = events.at(-1);
    expect(done.type).toBe('done');
    expect(TrackSpecSchema.safeParse(done.spec).success).toBe(true);
    expect(done.code).toBe(compileTrackSpec(done.spec));
  });

  it('старый ответ модели не преобразуется: две попытки, затем canonical fallback', async () => {
    completeChat.mockResolvedValue(JSON.stringify({ meta: { style: 'techno', bpm: 132, key: 'c:minor' }, form: [], harmony: {} }));
    const events = await stream({ prompt: 'техно', seed: 3, refine: false });
    expect(completeChat).toHaveBeenCalledTimes(2);
    expect(events.map((e) => e.type)).toContain('fallback');
    expect(events.find((e) => e.type === 'spec').usedFallback).toBe(true);
    expect(events.at(-1).spec).toEqual(fallbackSpec('techno', 3));
  });

  it('схемно допустимый, но некомпилируемый ответ заменяется запасным планом', async () => {
    const spec = fallbackSpec('techno', 1);
    spec.parts.roles.kick.effects = [{ name: 'unknown', params: [1] }];
    expect(TrackSpecSchema.safeParse(spec).success).toBe(true);
    completeChat.mockResolvedValue(JSON.stringify(spec));
    const events = await stream({ prompt: 'техно', seed: 4, refine: false });
    expect(completeChat).toHaveBeenCalledTimes(2);
    expect(events.find((e) => e.type === 'spec').usedFallback).toBe(true);
    expect(events.at(-1).code).toBe(compileTrackSpec(fallbackSpec('techno', 4)));
  });

  it('варианты и мутации проходят HTTP и компилируются без обращения к модели', async () => {
    const spec = fallbackSpec('techno', 1);
    const original = structuredClone(spec);
    const variantsResponse = await post('/variants', { spec, count: 4, seed: 11 });
    expect(variantsResponse.status).toBe(200);
    const payload = await variantsResponse.json();
    expect(payload.variants).toHaveLength(4);
    expect(payload.original.spec).toEqual(spec);
    for (const [index, variant] of payload.variants.entries()) {
      expect(variant.rank).toBe(index + 1);
      for (const field of ['angle', 'mutation', 'distance', 'fingerprint', 'code', 'spec', 'sections', 'score']) expect(variant).toHaveProperty(field);
      expect(variant.code).toBe(compileTrackSpec(variant.spec));
    }
    const mutationResponse = await post('/mutate', { spec, mutation: 'fill', seed: 7 });
    expect(mutationResponse.status).toBe(200);
    const mutated = await mutationResponse.json();
    expect(mutated.mutation).toBe('fill');
    expect(mutated.spec.structure.sections.at(-1).name).toBe('fill');
    expect(mutated.code).toBe(compileTrackSpec(mutated.spec));
    expect(spec).toEqual(original);
    expect(completeChat).not.toHaveBeenCalled();
  });

  it('невалидные запросы и старые входы endpoints отклоняются', async () => {
    expect((await post('', { prompt: '' })).status).toBe(400);
    for (const path of ['/variants', '/mutate']) {
      expect((await post(path, { spec: { form: [] } })).status).toBe(400);
    }
    expect(completeChat).not.toHaveBeenCalled();
  });
});
