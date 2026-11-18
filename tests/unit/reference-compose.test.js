import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveTimbre } from '../../server/samples/timbre-resolver.js';
import { loadTimbreCatalog } from '../../server/samples/timbre.js';
import { referenceDigest, referenceTimbres } from '../../server/music/compose/reference-plan.js';
import { buildTrack, fallbackSpec } from '../../server/music/compose/pipeline.js';
import { runTool, toolApiSchemas } from '../../server/agent/tools.js';
import { heuristicPlan } from '../../server/agent/navigator.js';

const { health, status, submit, wait } = vi.hoisted(() => ({ health: vi.fn(), status: vi.fn(), submit: vi.fn(), wait: vi.fn() }));
vi.mock('../../local/client.mjs', () => ({ createDaemonClient: () => ({ health, status, submit, wait }) }));

const taskId = '12345678-1234-4234-8234-123456789abc';
const descriptor = { spectral: { centroidHz: 800 }, transients: { densityPerSec: 2 } };
const passport = {
  durationS: 8,
  measurements: { tempo: { bpm: 120 }, key: { tonic: 'C', mode: 'minor' }, loudness: { lufs_integrated: -18 } },
  structure: [{ index: 0, start_s: 0, end_s: 8, energy: 0.4 }],
  stems: { bass: { available: true, descriptor }, other: { available: true, descriptor }, vocals: { available: false, descriptor: null } },
  caveats: ['Ориентир, не клон.'],
};
const env = { LOCAL_DAEMON_URL: 'http://127.0.0.1:3213', LOCAL_DAEMON_TOKEN: 'test-only' };

beforeEach(() => {
  vi.clearAllMocks();
  health.mockResolvedValue({ analysis: { available: true, demucs_available: true } });
  status.mockResolvedValue({ state: 'done', type: 'analyze' });
  submit.mockResolvedValue({ id: taskId });
  wait.mockResolvedValue({ state: 'done', result: { passport } });
});

describe('P5: реальный инструмент и границы', () => {
  it('схема требует только ID зарегистрированной задачи, не URL или путь', () => {
    const schema = toolApiSchemas(['analyze_reference'])[0].function.parameters;
    expect(Object.keys(schema.properties)).toEqual(['taskId']);
    expect(schema.required).toContain('taskId');
  });

  it.each([{ taskId: 'bad' }, { taskId, path: '/private/file.wav' }, { taskId, url: 'http://example.com' }])('отклоняет неверный вход %j до клиента', async args => {
    expect((await runTool('analyze_reference', args, { env })).ok).toBe(false);
    expect(health).not.toHaveBeenCalled();
  });

  it('без настройки не вызывает демон', async () => {
    const result = await runTool('analyze_reference', { taskId }, { env: {} });
    expect(result).toMatchObject({ ok: false, degraded: true });
    expect(health).not.toHaveBeenCalled();
  });

  it('обрыв связи не изображает замер', async () => {
    health.mockRejectedValue(new Error('offline'));
    expect(await runTool('analyze_reference', { taskId }, { env })).toMatchObject({ ok: false, degraded: true });
    expect(submit).not.toHaveBeenCalled();
  });

  it.each([
    { available: false },
    { available: true, demucs_available: false },
  ])('без Python/Demucs пропускает P5 до постановки задачи %j', async analysis => {
    health.mockResolvedValue({ analysis });
    const result = await runTool('analyze_reference', { taskId }, { env });
    expect(result).toMatchObject({ ok: false, degraded: true });
    expect(status).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it.each([
    { state: 'running', type: 'analyze' },
    { state: 'error', type: 'passport' },
    { state: 'done', type: 'separate' },
  ])('не анализирует негодный источник %j', async source => {
    status.mockResolvedValue(source);
    expect((await runTool('analyze_reference', { taskId }, { env })).ok).toBe(false);
    expect(submit).not.toHaveBeenCalled();
  });

  it('ожидает реальную задачу и сохраняет только измеренный паспорт в контексте', async () => {
    const ctx = { env, signal: new AbortController().signal };
    const result = await runTool('analyze_reference', { taskId }, ctx);
    expect(submit).toHaveBeenCalledWith('analyze_reference', { sourceTaskId: taskId });
    expect(wait).toHaveBeenCalledWith(taskId, { signal: ctx.signal });
    expect(result.ok).toBe(true);
    expect(result.reference.passport).toEqual(passport);
    expect(ctx.reference).toEqual(result.reference);
    expect(result.reference.candidates.bass.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain(env.LOCAL_DAEMON_TOKEN);
  });

  it('ошибка задачи не выдаётся за паспорт', async () => {
    wait.mockRejectedValue(new Error('separation failed'));
    const ctx = { env };
    expect((await runTool('analyze_reference', { taskId }, ctx)).ok).toBe(false);
    expect(ctx.reference).toBeUndefined();
  });

  it('завершение без измерений не принимается', async () => {
    wait.mockResolvedValue({ result: {} });
    expect((await runTool('analyze_reference', { taskId }, { env })).ok).toBe(false);
  });
});

describe('P5: паспорт направляет compose', () => {
  it('паспорт попадает в настоящий prompt buildTrack, но не заменяет genre-гейт', async () => {
    const reference = { passport, candidates: referenceTimbres(passport) };
    const completeChat = vi.fn(async () => JSON.stringify(fallbackSpec('techno', 1)));
    const onEvent = vi.fn();
    const result = await buildTrack({ prompt: 'techno', completeChat, reference, onEvent });
    const system = completeChat.mock.calls[0][0].messages[0].content;
    expect(system).toContain('Измеренный локальный аудиореференс');
    expect(system).toContain('"lufs_integrated":-18');
    expect(system).toContain('edu-guide-techno');
    expect(system).toContain(reference.candidates.bass[0].id);
    expect(result.spec.meta.bpm).toBe(132);
    expect(onEvent).toHaveBeenCalledWith('reference', reference);
  });

  it('compose_spec берёт референс из контекста, не из выдумки аргументов', async () => {
    const reference = { passport, candidates: referenceTimbres(passport) };
    const completeChat = vi.fn(async () => JSON.stringify(fallbackSpec('techno', 1)));
    const result = await runTool('compose_spec', { prompt: 'techno', reference: { invented: true } }, { completeChat, reference });
    expect(result.ok).toBe(true);
    expect(completeChat.mock.calls[0][0].messages[0].content).toContain(JSON.stringify(passport));
  });

  it('без паспорта прежний prompt не содержит референса', () => {
    expect(referenceDigest(null)).toBe('');
    expect(referenceTimbres(null)).toEqual({});
  });

  it('неизмеренные дескрипторы не выдают кандидатов за совпадение', () => {
    expect(referenceTimbres({ stems: { other: { available: true, descriptor: { spectral: { centroidHz: null } } } } })).toEqual({});
  });

  it('эвристика использует явно заданный UUID до compose', () => {
    const plan = heuristicPlan(`Сделай techno бит, референс: ${taskId}`);
    const index = plan.steps.findIndex(s => s.tool === 'analyze_reference');
    expect(plan.steps[index].args).toEqual({ taskId });
    expect(index).toBeLessThan(plan.steps.findIndex(s => s.tool === 'compose_spec'));
  });

  it('без ID эвристика не придумывает источник', () => {
    expect(heuristicPlan('Сделай бит как референс').steps.some(s => s.tool === 'analyze_reference')).toBe(false);
  });
});

describe('P5: измеренные признаки и права тембров', () => {
  it('совпадающий измеренный центроид повышает скор кандидата', () => {
    const catalog = loadTimbreCatalog();
    const target = catalog.presets['tp-upright-soft-v1'].descriptor;
    const baseline = resolveTimbre({ role: 'chords' }, catalog).find(c => c.id === 'tp-upright-soft-v1');
    const matched = resolveTimbre({ role: 'chords', descriptor: target }, catalog).find(c => c.id === baseline.id);
    expect(matched.score).toBeGreaterThan(baseline.score);
    expect(matched.reasons.join(' ')).toContain('измеренного референса');
  });

  it('DSP-совпадение не обходит rights_status', () => {
    const catalog = loadTimbreCatalog();
    const zone = catalog.zones.find(z => z.instrument_id === 'tp-upright-soft-v1');
    catalog.assets[zone.asset_id].rights_status = 'pending';
    expect(resolveTimbre({ role: 'chords', descriptor: catalog.presets['tp-upright-soft-v1'].descriptor }, catalog).map(c => c.id)).not.toContain('tp-upright-soft-v1');
  });
});
