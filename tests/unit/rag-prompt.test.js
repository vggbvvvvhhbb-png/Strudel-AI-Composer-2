// Фаза E: сборщик промпта и парсер ответа (D-138).

import { describe, it, expect } from 'vitest';
import {
  buildSystemPrompt, buildMessages, examplesBlock, loadVoiceRules, presetLines, PROMPT_VERSION,
} from '../../server/rag/prompt.js';
import { parseAssistantResponse } from '../../server/rag/parse-response.js';
import { loadTimbreCatalog } from '../../server/samples/timbre.js';
import { loadDataset } from '../../server/rag/dataset.js';

const catalog = loadTimbreCatalog();
const { entries } = loadDataset();

describe('сборщик системного промпта', () => {
  const prompt = buildSystemPrompt({ catalog });

  it('версионируется и содержит роль образованного композитора', () => {
    expect(prompt).toContain(PROMPT_VERSION);
    expect(prompt).toContain('музыкально образованный');
  });

  it('белый список звуков извлечён из system.md (не дубль)', () => {
    const voice = loadVoiceRules();
    expect(voice.samples).toContain('bd');
    expect(voice.samples).toContain('808mc');
    expect(voice.samples).toContain('breaks152');
    expect(voice.synths).toContain('sawtooth');
    expect(voice.synths).toContain('piano');
    for (const s of voice.samples) expect(prompt).toContain(s);
  });

  it('все 10 реальных пресетов в промпте, выдуманных нет', () => {
    const lines = presetLines(catalog);
    expect(lines).toHaveLength(10);
    for (const p of Object.values(catalog.presets)) {
      expect(prompt).toContain(p.strudelAlias);
      expect(prompt).toContain(p.id);
    }
    expect(prompt).not.toContain('cc0_rhodes_warm');
    expect(prompt).not.toContain('cc0_kit_lofi');
  });

  it('теория и формат ответа на месте', () => {
    expect(prompt).toContain('T (тоника');
    expect(prompt).toContain('D→T');
    expect(prompt).toContain('1–3 предложения');
    expect(prompt).toContain('```strudel');
    expect(prompt).toContain('минимум 16 тактов');
  });

  it('факты движка в правилах: voicing, M7, harmonic minor через note()', () => {
    expect(prompt).toContain('.voicing()');
    expect(prompt).toContain('FM7');
    expect(prompt).toContain('harmonic minor через scale() не работает');
  });

  it('buildMessages: система + примеры + текущий код + запрос', () => {
    const results = [{ entry: entries[0], score: 0.9 }];
    const msgs = buildMessages({
      userRequest: 'сделай теплее',
      currentCode: '$MEL: note("c4")',
      searchResults: results,
      catalog,
    });
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('system');
    expect(msgs[1].content).toContain(entries[0].title);
    expect(msgs[1].content).toContain(entries[0].rationale);
    expect(msgs[1].content).toContain('$MEL: note("c4")');
    expect(msgs[1].content).toContain('сделай теплее');
  });

  it('examplesBlock пуст без результатов', () => {
    expect(examplesBlock([])).toBe('');
    expect(examplesBlock(null)).toBe('');
  });
});

describe('парсер ответа ассистента', () => {
  it('fenced-блок strudel + обоснование до него', () => {
    const r = parseAssistantResponse('Тоника с add6 смягчает минор.\n```strudel\n$MEL: note("c4 eb4")\n```');
    expect(r.ok).toBe(true);
    expect(r.rationale).toBe('Тоника с add6 смягчает минор.');
    expect(r.code).toBe('$MEL: note("c4 eb4")');
  });

  it('вариации ограждений: js, javascript, без языка', () => {
    for (const fence of ['js', 'javascript', '']) {
      const r = parseAssistantResponse(`обоснование\n\`\`\`${fence}\nsetCpm(90/4)\n\`\`\``);
      expect(r.ok).toBe(true);
      expect(r.code).toBe('setCpm(90/4)');
    }
  });

  it('голый код без ограждений распознаётся по setCpm/партии', () => {
    const r = parseAssistantResponse('Вот решение:\nsetCpm(120/4)\n$DRUMS: s("bd*4")');
    expect(r.ok).toBe(true);
    expect(r.code).toContain('setCpm(120/4)');
    expect(r.code).toContain('$DRUMS');
    expect(r.rationale).toBe('Вот решение:');
  });

  it('текст после блока игнорируется, первый блок — код', () => {
    const r = parseAssistantResponse('обоснование\n```strudel\n$X: s("bd")\n```\nнадеюсь помогло\n```js\nмусор\n```');
    expect(r.code).toBe('$X: s("bd")');
  });

  it('ответ без кода — честная ошибка, не выдумка', () => {
    const r = parseAssistantResponse('Я не могу это сделать.');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('');
    expect(r.error).toContain('нет блока кода');
  });

  it('пустой ответ — ошибка', () => {
    expect(parseAssistantResponse('').ok).toBe(false);
    expect(parseAssistantResponse(null).ok).toBe(false);
  });
});