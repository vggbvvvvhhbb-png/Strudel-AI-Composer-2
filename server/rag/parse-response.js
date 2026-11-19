// Парсер ответа ассистента (D-138): обоснование + блок кода Strudel.
// Устойчив к вариациям: fenced-блоки ```strudel/```js/```, голый код,
// текст до и после. Не выдумывает код, которого нет.

const FENCE_RE = /```(?:strudel|javascript|js|tidal)?[ \t]*\n([\s\S]*?)```/gi;

/**
 * @param {string} text сырой ответ модели
 * @returns {{ok: boolean, rationale: string, code: string, error?: string}}
 */
export function parseAssistantResponse(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: false, rationale: '', code: '', error: 'пустой ответ' };

  const blocks = [...raw.matchAll(FENCE_RE)].map((m) => m[1].trim()).filter(Boolean);
  if (blocks.length > 0) {
    // Первый блок — код; обоснование — текст до него.
    const first = raw.search(FENCE_RE);
    const rationale = raw.slice(0, first).replace(/```[^\n]*$/, '').trim();
    return { ok: true, rationale, code: blocks[0] };
  }

  // Голого кода признак: строка setCpm/партия $NAME:/вызов note|n|s|chord.
  const lines = raw.split('\n');
  const codeStart = lines.findIndex((l) => /^\s*(setCpm\s*\(|[_S]?\$\w+\s*:|note\s*\(|n\s*\(|s\s*\(|chord\s*\(|stack\s*\()/.test(l));
  if (codeStart >= 0) {
    return {
      ok: true,
      rationale: lines.slice(0, codeStart).join('\n').trim(),
      code: lines.slice(codeStart).join('\n').trim(),
    };
  }

  return { ok: false, rationale: raw, code: '', error: 'в ответе нет блока кода Strudel' };
}