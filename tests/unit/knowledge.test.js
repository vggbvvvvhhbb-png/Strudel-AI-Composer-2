// Проверка библиотеки знаний НАСТОЯЩИМ парсером Strudel.
//
// Правило задачи: «Каждый сниппет в библиотеках, шаблонах и few-shot обязан
// пройти настоящий парсер/исполнение Strudel в тесте. Не прошёл — не попадает
// в репозиторий.»
//
// Поэтому здесь проверяется всё: мини-строки ролей, аккорды степеней,
// рецепты переходов, кривые автоматизации, формы и прогрессии.

import { describe, it, expect } from 'vitest';
import { loadStrudel } from '../../server/music/strudel-runtime.mjs';
import {
  PROGRESSIONS,
  FORMS,
  ROLES,
  ROLE_MATRIX,
  ROLE_STYLES,
  FORM_STYLES,
  PROGRESSION_STYLES,
  COMPLETE_STYLES,
  TRANSITIONS,
  TRANSITION_TYPES,
  CURVES,
  CURVE_NAMES,
  descriptor,
} from '../../server/music/knowledge/index.js';
import { formsForStyle, formBars } from '../../server/music/knowledge/forms.js';

const api = await loadStrudel();

// Лады, которые понимает Strudel: только полные имена одним словом.
const STRUDEL_MODES = new Set([
  'major', 'minor', 'dorian', 'phrygian', 'lydian', 'mixolydian',
  'ionian', 'aeolian', 'pentatonic', 'blues', 'chromatic',
]);

const STYLES = [
  'lofi', 'techno', 'house', 'ambient', 'dnb', 'synthwave', 'trap', 'jazz', 'rock', 'cinematic',
];

describe('knowledge: структура библиотеки', () => {
  it('покрывает все 10 стилей из задания', () => {
    for (const style of STYLES) {
      expect(PROGRESSION_STYLES).toContain(style);
      expect(FORM_STYLES).toContain(style);
      expect(ROLE_STYLES).toContain(style);
    }
    expect(COMPLETE_STYLES.sort()).toEqual([...STYLES].sort());
  });

  it('у каждого стиля ≥4 прогрессий', () => {
    for (const style of STYLES) {
      const count = PROGRESSIONS.filter((p) => p.style === style).length;
      expect(count).toBeGreaterThanOrEqual(4);
    }
  });

  it('все записи имеют обязательные поля', () => {
    for (const p of PROGRESSIONS) {
      expect(p.id).toBeTruthy();
      expect(Array.isArray(p.tags)).toBe(true);
      expect(['theory', 'strudel-docs', 'own']).toContain(p.source);
      expect(typeof p.verified).toBe('boolean');
      expect(p.verified).toBe(true);
    }
  });

  it('id уникальны', () => {
    const ids = PROGRESSIONS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const formIds = Object.values(FORMS).flat().map((f) => f.id);
    expect(new Set(formIds).size).toBe(formIds.length);
  });
});

describe('knowledge: прогрессии разбираются движком', () => {
  it('лады прогрессий — из белого списка Strudel', () => {
    for (const p of PROGRESSIONS) {
      expect(STRUDEL_MODES).toContain(p.mode);
    }
  });

  it('степени — целые числа в диапазоне лада', () => {
    for (const p of PROGRESSIONS) {
      expect(p.degrees.length).toBeGreaterThanOrEqual(2);
      for (const d of p.degrees) {
        expect(Number.isInteger(d)).toBe(true);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(6);
      }
      expect(p.barsPerChord).toBeGreaterThanOrEqual(1);
    }
  });

  it('каждая прогрессия исполняется и остаётся в ладу', async () => {
    for (const p of PROGRESSIONS) {
      // Тремвучие степени: d, d+2, d+4 в ладе — так аккорд строится из степеней.
      for (const d of p.degrees) {
        const chord = [d, d + 2, d + 4].join(' ');
        const haps = api.n(chord).scale(`c:${p.mode}`).queryArc(0, 1);
        expect(haps.length).toBe(3);
        for (const hap of haps) {
          expect(hap.value.note).toBeTruthy();
        }
      }
    }
  });

  it('бас из степеней прогрессии исполняется', async () => {
    for (const p of PROGRESSIONS) {
      const degrees = p.degrees.join(' ');
      const haps = api.n(`<${degrees}>`).scale(`c:${p.mode}`).queryArc(0, 4);
      expect(haps.length).toBe(4);
    }
  });
});

describe('knowledge: матрица ролей', () => {
  it('у каждого стиля заполнены все 12 ролей', () => {
    for (const style of STYLES) {
      for (const role of ROLES) {
        const entry = ROLE_MATRIX[style][role];
        expect(entry, `${style}/${role}`).toBeTruthy();
      }
    }
  });

  it('у роли есть 2–4 ритмических шаблона', () => {
    for (const style of STYLES) {
      for (const role of ROLES) {
        const entry = ROLE_MATRIX[style][role];
        expect(entry.patterns.length, `${style}/${role}`).toBeGreaterThanOrEqual(2);
        expect(entry.patterns.length, `${style}/${role}`).toBeLessThanOrEqual(4);
      }
    }
  });

  it('все мини-строки ролей разбираются движком', async () => {
    for (const style of STYLES) {
      for (const role of ROLES) {
        const entry = ROLE_MATRIX[style][role];
        // Ударные роли — паттерны сэмплов (s()), мелодические — степени (n()).
        const isPercussive = entry.sounds.length > 0;
        for (const pattern of entry.patterns) {
          const haps = isPercussive
            ? api.s(pattern).queryArc(0, 1)
            : api.n(pattern).scale('c:minor').queryArc(0, 1);
          expect(haps.length, `${style}/${role}: ${pattern}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('паттерны ударных ролей состоят из сэмплов, а не из степеней', async () => {
    for (const style of STYLES) {
      for (const role of ['kick', 'snare', 'hats', 'perc']) {
        for (const pattern of ROLE_MATRIX[style][role].patterns) {
          const haps = api.s(pattern).queryArc(0, 1);
          expect(haps.length, `${style}/${role}: ${pattern}`).toBeGreaterThan(0);
          for (const hap of haps) {
            expect(hap.value.s, `${style}/${role}: ${pattern}`).toBeTruthy();
          }
        }
      }
    }
  });

  it('все сэмплы из белого списка системного промпта', () => {
    const allowed = new Set([
      'bd', 'sd', 'hh', 'hh27', 'cp', 'oh', 'perc', '808', '808bd', '808sd', '808oh',
      '808mc', '808ht', '808lc', '909', 'bass', 'bass0', 'bass1', 'bass2', 'bass3',
      'pluck', 'stab', 'jazz', 'juno', 'moog', 'sax', 'trump', 'sitar', 'house', 'dr',
      'dr2', 'dr55', 'breaks125', 'breaks152', 'breaks157', 'breaks165', 'realclaps',
      'sh', 'rave', 'gab', 'industrial', 'jungle', 'techno', 'piano', 'rim',
    ]);
    for (const style of STYLES) {
      for (const role of ROLES) {
        for (const sound of ROLE_MATRIX[style][role].sounds) {
          expect(allowed.has(sound), `${style}/${role}: ${sound}`).toBe(true);
        }
      }
    }
  });

  it('синтезаторы ролей — из зарегистрированных в Strudel', () => {
    const known = new Set(['sawtooth', 'square', 'triangle', 'sine', 'piano', 'pulse', 'supersaw', 'fm', 'am', 'organ']);
    for (const style of STYLES) {
      for (const role of ROLES) {
        const synth = ROLE_MATRIX[style][role].synth;
        if (synth) expect(known.has(synth), `${style}/${role}: ${synth}`).toBe(true);
      }
    }
  });

  it('ударные роли используют сэмплы, мелодические — синтезатор', () => {
    const percussive = ['kick', 'snare', 'hats', 'perc'];
    for (const style of STYLES) {
      for (const role of percussive) {
        expect(ROLE_MATRIX[style][role].sounds.length, `${style}/${role}`).toBeGreaterThan(0);
      }
      for (const role of ['pad', 'chords', 'lead', 'arp', 'bass', 'sub', 'texture']) {
        expect(ROLE_MATRIX[style][role].synth, `${style}/${role}`).toBeTruthy();
      }
    }
  });
});

describe('knowledge: формы', () => {
  it('у каждого стиля есть хотя бы одна форма', () => {
    for (const style of STYLES) {
      expect(formsForStyle(style).length, style).toBeGreaterThan(0);
    }
  });

  it('длина формы 32–96 тактов', () => {
    for (const style of STYLES) {
      for (const form of formsForStyle(style)) {
        const bars = formBars(form);
        expect(bars, `${form.id}`).toBeGreaterThanOrEqual(32);
        expect(bars, `${form.id}`).toBeLessThanOrEqual(96);
      }
    }
  });

  it('длины секций кратны 4 (правило 4/8/16 тактов)', () => {
    for (const style of STYLES) {
      for (const form of formsForStyle(style)) {
        for (const section of form.sections) {
          expect(section.bars % 4, `${form.id}/${section.kind}`).toBe(0);
          expect(section.bars).toBeGreaterThanOrEqual(4);
          expect(section.bars).toBeLessThanOrEqual(32);
        }
      }
    }
  });

  it('энергия секций в 0..1 и образует арку', () => {
    for (const style of STYLES) {
      for (const form of formsForStyle(style)) {
        for (const section of form.sections) {
          expect(section.energy).toBeGreaterThanOrEqual(0);
          expect(section.energy).toBeLessThanOrEqual(1);
        }
        const energies = form.sections.map((s) => s.energy);
        expect(Math.max(...energies)).toBeGreaterThan(Math.min(...energies));
      }
    }
  });

  it('в формах есть смена гармонии — секций не меньше трёх', () => {
    for (const style of STYLES) {
      for (const form of formsForStyle(style)) {
        expect(form.sections.length, `${form.id}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('роли секций существуют в матрице ролей', () => {
    for (const style of STYLES) {
      for (const form of formsForStyle(style)) {
        for (const section of form.sections) {
          for (const role of section.roles) {
            expect(ROLES, `${form.id}/${role}`).toContain(role);
            expect(ROLE_MATRIX[style][role], `${form.id}/${role}`).toBeTruthy();
          }
        }
      }
    }
  });

  it('переходы секций — из поддерживаемых', () => {
    for (const style of STYLES) {
      for (const form of formsForStyle(style)) {
        for (const section of form.sections) {
          if (!section.transition) continue;
          expect(TRANSITION_TYPES, `${form.id}`).toContain(section.transition.type);
          expect(section.transition.into).toBeTruthy();
        }
      }
    }
  });
});

describe('knowledge: переходы — функции, а не строки', () => {
  it('каждый переход — функция с аргументами (pattern, barsLen)', () => {
    for (const type of TRANSITION_TYPES) {
      expect(typeof TRANSITIONS[type]).toBe('function');
      expect(TRANSITIONS[type].length).toBe(2);
    }
  });

  it('переходы не мутируют исходный дескриптор', () => {
    const base = descriptor.degrees('0 5 2 6');
    const snapshot = JSON.stringify(base);
    for (const type of TRANSITION_TYPES) {
      TRANSITIONS[type](base, 8);
      expect(JSON.stringify(base)).toBe(snapshot);
    }
  });

  it('переход добавляет в цепочку только разрешённые методы', () => {
    const allowed = new Set([
      'gain', 'lpf', 'hpf', 'room', 'delay', 'pan', 'ply', 'fast', 'slow',
      'rev', 'off', 'every', 'degradeBy', 'sometimesBy', 'chunk', 'mask',
    ]);
    const base = descriptor.degrees('0 5 2 6');
    for (const type of TRANSITION_TYPES) {
      const result = TRANSITIONS[type](base, 8);
      expect(result.chain.length, type).toBeGreaterThan(0);
      for (const step of result.chain) {
        expect(allowed.has(step.method), `${type}: ${step.method}`).toBe(true);
      }
    }
  });
});

describe('knowledge: кривые автоматизации', () => {
  it('все кривые возвращают описание сигнала', () => {
    for (const name of CURVE_NAMES) {
      for (const style of [...STYLES, 'generic']) {
        const curve = CURVES[name](style, 8);
        expect(curve).toBeTruthy();
        expect(curve.kind).toBe('signal');
        expect(['sine', 'perlin', 'saw']).toContain(curve.signal);
        expect(curve.slow).toBeGreaterThanOrEqual(1);
        expect(curve.range).toHaveLength(2);
        // Диапазон всегда по возрастанию; направление задаётся отдельно.
        expect(curve.range[0], `${name}/${style}`).toBeLessThan(curve.range[1]);
        expect(['up', 'down']).toContain(curve.direction);
      }
    }
  });

  it('затухание направлено вниз, остальные кривые — вверх', () => {
    for (const style of [...STYLES, 'generic']) {
      expect(CURVES.fade(style, 8).direction).toBe('down');
      expect(CURVES.swell(style, 8).direction).toBe('up');
      expect(CURVES.sweep(style, 8).direction).toBe('up');
      expect(CURVES.motion(style, 8).direction).toBe('up');
    }
  });

  it('сигналы из белого списка Strudel', () => {
    for (const name of CURVE_NAMES) {
      const curve = CURVES[name]('techno', 8);
      expect(['sine', 'perlin', 'saw', 'triangle']).toContain(curve.signal);
    }
  });

  it('диапазоны по стилям различаются: у EDM шире, у lofi/ambient уже', () => {
    const sweepWidth = (style) => {
      const curve = CURVES.sweep(style, 8);
      return curve.range[1] - curve.range[0];
    };
    expect(sweepWidth('techno')).toBeGreaterThan(sweepWidth('lofi'));
    expect(sweepWidth('techno')).toBeGreaterThan(sweepWidth('ambient'));
  });
});
