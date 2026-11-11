// Best-of-N на уровне спеки: набор РАЗНЫХ вариантов вместо одного.
//
// Идея: перебор промптов не даёт разнообразия — модель возвращает то же
// самое. Разнообразие строится на уровне спеки: углы (форма, прогрессия,
// роли, энергия, мотив) и детерминированные мутации дают структурно
// разные варианты, а запрет повторов гарантирует, что пользователь увидит
// действительно разные треки.
//
// Отбор: кандидат отбрасывается, если он слишком похож на исходную спеку
// или на уже принятый кандидат (минимальное расстояние) — и ПЕРЕСЭМПЛИРУЕТСЯ:
// тот же угол с другим сдвигом варианта и/или поверх мутации.
//
// Детерминированность: весь выбор делается хэшем от (seed, номер попытки),
// без PRNG. Один и тот же seed — один и тот же набор кандидатов.

import { checkSpec } from './spec/check.js';
import { ANGLE_NAMES, applyAngle } from './angles.js';
import { MUTATION_NAMES, applyMutation } from './mutations.js';
import {
  MIN_DISTANCE,
  hashText,
  sameSpec,
  specDistance,
  specFingerprint,
} from './diversity.js';

/**
 * Подробный отбор кандидатов: спека + метаданные (угол, мутация,
 * отпечаток, расстояние до исходной).
 *
 * @param {object} spec исходная спека
 * @param {{count?: number, seed?: number, threshold?: number}} [options]
 * @returns {Array<{spec: object, angle: string, mutation: string|null, fingerprint: string, distance: number}>}
 */
export function generateCandidateDetails(spec, options = {}) {
  const count = Math.max(0, Math.trunc(options.count ?? 4));
  const seed = options.seed ?? 0;
  const threshold = options.threshold ?? MIN_DISTANCE;
  if (!count) return [];

  const accepted = [];
  const cores = new Set();
  const maxAttempts = Math.max(48, count * 24);
  let attempt = 0;

  // Проходы с постепенно ослабляемым требованием к исходной спеке.
  // Требование к попарному расстоянию НЕ ослабляется: это и есть смысл
  // отбора — два разных варианта должны различаться.
  const passes = [threshold, threshold * 0.5, 0];
  for (const pass of passes) {
    while (accepted.length < count && attempt < maxAttempts * passes.length) {
      const index = attempt;
      attempt += 1;

      const angleName = ANGLE_NAMES[hashText(`${seed}|angle|${index}`) % ANGLE_NAMES.length];
      const angled = applyAngle(spec, angleName, seed + index);
      if (!angled) continue;

      let candidate = angled;
      let mutationName = null;
      // Через раз — мутация поверх угла: комбинации «угол + мутация»
      // дают больше вариантов, чем голые углы.
      if (index % 2 === 1) {
        const name = MUTATION_NAMES[hashText(`${seed}|mutation|${index}`) % MUTATION_NAMES.length];
        const mutated = applyMutation(name, angled, seed + index);
        // Мутация не должна ломать валидность — иначе берём голый угол.
        if (mutated && checkSpec(mutated).ok) {
          candidate = mutated;
          mutationName = name;
        }
      }

      const checked = checkSpec(candidate);
      if (!checked.ok) continue;
      if (sameSpec(candidate, spec)) continue;

      const fingerprint = specFingerprint(candidate);
      // Одинаковый «скелет» (форма + прогрессия + рецепты) — это повтор
      // варианта, даже если отличается мотив или энергия.
      if (cores.has(fingerprint)) continue;
      if (specDistance(spec, candidate) < pass) continue;
      const tooClose = accepted.some((item) => specDistance(item.spec, candidate) < threshold);
      if (tooClose) continue;

      cores.add(fingerprint);
      accepted.push({
        spec: candidate,
        angle: angleName,
        mutation: mutationName,
        fingerprint,
        distance: specDistance(spec, candidate),
      });
    }
    if (accepted.length >= count) break;
  }

  return accepted;
}

/**
 * Кандидаты-спеки: массив вариантов, пригодных для показа пользователю.
 *
 * @param {object} spec исходная спека
 * @param {{count?: number, seed?: number, threshold?: number}} [options]
 * @returns {object[]} массив спек
 */
export function generateCandidates(spec, options = {}) {
  return generateCandidateDetails(spec, options).map((item) => item.spec);
}

/**
 * Выбор лучшего кандидата по внешней оценке.
 *
 * Оценка приходит снаружи (метрики другой фазы), поэтому здесь только
 * сортировка: null-оценка считается худшей.
 *
 * @param {object[]} candidates
 * @param {(spec: object, index: number) => number} score
 * @returns {object|null} лучший кандидат или null
 */
export function pickBest(candidates, score) {
  if (!candidates?.length) return null;
  let best = null;
  let bestScore = -Infinity;
  candidates.forEach((candidate, index) => {
    const value = Number(score(candidate, index));
    const current = Number.isFinite(value) ? value : -Infinity;
    if (current > bestScore) {
      bestScore = current;
      best = candidate;
    }
  });
  return best;
}
