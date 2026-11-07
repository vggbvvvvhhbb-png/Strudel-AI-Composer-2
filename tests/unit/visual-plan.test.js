// План визуализаций: какая партия что рисует и каким акцентом помечена.
// Проверяем то, что ломается незаметно: порядок карточек, соответствие
// цветов микшеру и то, что партия без визуализации не сдвигает чужие цвета.
import { describe, expect, it } from 'vitest';
import { visualPlan } from '../../src/core/visual-plan.js';

const CODE = [
  'setCpm(120/4)',
  '$MEL: note("c4 e4").s("piano")._pianoroll()',
  '$BASS: note("c2").s("sine").gain(.8)',
  '$DRUMS: s("bd ~ sd ~")._scope()',
  '$LEAD: note("g4").s("triangle")._pianoroll()',
].join('\n');

describe('план визуализаций', () => {
  it('партии без визуализации не попадают в план', () => {
    const plan = visualPlan(CODE);
    expect(plan.map((p) => p.label)).toEqual(['MEL', 'DRUMS', 'LEAD']);
  });

  it('тип визуализации определяется по вызову в коде партии', () => {
    const plan = visualPlan(CODE);
    expect(plan[0].kind).toBe('pianoroll');
    expect(plan[1].kind).toBe('scope');
    expect(plan[2].kind).toBe('pianoroll');
  });

  it('акцент считается по общему индексу партии, а не по номеру в плане', () => {
    const plan = visualPlan(CODE);
    // MEL — партия №1 → jade, DRUMS — партия №3 → teal, LEAD — партия №4 → lime.
    // Если бы считалось по позиции в плане, DRUMS получил бы mint.
    expect(plan[0].accent).toBe('jade');
    expect(plan[1].accent).toBe('teal');
    expect(plan[2].accent).toBe('lime');
  });

  it('в плане хранится исходный код партии — для показа над пианороллом', () => {
    const plan = visualPlan(CODE);
    expect(plan[0].lines.join('\n')).toContain('$MEL:');
    expect(plan[0].lines.join('\n')).toContain('note("c4 e4")');
  });

  it('пустой код даёт пустой план', () => {
    expect(visualPlan('')).toEqual([]);
    expect(visualPlan('setCpm(120/4)')).toEqual([]);
  });
});
