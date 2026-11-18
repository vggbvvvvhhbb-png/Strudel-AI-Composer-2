import { resolveTimbre } from '../../samples/timbre-resolver.js';

export function referenceTimbres(passport) {
  const candidates = {};
  for (const role of ['bass', 'chords', 'pad', 'lead']) {
    const stem = passport?.stems?.[role === 'bass' ? 'bass' : 'other'];
    if (!stem?.available || !stem.descriptor) continue;
    const centroid = stem.descriptor.spectral?.centroidHz;
    const density = stem.descriptor.transients?.densityPerSec;
    if (!(Number.isFinite(centroid) && centroid > 0) && !(Number.isFinite(density) && density > 0)) continue;
    candidates[role] = resolveTimbre({ role, descriptor: stem.descriptor, limit: 3 });
  }
  return candidates;
}

export function referenceDigest(reference) {
  if (!reference?.passport) return '';
  const { passport, candidates } = reference;
  return [
    'Измеренный локальный аудиореференс — ориентир, не клон. Отсутствующие числа null означают «нет данных».',
    'Не копируй ноты или вокал; используй темп, тональность, контраст энергии и измеренные признаки как рекомендации.',
    'Жанровые ограничения имеют приоритет при конфликте с референсом.',
    JSON.stringify(passport),
    'Кандидаты Timbre Palette по роли и измеренным дескрипторам. Можно задать instrumentId партии из этого списка; рисунок и ноты создавай заново.',
    JSON.stringify(candidates),
  ].join('\n');
}
