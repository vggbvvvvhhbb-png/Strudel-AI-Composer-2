// Тесты движка мотивов (фаза D — мелодический мозг).
//
// Проверяем то, что можно проверить чисто:
//   • детерминизм (один seed — один мотив, байт в байт);
//   • трансформации сохраняют длину и интервальный рисунок;
//   • мини-нотация занимает ровно такт (16 слотов 1/16);
//   • фраза A|A'|B|A'' разрешается в тонику;
//   • мотив не выходит за бюджет атак на такт группы.

import { describe, it, expect } from 'vitest';

import {
  CONTOURS,
  RHYTHMS,
  createMotif,
  transposeMotif,
  invertMotif,
  retrogradeMotif,
  augmentMotif,
  fragmentMotif,
  withEnding,
  motifToMini,
  phraseVariants,
  groupTheme,
  voiceMotifMini,
  trackTheme,
  assignPhraseRoles,
  intervalSignature,
  signatureSimilarity,
  MOTIF_LENGTH_BY_GROUP,
} from '../../src/music/motif.js';
import { attacksPerBar } from '../../src/music/expand.js';
import { GROUP_BUDGET } from '../../src/music/expand.js';
import { parseMini } from '../../server/music/mini.js';

describe('мотив: создание', () => {
  it('детерминирован: один seed — один и тот же мотив', () => {
    const a = createMotif({ seed: 42, style: 'jazz', length: 4 });
    const b = createMotif({ seed: 42, style: 'jazz', length: 4 });
    expect(a).toEqual(b);
  });

  it('разные seed дают разные мотивы', () => {
    const a = createMotif({ seed: 1, style: 'jazz', length: 4 });
    const b = createMotif({ seed: 2, style: 'jazz', length: 4 });
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('ступени не уходят ниже тоники', () => {
    for (let seed = 0; seed < 40; seed += 1) {
      const motif = createMotif({ seed, style: 'cinematic', length: 4 });
      expect(Math.min(...motif.degrees)).toBeGreaterThanOrEqual(0);
    }
  });

  it('контур и ритм взяты из известных архетипов', () => {
    const motif = createMotif({ seed: 7, style: 'techno', length: 4 });
    expect(Object.keys(CONTOURS)).toContain(motif.contour);
    expect(Object.keys(RHYTHMS)).toContain(motif.rhythm);
  });

  it('длина мотива ровно запрошенная', () => {
    expect(createMotif({ seed: 3, length: 2 }).degrees).toHaveLength(2);
    expect(createMotif({ seed: 3, length: 4 }).degrees).toHaveLength(4);
  });
});

describe('мотив: трансформации', () => {
  const motif = createMotif({ seed: 11, style: 'rock', contour: 'rise', rhythm: 'straight', length: 4 });

  it('транспозиция сдвигает все ступени на дельту', () => {
    const moved = transposeMotif(motif, 2);
    expect(moved.degrees).toEqual(motif.degrees.map((value) => value + 2));
  });

  it('инверсия переворачивает рисунок, но сохраняет длину', () => {
    const flipped = invertMotif(motif, 4);
    expect(flipped.degrees).toHaveLength(motif.degrees.length);
    // Расстояния между нотами сохраняются, направление — меняется.
    expect(Math.abs(flipped.degrees[1] - flipped.degrees[0]))
      .toBe(Math.abs(motif.degrees[1] - motif.degrees[0]));
  });

  it('ретроград читает рисунок задом наперёд', () => {
    const back = retrogradeMotif(motif);
    expect(back.degrees).toEqual([...motif.degrees].reverse());
    // Сетка восходящая: звучащий порядок — перевёрнутые ступени. Переворот
    // сетки вместе со ступенями отменил бы ретроград (motifToMini сортирует
    // по шагу) и увёл бы каденцию на первую ноту фразы.
    expect(back.steps).toEqual(motif.steps);
    const sounding = motifToMini(back).split(' ').map((token) => Number(token.split('@')[0]));
    expect(sounding).toEqual([...motif.degrees].reverse());
  });

  it('аугментация растягивает ритм и не выходит за такт', () => {
    const wide = augmentMotif(motif, 2);
    expect(Math.max(...wide.steps)).toBeLessThan(16);
    expect(wide.steps.every((step) => step % 2 === 0)).toBe(true);
  });

  it('фрагментация оставляет начало мотива', () => {
    const piece = fragmentMotif(motif, 2);
    expect(piece.degrees).toEqual(motif.degrees.slice(0, 2));
    expect(piece.steps).toEqual(motif.steps.slice(0, 2));
  });

  it('каденция ставит последнюю ноту на заданную ступень', () => {
    const ended = withEnding(motif, 0);
    expect(ended.degrees[ended.degrees.length - 1]).toBe(0);
  });
});

describe('мотив: мини-нотация', () => {
  it('длительности в сумме дают ровно такт', () => {
    const mini = motifToMini(createMotif({ seed: 5, style: 'techno', length: 4 }));
    const tokens = mini.split(' ');
    expect(tokens).toHaveLength(4);
    const total = tokens.reduce((sum, token) => sum + Number(token.split('@')[1]), 0);
    expect(total).toBe(16);
  });

  it('число нот равно числу атак в такте', () => {
    const motif = createMotif({ seed: 5, style: 'techno', length: 3 });
    const mini = motifToMini(motif);
    expect(attacksPerBar(mini)).toBe(motif.degrees.length);
  });

  it('нота тянется до следующей атаки — голос звучит, а не пульсирует', () => {
    const motif = createMotif({ seed: 5, style: 'cinematic', length: 2 });
    const parsed = parseMini(motifToMini(motif), { cycles: 1 });
    expect(parsed.errors).toEqual([]);
    // Каждая нота длится до следующей атаки, а последняя — до конца такта.
    expect(parsed.events[0].end).toBeCloseTo(parsed.events[1].begin, 6);
    expect(parsed.events[parsed.events.length - 1].end).toBeCloseTo(1, 6);
    // И ни одна нота не короче восьмой: стаккато-пульс оркестру не нужен.
    for (const event of parsed.events) {
      expect(event.end - event.begin).toBeGreaterThanOrEqual(0.125 - 1e-9);
    }
  });

  it('все токены — ступень лада с длительностью', () => {
    const mini = motifToMini(createMotif({ seed: 9, style: 'jazz', length: 4 }));
    for (const token of mini.split(' ')) {
      expect(token).toMatch(/^\d+@\d+$/);
    }
  });
});

describe('мотив: фраза', () => {
  it('четыре варианта: A, A\', B, A\'\'', () => {
    const variants = phraseVariants(createMotif({ seed: 4, style: 'cinematic', length: 4 }));
    expect(variants.map((item) => item.role)).toEqual(['A', "A'", 'B', "A''"]);
  });

  it('A\' отличается от A — это транспозиция', () => {
    const variants = phraseVariants(createMotif({ seed: 4, style: 'cinematic', length: 4 }));
    expect(variants[1].mini).not.toBe(variants[0].mini);
  });

  it('A\'\' разрешается в тонику: V–I в двух последних нотах', () => {
    const variants = phraseVariants(createMotif({ seed: 4, style: 'cinematic', length: 4 }));
    const degrees = variants[3].motif.degrees;
    expect(degrees[degrees.length - 1]).toBe(0);
    expect(degrees[degrees.length - 2]).toBe(4);
  });

  it('фраза заканчивается половинной каденцией на доминанте', () => {
    const variants = phraseVariants(createMotif({ seed: 4, style: 'cinematic', length: 4 }));
    const degrees = variants[0].motif.degrees;
    expect(degrees[degrees.length - 1]).toBe(4);
  });
});

describe('мотив: оркестр', () => {
  const theme = trackTheme({ seed: 21, style: 'cinematic' });

  it('все группы берут одну тему — иначе это набор солистов', () => {
    const strings = groupTheme('strings', { seed: 21, style: 'cinematic', theme });
    const lead = groupTheme('lead', { seed: 21, style: 'cinematic', theme });
    expect(strings.degrees).toEqual(lead.degrees);
  });

  it('медные отвечают инверсией темы', () => {
    const brass = groupTheme('brass', { seed: 21, style: 'cinematic', theme });
    expect(brass.degrees).not.toEqual(theme.degrees);
  });

  it('дивизи: голоса группы получают разные варианты фразы', () => {
    const first = voiceMotifMini({ group: 'strings', seed: 21, style: 'cinematic', voiceIndex: 0, variantIndex: 0, theme });
    const second = voiceMotifMini({ group: 'strings', seed: 21, style: 'cinematic', voiceIndex: 1, variantIndex: 0, theme });
    expect(first).not.toBe(second);
  });

  it('фраза идёт по форме: солист меняет вариант от секции к секции', () => {
    const first = voiceMotifMini({ group: 'lead', seed: 21, style: 'cinematic', voiceIndex: 0, variantIndex: 0, theme });
    const second = voiceMotifMini({ group: 'lead', seed: 21, style: 'cinematic', voiceIndex: 0, variantIndex: 1, theme });
    expect(first).not.toBe(second);
  });

  it('солист не делит фразу с другими голосами', () => {
    const first = voiceMotifMini({ group: 'lead', seed: 21, style: 'cinematic', voiceIndex: 0, variantIndex: 2, theme });
    const second = voiceMotifMini({ group: 'lead', seed: 21, style: 'cinematic', voiceIndex: 1, variantIndex: 2, theme });
    expect(first).toBe(second);
  });

  it('мотив группы не превышает бюджет атак на такт', () => {
    for (const [group, length] of Object.entries(MOTIF_LENGTH_BY_GROUP)) {
      expect(length).toBeLessThanOrEqual(GROUP_BUDGET[group]);
      const mini = voiceMotifMini({ group, seed: 21, style: 'cinematic', voiceIndex: 0, variantIndex: 0, theme });
      expect(attacksPerBar(mini)).toBeLessThanOrEqual(GROUP_BUDGET[group]);
    }
  });
});

describe('мотив: фраза по форме', () => {
  it('тихая секция — предпосылка (A), громкая — вывод (A\'\')', () => {
    const roles = assignPhraseRoles([
      { energy: 0.35 },
      { energy: 0.55 },
      { energy: 0.9 },
    ]);
    expect(roles.get(0)).toBe(0);
    expect(roles.get(2)).toBe(3);
    expect(roles.get(1)).toBe(1);
  });

  it('порядок секций в треке не влияет на назначение по энергии', () => {
    const roles = assignPhraseRoles([{ energy: 0.9 }, { energy: 0.35 }]);
    expect(roles.get(1)).toBe(0);
    expect(roles.get(0)).toBe(3);
  });

  it('единственная секция — полное разрешение', () => {
    const roles = assignPhraseRoles([{ energy: 0.5 }]);
    expect(roles.get(0)).toBe(3);
  });
});

describe('мотив: сходство', () => {
  it('одинаковые рисунки — сходство 1', () => {
    expect(signatureSimilarity([1, 2, -1], [1, 2, -1])).toBe(1);
  });

  it('разные рисунки — сходство меньше 1', () => {
    expect(signatureSimilarity([1, 2, -1], [-1, -2, 1])).toBeLessThan(1);
  });

  it('пустые рисунки не дают ложного сходства', () => {
    expect(signatureSimilarity([], [1, 2])).toBe(0);
  });

  it('интервальный рисунок — разности соседних ступеней', () => {
    expect(intervalSignature({ degrees: [0, 2, 4] })).toEqual([2, 2]);
  });
});
