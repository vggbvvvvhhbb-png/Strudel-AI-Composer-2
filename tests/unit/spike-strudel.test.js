// Фаза 0, spike: проверяем утверждения о Strudel КОДОМ, а не по памяти.
//
// Каждый тест соответствует вопросу из docs/SPIKE.md. Если тест падает —
// соответствующее утверждение в документации ложно, и его надо исправить.
//
// ВАЖНО: ожидания ниже зафиксированы по фактическому поведению движка,
// а не по документации Strudel. Расхождения с документацией зафиксированы
// в docs/SPIKE.md как отдельные находки.

import { describe, it, expect } from 'vitest';
import { loadStrudel, runStrudel, strudelExportNames } from '../../server/music/strudel-runtime.mjs';
import { staticValidate } from '../../src/core/validator.js';
import { parseParts, getBpm, getKey } from '../../src/core/code-model.js';

describe('spike: публичный API Strudel', () => {
  it('API выгружается: есть ключевые функции', async () => {
    const names = await strudelExportNames();
    expect(names.length).toBeGreaterThan(500);
    for (const fn of [
      'mini', 'n', 'note', 'chord', 's', 'stack', 'arrange', 'silence',
      'scale', 'perlin', 'sine', 'cat', 'slowcat', 'struct', 'mask', 'every',
    ]) {
      expect(names).toContain(fn);
    }
  });
});

describe('spike: исполнение в Node без браузера', () => {
  it('mini-паттерн даёт реальные события через queryArc', async () => {
    const api = await loadStrudel();
    const haps = api.mini('bd sd hh').queryArc(0, 4);
    expect(haps.length).toBe(12); // 3 события × 4 такта
    expect(haps[0].value).toBe('bd');
  });

  it('строковый парсер mini включён: n("0 5 2 6") даёт 4 разные ноты', async () => {
    const api = await loadStrudel();
    const haps = api.n('0 5 2 6').scale('c:minor').queryArc(0, 1);
    expect(haps.length).toBe(4);
    expect(haps.map((h) => h.value.note)).toEqual(['C3', 'Ab3', 'Eb3', 'Bb3']);
  });

  it('БЕЗ setStringParser строка не разбирается — вот почему он нужен', async () => {
    // Находка: без setStringParser(mini) литерал "0 5 2 6" — это ОДНО значение.
    // В Node вызываем явно (в браузере это делает initStrudel).
    const api = await loadStrudel();
    api.setStringParser(null);
    try {
      const haps = api.n('0 5 2 6').queryArc(0, 1);
      expect(haps.length).toBe(1);
    } finally {
      api.setStringParser(api.mini);
    }
    expect(api.n('0 5 2 6').queryArc(0, 1).length).toBe(4);
  });

  it('степени лада: degree — это индекс ступени, а не нота', async () => {
    const api = await loadStrudel();
    // 0..6 в c:minor = C D Eb F G Ab Bb; degree 7 — тоника следующей октавы.
    const haps = api.n('0 1 2 3 4 5 6').scale('c:minor').queryArc(0, 1);
    expect(haps.map((h) => h.value.note)).toEqual(['C3', 'D3', 'Eb3', 'F3', 'G3', 'Ab3', 'Bb3']);
    const oct = api.n('7').scale('c:minor').queryArc(0, 1);
    expect(oct[0].value.note).toBe('C4');
  });

  it('трезвучие степенями: 0-2-4 в c:minor = C-Eb-G', async () => {
    const api = await loadStrudel();
    const haps = api.n('0 2 4').scale('c:minor').queryArc(0, 1);
    expect(haps.map((h) => h.value.note)).toEqual(['C3', 'Eb3', 'G3']);
    const major = api.n('0 2 4').scale('c:major').queryArc(0, 1);
    expect(major.map((h) => h.value.note)).toEqual(['C3', 'E3', 'G3']);
  });

  it('note() с названиями нот работает', async () => {
    const api = await loadStrudel();
    const haps = api.note('c4 e4 g4').queryArc(0, 1);
    expect(haps.length).toBe(3);
    expect(haps.map((h) => h.value.note)).toEqual(['c4', 'e4', 'g4']);
  });

  it('сэмплы разбираются мини-нотацией', async () => {
    const api = await loadStrudel();
    expect(api.s('bd*4, hh*8').queryArc(0, 1).length).toBe(12);
    expect(api.s('bd*4, hh*8').queryArc(0, 4).length).toBe(48);
  });

  it('партии $NAME: собираются и опрашиваются', async () => {
    const code = `
const key = "c:minor"
$BASS: n("<0 5 2 6>/2").scale(key).s("sawtooth")
$DRUMS: s("bd*4, hh*8")
`;
    const res = await runStrudel(code, { cycles: 4 });
    expect(res.ok).toBe(true);
    expect(Object.keys(res.parts).sort()).toEqual(['BASS', 'DRUMS']);
    expect(res.parts.BASS.length).toBeGreaterThan(0);
    expect(res.parts.DRUMS.length).toBe(48);
  });

  it('ошибка в коде не роняет исполнение, а попадает в error', async () => {
    const res = await runStrudel('$X: thisIsNotDefined()', { cycles: 2 });
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });

  it('метка партии видна микшеру: порядок сохраняется', async () => {
    const res = await runStrudel('$BASS: s("bd")\n$LEAD: s("hh")', { cycles: 2 });
    expect(res.order).toEqual(['BASS', 'LEAD']);
  });
});

describe('spike: arrange, silence и таймлайн', () => {
  it('arrange: секция silence пуста, следующая начинается со своего такта', async () => {
    const api = await loadStrudel();
    const haps = api.arrange([4, api.silence], [4, api.mini('bd')]).queryArc(0, 8);
    expect(haps.length).toBe(4);
    expect(haps.map((h) => Number(h.whole.begin))).toEqual([4, 5, 6, 7]);
  });

  it('arrange с басом из гармонии: события стартуют в такт своей секции', async () => {
    const code = `
const key = "c:minor"
const bassA = n("<0 5 2 6>/2").scale(key).s("sawtooth")
const bassB = n("<0 3 5 7>/2").scale(key).s("sawtooth")
$BASS: arrange([8, silence], [16, bassA], [16, bassB])
`;
    const res = await runStrudel(code, { cycles: 40 });
    expect(res.ok).toBe(true);
    const haps = res.parts.BASS;
    const inCycle = (c) => haps.filter((h) => h.whole.begin >= c && h.whole.begin < c + 1).length;
    expect(inCycle(0)).toBe(0); // секция silence
    expect(inCycle(8)).toBeGreaterThan(0); // bassA
    expect(inCycle(24)).toBeGreaterThan(0); // bassB
    expect(inCycle(40)).toBe(0); // за пределами arrange
  });

  it('выражение "/2" замедляет чередование, а не сдвигает его', async () => {
    // Находка: "<0 5 2 6>/2" — это 4 чередования по 2 такта каждое.
    const api = await loadStrudel();
    const haps = api.n('<0 5 2 6>/2').scale('c:minor').queryArc(0, 8);
    const begins = haps.map((h) => Number(h.whole.begin));
    expect(begins).toEqual([0, 0, 2, 2, 4, 4, 6, 6]);
  });

  it('.slow(2) даёт 4 события по 2 такта — чище, чем "/2"', async () => {
    // Находка: "/2" дублирует события (8 штук), .slow(2) — 4 события длиной 2 такта.
    const api = await loadStrudel();
    const haps = api.n('<0 5 2 6>').scale('c:minor').slow(2).queryArc(0, 8);
    expect(haps.length).toBe(4);
    expect(haps.map((h) => [h.value.note, Number(h.whole.begin), Number(h.whole.end)])).toEqual([
      ['C3', 0, 2],
      ['Ab3', 2, 4],
      ['Eb3', 4, 6],
      ['Bb3', 6, 8],
    ]);
  });

  it('эффекты после arrange не ломают таймлайн', async () => {
    const code = `
const key = "c:minor"
const bassA = n("<0 5 2 6>/2").scale(key).s("sawtooth")
$BASS: arrange([8, silence], [16, bassA]).gain(0.8)._pianoroll()
`;
    const res = await runStrudel(code, { cycles: 12 });
    expect(res.ok).toBe(true);
    expect(res.parts.BASS.length).toBeGreaterThan(0);
  });
});

describe('spike: нотация гармонии', () => {
  it('chord() принимает символы вида Am / Am7 / C', async () => {
    const api = await loadStrudel();
    expect(api.chord('Am').voicing().queryArc(0, 1).length).toBeGreaterThan(0);
    expect(api.chord('Am7').voicing().queryArc(0, 1).length).toBeGreaterThan(0);
    expect(api.chord('C').voicing().queryArc(0, 1).length).toBeGreaterThan(0);
  });

  it('chord("A:min") НЕ работает — формат с двоеточием отвергнут', async () => {
    const api = await loadStrudel();
    // Граница зафиксирована: движок voicing не понимает "A:min".
    expect(api.chord('A:min').voicing().queryArc(0, 1).length).toBe(0);
  });

  it('scale() принимает "c:minor" и "c:major"', async () => {
    const api = await loadStrudel();
    expect(api.n('0 2 4').scale('c:major').queryArc(0, 1).map((h) => h.value.note))
      .toEqual(['C3', 'E3', 'G3']);
    expect(api.n('0 2 4').scale('c:minor').queryArc(0, 1).map((h) => h.value.note))
      .toEqual(['C3', 'Eb3', 'G3']);
  });

  it('модальные лады доступны по полному имени', async () => {
    const api = await loadStrudel();
    const dorian = api.n('0 2 4 5').scale('c:dorian').queryArc(0, 1);
    expect(dorian.map((h) => h.value.note)).toEqual(['C3', 'Eb3', 'G3', 'A3']);
    const mixo = api.n('0 2 4 6').scale('c:mixolydian').queryArc(0, 1);
    expect(mixo.map((h) => h.value.note)).toEqual(['C3', 'E3', 'G3', 'Bb3']);
  });

  it('сокращения "c:maj" и "c:min" НЕ принимаются', async () => {
    // Находка: tonal требует полное имя лада. "c:maj" молча даёт пустой результат.
    const api = await loadStrudel();
    expect(api.n('0 2 4').scale('c:maj').queryArc(0, 1).length).toBe(0);
    expect(api.n('0 2 4').scale('c:min').queryArc(0, 1).length).toBe(0);
  });

  it('harmminor требует пробела: "c:harmonic minor", не "c:harmonicminor"', async () => {
    const api = await loadStrudel();
    expect(api.n('0 2 4').scale('c:harmonic minor').queryArc(0, 1).length).toBeGreaterThan(0);
    expect(api.n('0 2 4').scale('c:harmonicminor').queryArc(0, 1).length).toBe(0);
  });
});

describe('spike: автоматизация и вариации', () => {
  it('сигнал раскрывается в значении параметра', async () => {
    const api = await loadStrudel();
    const haps = api.n('0 2 4').scale('c:minor').gain(api.sine.slow(4).range(0.2, 0.8)).queryArc(0, 2);
    const gains = haps.map((h) => h.value.gain);
    expect(gains.length).toBe(6);
    expect(new Set(gains.map((g) => g.toFixed(3))).size).toBeGreaterThan(3);
  });

  it('lpf с сигналом меняет cutoff', async () => {
    const api = await loadStrudel();
    const haps = api.n('0 2 4').scale('c:minor').lpf(api.sine.slow(4).range(300, 3000)).queryArc(0, 2);
    const cutoffs = haps.map((h) => Math.round(h.value.cutoff));
    expect(new Set(cutoffs).size).toBeGreaterThan(3);
  });

  it('голый сигнал без параметра даёт константу', async () => {
    // Важно для метрики автоматизации: сигнал виден только в контексте параметра.
    const api = await loadStrudel();
    const haps = api.sine.slow(4).range(0.2, 0.8).queryArc(0, 4);
    expect(new Set(haps.map((h) => h.value)).size).toBe(1);
  });

  it('вариации партии работают', async () => {
    const api = await loadStrudel();
    expect(api.s('bd sd').every(2, (x) => x.rev()).queryArc(0, 4).length).toBe(8);
    expect(api.n('0 2 4 6').struct('x ~ x x').queryArc(0, 1).length).toBe(3);
    expect(api.s('bd').ply(2).queryArc(0, 1).length).toBe(2);
    expect(api.s('bd*4').degradeBy(0.5).queryArc(0, 8).length).toBeGreaterThan(0);
    expect(api.s('bd*4').sometimesBy(0.3, (x) => x.fast(2)).queryArc(0, 8).length).toBeGreaterThan(0);
    // .rev() разворачивает ВРЕМЯ: cp звучит в 0, bd — в 0.75.
    // Порядок элементов в массиве при этом остаётся исходным.
    const rev = api.s('bd sd hh cp').rev().queryArc(0, 1);
    expect(rev.map((h) => [h.value.s, Number(h.whole.begin)])).toEqual([
      ['bd', 0.75],
      ['sd', 0.5],
      ['hh', 0.25],
      ['cp', 0],
    ]);
  });

  it('.off() требует двух аргументов', async () => {
    const api = await loadStrudel();
    expect(() => api.s('bd*4').off(0.25)).toThrow();
    expect(api.s('bd*4').off(0.25, (x) => x.fast(2)).queryArc(0, 1).length).toBe(12);
  });
});

describe('spike: совместимость с валидатором и микшером', () => {
  it('валидатор принимает arrange и стрелочные функции', () => {
    const code = `setCpm(124/4)
const key = "c:minor"
const bassA = n("<0 5 2 6>/2").scale(key).s("sawtooth")
$BASS: arrange([8, silence], [16, bassA]).gain(0.8)._pianoroll()
$DRUMS: s("bd*4, hh*8").every(4, x => x.rev())._scope()
`;
    expect(staticValidate(code).ok).toBe(true);
    expect(parseParts(code).map((p) => p.label)).toEqual(['BASS', 'DRUMS']);
    expect(getBpm(code)).toBe(124);
    expect(getKey(code)).toBe('c:minor');
  });

  it('такой код исполняется в headless', async () => {
    const code = `setCpm(124/4)
const key = "c:minor"
const bassA = n("<0 5 2 6>/2").scale(key).s("sawtooth")
$BASS: arrange([8, silence], [16, bassA]).gain(0.8)._pianoroll()
$DRUMS: s("bd*4, hh*8").every(4, x => x.rev())._scope()
`;
    const res = await runStrudel(code, { cycles: 24 });
    expect(res.ok).toBe(true);
    expect(res.parts.BASS.length).toBeGreaterThan(0);
    expect(res.parts.DRUMS.length).toBeGreaterThan(0);
  });
});

describe('spike: темп', () => {
  it('setCpm(x/4) разбирается транспилятором без ошибок', async () => {
    const res = await runStrudel('setCpm(124/4)\n$X: s("bd")', { cycles: 2 });
    expect(res.ok).toBe(true);
  });
});
