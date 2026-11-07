// План визуализаций: какая партия что рисует и каким акцентом помечена.
// Чистый модуль без зависимостей от браузера — поэтому его можно тестировать.
import { parseParts } from './code-model.js';
import { accentOf } from '../accents.js';

export function visualPlan(code) {
  const lines = code.split('\n');
  const plan = [];
  parseParts(code).forEach((part, partIndex) => {
    const block = lines.slice(part.startLine, part.endLine + 1).join('\n');
    let kind = null;
    if (/(_)?(pianoroll|punchcard|wordfall)\s*\(/.test(block)) kind = 'pianoroll';
    else if (/(_)?(scope|fscope|spectrum)\s*\(/.test(block)) kind = 'scope';
    if (!kind) return;
    plan.push({
      label: part.label || '',
      kind,
      // Акцент — по общему индексу партии в коде, чтобы в микшере и в партитуре
      // одна и та же партия была одного цвета, даже если у соседей нет визуализации.
      accent: accentOf(partIndex),
      // Исходный код партии: показывается прямо над пианороллом.
      lines: lines.slice(part.startLine, part.endLine + 1).map((l) => l.trimEnd()),
    });
  });
  return plan;
}
