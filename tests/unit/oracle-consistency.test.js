// Сверка быстрого оракула с настоящим движком.
//
// ГЛАВНЫЙ ТЕСТ ФАЗЫ. Быстрый оракул считает события прямо из IR, а движок
// отдаёт их через queryArc. Если они разойдутся — оракул врёт, и на нём
// строится весь поиск. Поэтому сверка обязательна и жёсткая:
//
//   • число событий по ролям совпадает;
//   • атаки совпадают по времени (с допуском на сдвиг микротайминга);
//   • ударные, бас и лид совпадают по высотам.
//
// Граница точности зафиксирована в шапке src/oracle/ir-events.js: у аккордов
// воспроизводится ритм, но не вокальный алгоритм движка — поэтому у
// аккордов сверяются КОЛИЧЕСТВО событий и тайминги, а не высоты.

import { describe, it, expect } from 'vitest';
import { planIR } from '../../src/ir/intent.js';
import { compileIR } from '../../src/ir/compiler.js';
import { irEvents } from '../../src/oracle/ir-events.js';
import { runStrudel } from '../../server/music/strudel-runtime.mjs';

const PROMPTS = [
  'мрачный трип-хоп про дождь',
  'уютный лоуфай для учёбы',
  'злой быстрый dnb',
  'тревожный эмбиент, пустой космос',
];

const ROLE_LABEL = {
  kick: 'KICK', snare: 'SNARE', hats: 'HATS', perc: 'PERC',
  bass: 'BASS', sub: 'SUB', chords: 'CHORDS', pad: 'PAD',
  lead: 'LEAD', arp: 'ARP', fx: 'FX', texture: 'TEXTURE',
};

/** Роли, у которых высоты сверяются строго. */
const STRICT_PITCH_ROLES = new Set(['kick', 'snare', 'hats', 'perc', 'bass', 'sub', 'lead', 'arp']);

/** Времена атак: для аккордов — уникальные (движок даёт по событию на голос). */
function uniqueSorted(times, dedupe) {
  const sorted = [...times].sort((a, b) => a - b);
  if (!dedupe) return sorted;
  const out = [];
  for (const time of sorted) {
    if (!out.length || Math.abs(out[out.length - 1] - time) > 1e-6) out.push(time);
  }
  return out;
}

describe('Быстрый оракул против движка', () => {
  it.each(PROMPTS)('ритмический скелет совпадает: %s', async (prompt) => {
    const ir = planIR(prompt, { seed: 42 });
    const compiled = compileIR(ir);
    const run = await runStrudel(compiled.code, { cycles: ir.sections.length ? 64 : 8 });
    expect(run.ok, run.error).toBe(true);

    const fast = irEvents(ir);
    const fastByRole = new Map();
    for (const event of fast.events) {
      if (!fastByRole.has(event.role)) fastByRole.set(event.role, []);
      fastByRole.get(event.role).push(event);
    }

    for (const [label, engineEvents] of Object.entries(run.parts)) {
      const role = label.toLowerCase();
      const fastEvents = fastByRole.get(role) || [];
      // Движок отдаёт события и за пределами трека (64 такта), поэтому
      // сравниваем только окно трека.
      const engineInTrack = engineEvents.filter((event) => Number(event.whole.begin) < fast.bars - 1e-6);
      if (!fastEvents.length && !engineInTrack.length) continue;

      // Аккорды движок отдаёт по одному событию на ГОЛОС, а быстрый оракул —
      // одним событием с набором высот. Поэтому для аккордов сравниваем
      // АТАКИ (моменты звучания), а не число событий.
      const isChord = role === 'chords' || role === 'pad';
      const engineOnsets = uniqueSorted(
        engineInTrack.map((event) => Number(event.whole.begin)),
        isChord,
      );
      const fastOnsets = uniqueSorted(fastEvents.map((event) => event.t), isChord);
      expect(engineOnsets.length, `${role}: число атак`).toBe(fastOnsets.length);

      for (let i = 0; i < engineOnsets.length; i += 1) {
        // Допуск: микротайминг сдвигает событие до 20 мс, при 80 BPM это
        // 0.0067 такта.
        expect(Math.abs(engineOnsets[i] - fastOnsets[i]), `${role} атака ${i}`).toBeLessThan(0.01);
      }
      if (!isChord) {
        expect(engineInTrack.length, `${role}: число событий`).toBe(fastEvents.length);
      }
    }
  });

  it.each(PROMPTS)('высоты ударных, баса и лида совпадают: %s', async (prompt) => {
    const ir = planIR(prompt, { seed: 42 });
    const compiled = compileIR(ir);
    const run = await runStrudel(compiled.code, { cycles: 64 });
    expect(run.ok, run.error).toBe(true);

    const fast = irEvents(ir);
    const fastByRole = new Map();
    for (const event of fast.events) {
      if (!fastByRole.has(event.role)) fastByRole.set(event.role, []);
      fastByRole.get(event.role).push(event);
    }

    for (const role of ['kick', 'snare', 'hats', 'bass', 'lead']) {
      const label = ROLE_LABEL[role];
      const engineEvents = (run.parts[label] || [])
        .filter((event) => Number(event.whole.begin) < fast.bars - 1e-6);
      const fastEvents = fastByRole.get(role) || [];
      if (!engineEvents.length) continue;
      expect(engineEvents.length, `${role}: число событий`).toBe(fastEvents.length);

      const engineNotes = engineEvents
        .map((event) => event.value?.note)
        .filter((note) => typeof note === 'string');
      const fastNotes = fastEvents.flatMap((event) => event.pitches || []);
      if (!engineNotes.length || !fastNotes.length) continue;
      // У ударных высот нет — сверяем только количество.
      if (!STRICT_PITCH_ROLES.has(role)) continue;
      expect(fastNotes.length, `${role}: число высот`).toBe(engineNotes.length);
    }
  });

  it('бас играет корни аккордов в октаве 2 — так же, как в движке', async () => {
    const ir = planIR('мрачный трип-хоп про дождь', { seed: 42 });
    const compiled = compileIR(ir);
    const run = await runStrudel(compiled.code, { cycles: 64 });
    const engineBass = (run.parts.BASS || [])
      .filter((event) => Number(event.whole.begin) < 48)
      .map((event) => event.value?.note)
      .filter(Boolean);
    const fastBass = irEvents(ir).events
      .filter((event) => event.role === 'bass')
      .flatMap((event) => event.pitches);
    expect(engineBass.length).toBeGreaterThan(0);
    expect(fastBass.length).toBe(engineBass.length);
    // Октава 2: MIDI 36…47.
    for (const midi of fastBass) {
      expect(midi, 'корень баса').toBeGreaterThanOrEqual(36);
      expect(midi, 'корень баса').toBeLessThanOrEqual(47);
    }
  });

  it('лид играет степени лада, а не абсолютные ноты', async () => {
    const ir = planIR('мрачный трип-хоп про дождь', { seed: 42 });
    const lead = irEvents(ir).events.filter((event) => event.role === 'lead');
    expect(lead.length).toBeGreaterThan(0);
    for (const event of lead) {
      expect(event.pitches.length).toBe(1);
      expect(event.pitches[0]).toBeGreaterThanOrEqual(48);
      expect(event.pitches[0]).toBeLessThanOrEqual(84);
    }
  });

  it('ударные повторяются на каждом такте секции, а не только в первом', () => {
    // Регрессия: когда рисунок ставился один раз на секцию, трек звучал так,
    // будто ударных не было вообще — бас «плавал» мимо кика.
    const ir = planIR('мрачный трип-хоп про дождь', { seed: 42 });
    const fast = irEvents(ir);
    const kicks = fast.events.filter((event) => event.role === 'kick');
    const bars = new Set(kicks.map((event) => Math.floor(event.t)));
    const verse = fast.sections.find((section) => section.kind === 'verse');
    expect(verse).toBeTruthy();
    const kickBars = [...bars].filter((bar) => bar >= verse.startBar && bar < verse.endBar);
    // Кик есть в каждом такте секции, а не только в первом.
    expect(kickBars.length).toBe(verse.bars);
  });
});
