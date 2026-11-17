// Тембровые пары суждения (этап 4, D-132): одна партия — два инструмента.
//
// Проверяется:
//   • детерминизм очереди и инвариант «коды отличаются только alias»;
//   • инвариант музыкальных событий по queryArc настоящего Strudel (D-001);
//   • повторы каждой десятой пары с переставленными сторонами;
//   • разделение счётчиков: тембровые метки НЕ двигают человеческий гейт
//     композиции (≥50 промтов / ≥60 пар) и не попадают в DPO-экспорт;
//   • контракт записи метки (source/channel/session/audio) не ослаблен.
//
// Данные — во временном каталоге (STRUDEL_DATA_DIR), настоящие метки
// владельца не трогаются.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'strudel-timbre-pairs-'));
process.env.STRUDEL_DATA_DIR = dataDir;

import router from '../../server/routes/preference.js';
import {
  appendLabel,
  labelCoverage,
  nextQueueOffset,
  pairTypeOf,
  readPairs,
  upsertPair,
} from '../../server/preference/ledger.js';
import { buildTimbreQueue, timbreCombos } from '../../server/preference/timbre-pairs.js';
import { loadTimbreCatalog } from '../../server/samples/timbre.js';
import { runStrudel } from '../../server/music/strudel-runtime.mjs';
import { buildRows } from '../../server/taste/dataset.js';

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/preference', router);
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(() => {
  rmSync(join(dataDir, 'preferences.jsonl'), { force: true });
  rmSync(join(dataDir, 'pairs.jsonl'), { force: true });
});

afterAll(async () => {
  if (server) {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
  rmSync(dataDir, { recursive: true, force: true });
});

const get = (path) => fetch(`${base}/api/preference${path}`);
const post = (path, body) => fetch(`${base}/api/preference${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/** События без источника звука и без позиций символов (длина alias другая). */
function eventsWithoutSound(events) {
  return events.map((hap) => {
    const value = { ...hap.value };
    delete value.s;
    delete value.sound;
    const { locations, ...context } = hap.context ?? {};
    return { ...hap, value, context };
  });
}

describe('комбинации пресетов', () => {
  it('только approved-пресеты одного семейства с общей ролью, порядок детерминирован', () => {
    const catalog = loadTimbreCatalog();
    const combos = timbreCombos(catalog);
    expect(combos.length).toBeGreaterThan(0);
    for (const combo of combos) {
      const a = catalog.presets[combo.a];
      const b = catalog.presets[combo.b];
      expect(a.family).toBe(b.family);
      expect(a.roles).toContain(combo.role);
      expect(b.roles).toContain(combo.role);
    }
    expect(timbreCombos(catalog)).toEqual(combos);
    // Все три семейства приёмки представлены.
    const families = new Set(combos.map((combo) => combo.family));
    for (const family of ['keys', 'strings', 'bass']) expect(families.has(family)).toBe(true);
  });

  it('неapproved пресет в пару не попадает', () => {
    const catalog = loadTimbreCatalog();
    const broken = structuredClone(catalog);
    const firstAsset = Object.keys(broken.assets)[0];
    broken.assets[firstAsset].rights_status = 'pending';
    const combos = timbreCombos(broken);
    const affected = Object.values(broken.zones)
      .filter((zone) => zone.asset_id === firstAsset)
      .map((zone) => zone.instrument_id);
    for (const combo of combos) {
      expect(affected).not.toContain(combo.a);
      expect(affected).not.toContain(combo.b);
    }
  });

  it('пустой каталог — честно пустая очередь', () => {
    expect(buildTimbreQueue({ catalog: { sources: {}, assets: {}, presets: {}, zones: [] } })).toEqual([]);
  });
});

describe('очередь тембровых пар', () => {
  it('детерминирована: тот же offset → те же коды и хэши', () => {
    const a = buildTimbreQueue({ limit: 4, offset: 2 });
    const b = buildTimbreQueue({ limit: 4, offset: 2 });
    expect(a.map((pair) => [pair.a.hash, pair.b.hash])).toEqual(b.map((pair) => [pair.a.hash, pair.b.hash]));
    expect(a.map((pair) => pair.a.code)).toEqual(b.map((pair) => pair.a.code));
  });

  it('стороны отличаются ТОЛЬКО alias пресета; оба пресета из каталога', () => {
    const catalog = loadTimbreCatalog();
    const pairs = buildTimbreQueue({ limit: 6 });
    for (const pair of pairs) {
      expect(pair.type).toBe('timbre');
      const presetA = catalog.presets[pair.a.instrumentId];
      const presetB = catalog.presets[pair.b.instrumentId];
      expect(presetA).toBeTruthy();
      expect(presetB).toBeTruthy();
      expect(pair.a.instrumentId).not.toBe(pair.b.instrumentId);
      expect(pair.a.code.split(presetA.strudelAlias).join(presetB.strudelAlias)).toBe(pair.b.code);
      expect(pair.a.code).toContain(presetA.strudelAlias);
      // Промт нейтральный: имена пресетов не выдают стороны.
      expect(pair.prompt).not.toContain(presetA.name);
      expect(pair.prompt).not.toContain(presetB.name);
    }
  });

  it('каждая десятая пара — повтор с переставленными сторонами', () => {
    const pairs = buildTimbreQueue({ limit: 12 });
    const first = pairs[0];
    const repeat = pairs[9];
    expect(repeat.repeat).toBe(true);
    expect(repeat.a.hash).toBe(first.b.hash);
    expect(repeat.b.hash).toBe(first.a.hash);
    expect(repeat.swapped).toBe(!first.swapped);
    expect(pairs[1].repeat).toBe(false);
  });

  it('пара кладётся в реестр с типом timbre, спекой и без IR', () => {
    buildTimbreQueue({ limit: 2 });
    const records = readPairs();
    expect(records.length).toBe(2);
    for (const record of records) {
      expect(record.type).toBe('timbre');
      expect(record.pairId.startsWith('timbre-')).toBe(true);
      expect(record.spec.parts.roles.TIMBRE_1).toBeTruthy();
      expect(record.a.ir).toBeUndefined();
      expect(record.b.ir).toBeUndefined();
      expect(record.a.instrumentId).toBeTruthy();
    }
  });

  it('инвариант событий queryArc: музыка одна и та же, источник звука разный', async () => {
    const [pair] = buildTimbreQueue({ limit: 1 });
    const a = await runStrudel(pair.a.code, { cycles: 6 });
    const b = await runStrudel(pair.b.code, { cycles: 6 });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(b.order).toEqual(a.order);
    for (const name of a.order) {
      const left = eventsWithoutSound(a.parts[name]);
      const right = eventsWithoutSound(b.parts[name]);
      expect(left.length).toBeGreaterThan(0);
      expect(right, `партия ${name}: события изменились`).toEqual(left);
    }
    const catalog = loadTimbreCatalog();
    expect(a.parts.TIMBRE_1[0].value.s).toBe(catalog.presets[pair.a.instrumentId].strudelAlias);
    expect(b.parts.TIMBRE_1[0].value.s).toBe(catalog.presets[pair.b.instrumentId].strudelAlias);
  }, 60_000);
});

describe('разделение счётчиков: тембр ≠ композиция', () => {
  it('тембровая метка не двигает покрытие промтов и смещение трековой очереди', async () => {
    const queueRes = await get('/queue?type=timbre&limit=2');
    const queue = await queueRes.json();
    expect(queue.ok).toBe(true);
    expect(queue.pairs[0].type).toBe('timbre');

    const pair = queue.pairs[0];
    const res = await post('/', {
      pairId: pair.id,
      winner: 'A',
      source: 'explicit',
      channel: 'tinder',
      sessionId: queue.sessionId,
      pairType: 'timbre',
      hashA: pair.a.hash,
      hashB: pair.b.hash,
      prompt: pair.prompt,
      audio: { a: { lufsI: -20 }, b: { lufsI: -21 } },
    });
    expect(res.status).toBe(200);

    const coverage = labelCoverage();
    expect(coverage.uniquePrompts).toBe(0);
    expect(coverage.judgedPairs).toBe(0);
    expect(coverage.timbreJudged).toBe(1);
    expect(nextQueueOffset('track')).toBe(0);
    expect(nextQueueOffset('timbre')).toBe(1);
  });

  it('трековая метка не двигает смещение тембровой очереди', async () => {
    const queueRes = await get('/queue?limit=1');
    const queue = await queueRes.json();
    const pair = queue.pairs[0];
    const res = await post('/', {
      pairId: pair.id,
      winner: 'B',
      source: 'explicit',
      channel: 'tinder',
      sessionId: queue.sessionId,
      hashA: pair.a.hash,
      hashB: pair.b.hash,
      prompt: pair.prompt,
      audio: { a: { lufsI: -20 }, b: { lufsI: -21 } },
    });
    expect(res.status).toBe(200);
    expect(nextQueueOffset('track')).toBe(1);
    expect(nextQueueOffset('timbre')).toBe(0);
    expect(labelCoverage().uniquePrompts).toBe(1);
    expect(labelCoverage().timbreJudged).toBe(0);
  });

  it('DPO-экспорт композиции не содержит тембровых меток', async () => {
    const timbreQueue = await (await get('/queue?type=timbre&limit=1')).json();
    const trackQueue = await (await get('/queue?limit=1')).json();
    for (const [queue, type] of [[timbreQueue, 'timbre'], [trackQueue, undefined]]) {
      const pair = queue.pairs[0];
      const res = await post('/', {
        pairId: pair.id,
        winner: 'A',
        source: 'explicit',
        channel: 'tinder',
        sessionId: queue.sessionId,
        ...(type ? { pairType: type } : {}),
        hashA: pair.a.hash,
        hashB: pair.b.hash,
        prompt: pair.prompt,
        audio: { a: { lufsI: -20 }, b: { lufsI: -21 } },
      });
      expect(res.status).toBe(200);
    }
    const exportRes = await get('/export');
    const lines = (await exportRes.text()).trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]).pairId).toBe(trackQueue.pairs[0].id);
  });

  it('обучение композиции пропускает тембровые пары (нет IR — нет признаков)', () => {
    const [pair] = buildTimbreQueue({ limit: 1 });
    const record = readPairs().find((entry) => entry.pairId === pair.id);
    const label = {
      pairId: pair.id,
      winner: 'A',
      source: 'explicit',
      pairType: 'timbre',
      hashA: pair.a.hash,
      hashB: pair.b.hash,
      audio: { a: { lufsI: -20 }, b: { lufsI: -21 } },
    };
    const { rows, stats } = buildRows({ pairs: [record], labels: [label] });
    expect(rows.length).toBe(0);
    expect(stats.skipped.noIr).toBe(1);
  });

  it('старые метки без типа остаются трековыми (обратная совместимость)', () => {
    upsertPair({ pairId: 'pair-900', prompt: 'старый промт', index: 900, a: { hash: 'x' }, b: { hash: 'y' } });
    appendLabel({ pairId: 'pair-900', winner: 'A', source: 'explicit' });
    expect(pairTypeOf({ pairId: 'pair-900' })).toBe('track');
    expect(labelCoverage().uniquePrompts).toBe(1);
    expect(nextQueueOffset('track')).toBe(901);
  });
});

describe('маршрут очереди', () => {
  it('неизвестный тип очереди — 400, а не молчаливый фолбэк', async () => {
    const res = await get('/queue?type=unknown');
    expect(res.status).toBe(400);
  });

  it('тип по умолчанию — трековая очередь (поведение не изменилось)', async () => {
    const res = await get('/queue?limit=1');
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.pairs[0].id.startsWith('pair-')).toBe(true);
    expect(body.pairs[0].type).toBeUndefined();
  });

  it('тембровая метка без сессии/канала отвергается — контракт не ослаблен', async () => {
    const queue = await (await get('/queue?type=timbre&limit=1')).json();
    const pair = queue.pairs[0];
    const res = await post('/', {
      pairId: pair.id,
      winner: 'A',
      source: 'explicit',
      pairType: 'timbre',
      audio: { a: { lufsI: -20 }, b: { lufsI: -21 } },
    });
    expect(res.status).toBe(400);
  });
});