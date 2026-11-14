// Этап 5: рендер двойника.
//
// Рендерим не только микс, но и каждый слой отдельно: иначе сравнение
// «слой против слоя» нечестно — в миксе слышно всё сразу.
//
// Рендеры строго последовательные: движок переключает глобальный аудиоконтекст,
// параллельные рендеры мешают друг другу и дают недетерминированный звук.

import { compileTrackSpec } from '../../music/compiler/index.js';
import { enqueueRender, getRenderWorker } from '../render/pool.js';
import { subsetSpec } from './helpers.js';
import { DRUM_ROLES, ROLE_TO_LAYER } from './constants.js';

/**
 * @param {object} params
 * @param {object} params.spec план двойника (TrackSpec)
 * @param {string} params.code Strudel-код двойника
 * @param {number} params.totalBars сколько тактов рендерить
 * @param {number} params.bpm темп двойника
 * @param {Function|null} params.renderFn подмена рендера (в тестах — заглушка)
 * @param {Array} params.errors список деградаций
 * @returns {Promise<{mixRender: object|null, layerRenders: object, renderFingerprints: object}>}
 */
export async function renderStage({ spec, code, totalBars, bpm, renderFn, errors }) {
  const cps = bpm / 240; // циклы в секунду: один цикл = один такт
  let mixRender = null;
  const layerRenders = {};
  const renderFingerprints = {};

  try {
    // В тестах рендер подменяется: браузер в CI не поднять.
    const renderMix = renderFn ?? (async (renderCode) => {
      const worker = await getRenderWorker();
      return enqueueRender(() => worker.render({
        code: renderCode,
        fromCycle: 0,
        toCycle: totalBars,
        cps,
        wantWav: true,
        wantEvents: false,
      }));
    });

    mixRender = await renderMix(code);
    renderFingerprints.mix = mixRender.fingerprint;

    // Слои — отдельно, иначе сравнение «слой против слоя» нечестно.
    const groups = { drums: DRUM_ROLES };
    for (const [role, layer] of Object.entries(ROLE_TO_LAYER)) groups[layer] = [...(groups[layer] ?? []), role];
    for (const [layer, roles] of Object.entries(groups)) {
      const present = roles.filter((role) => spec.parts.roles[role]);
      if (!present.length) continue;
      const layerCode = compileTrackSpec(subsetSpec(spec, present));
      const rendered = await renderMix(layerCode);
      layerRenders[layer] = rendered;
      renderFingerprints[layer] = rendered.fingerprint;
    }
  } catch (err) {
    errors.push({ stage: 'render', message: `Рендер двойника не удался: ${err.message}` });
  }

  return { mixRender, layerRenders, renderFingerprints };
}
