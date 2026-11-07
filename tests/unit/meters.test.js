// Инструментация кода для живых метров партий.
// Проверяем, что счётчики вплетаются в цепочку каждой партии и не ломают код.
import { describe, it, expect } from 'vitest';
import { instrumentCode } from '../../src/meters.js';

describe('instrumentCode', () => {
  it('вплетает счётчик в партию', () => {
    const code = ['$BASS: note("e1").s("sawtooth")._pianoroll()'].join('\n');
    const { code: out, labels } = instrumentCode(code);
    expect(labels).toEqual(['BASS']);
    // Метка в одинарных кавычках: транспайлер Strudel превращает строки
    // в двойных кавычках в mini-паттерн (miniAllStrings).
    expect(out).toContain("SA_METER('BASS')");
    expect(out).toContain('.onTrigger(');
  });

  it('передаёт false вторым аргументом — звук не перехватывается', () => {
    const code = '$BASS: note("e1")._pianoroll()';
    const { code: out } = instrumentCode(code);
    expect(out).toContain(".onTrigger(()=>SA_METER('BASS'),false)");
  });

  it('размечает каждую партию отдельно', () => {
    const code = [
      'setCpm(120/4)',
      '$DRUMS: s("bd*4").bank("RolandTR909")._scope()',
      '$BASS: note("e1")._pianoroll()',
    ].join('\n');
    const { code: out, labels } = instrumentCode(code);
    expect(labels).toEqual(['DRUMS', 'BASS']);
    expect(out).toContain("SA_METER('DRUMS')");
    expect(out).toContain("SA_METER('BASS')");
    // строка setCpm остаётся нетронутой
    expect(out.split('\n')[0]).toBe('setCpm(120/4)');
  });

  it('ставит счётчик перед комментарием в конце строки', () => {
    const code = '$BASS: note("e1")._pianoroll() // бас';
    const { code: out } = instrumentCode(code);
    expect(out).toMatch(/SA_METER\('BASS'\),false\)\s*\/\/ бас$/);
    expect(out.indexOf('SA_METER')).toBeLessThan(out.indexOf('// бас'));
  });

  it('поддерживает многострочную цепочку партии', () => {
    const code = ['$BASS: note("e1")', '  .s("sawtooth")', '  ._pianoroll()'].join('\n');
    const { code: out, labels } = instrumentCode(code);
    expect(labels).toEqual(['BASS']);
    expect(out.split('\n')[2]).toContain("SA_METER('BASS')");
  });

  it('не трогает код без партий', () => {
    const code = 'setCpm(120/4)\nconst key = "a:minor"';
    const { code: out, labels } = instrumentCode(code);
    expect(labels).toEqual([]);
    expect(out).toBe(code);
  });

  it('не мутирует исходный код', () => {
    const code = '$BASS: note("e1")._pianoroll()';
    instrumentCode(code);
    expect(code).toBe('$BASS: note("e1")._pianoroll()');
  });

  it('пропускает партии без метки', () => {
    const code = '$: note("e1")._pianoroll()';
    const { code: out, labels } = instrumentCode(code);
    expect(labels).toEqual([]);
    expect(out).toBe(code);
  });
});
