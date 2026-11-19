// Страница изолированного офлайн-рендера (фикс E-020, D-143).
//
// Живёт в скрытом iframe ровно один рендер: родитель создаёт страницу,
// получает каналы и уничтожает iframe. Все глобальные удержания узлов
// superdough 1.3.0 (пулы эффектов, window.filterNode) умирают вместе с
// этим window — следующий рендер начинает с чистого листа.
//
// Движок и DSP — те же, что в студии: тот же чанк @strudel/web, тот же
// адаптер, те же банки и пресеты. Паспорт происхождения (engineVersion)
// совпадает с живым путём — инвариант D-104 проверяется зондом.

import { installRenderDeterminism } from './audio/render/seed.js';
import { strudelApi } from './audio/engine/strudel-api.js';
import { createEngineAdapter } from './audio/engine/adapter.js';
import { audioBufferToChannels } from './audio/render/offline.js';
import { SAMPLE_SETS } from './sample-banks.js';
import { allSamplesReady } from './samples-ready.js';
import { ensureTimbreForCode } from './timbre/register.js';
import { installJadeVisuals } from './pianoroll.js';

// Код треков несёт визуализации студии (._pianoroll() и др. — корпус,
// фикстуры). В realm рисовать некуда: регистрируем их как no-op, иначе
// исполнение кода упадёт «_pianoroll is not a function».
installJadeVisuals({ drawTarget: () => null });

const origin = window.location.origin;
const reply = (message, transfer = []) => window.parent.postMessage(message, origin, transfer);

// Общая политика E-022: PRNG и tracking каждой IR до init/evaluate.
// Этот window одноразовый; живая студия не устанавливает перехватов.
const determinism = installRenderDeterminism();

const adapter = createEngineAdapter(strudelApi);

// Готовность = движок поднят И все манифесты банков на месте (правило
// allSamplesReady: половина набора — неполный трек, рендерить его нельзя).
const boot = (async () => {
  await adapter.init(new AudioContext({ latencyHint: 'interactive' }));
  const results = await Promise.allSettled(SAMPLE_SETS.map((src) => strudelApi.samples(src)));
  if (!allSamplesReady(results)) {
    const failed = results.filter((r) => r.status === 'rejected');
    throw new Error(`Банки сэмплов недоступны: ${failed.map((f) => String(f.reason?.message || f.reason)).join('; ')}`);
  }
})();

boot.then(
  () => reply({ type: 'ready' }),
  (error) => reply({ type: 'error', message: String(error?.message || error) }),
);

window.addEventListener('message', async (event) => {
  if (event.source !== window.parent) return;
  const message = event.data;
  if (!message || message.type !== 'render') return;
  const { id } = message;
  try {
    await boot;
    // Пресеты Timbre (D-128): отказ прогрева — ошибка рендера, не подмена.
    // Каталог приходит от родителя (его кэш): свежий realm не ходит в /api
    // на каждый рендер — иначе глобальный лимитер ловит 429 на парах.
    if (String(message.code).includes('tp_')) {
      const timbre = await ensureTimbreForCode(message.code, adapter, message.timbre ?? null);
      if (!timbre.ok) {
        throw new Error(`Пресеты тембра не загрузились: ${timbre.errors.join('; ')}`);
      }
    }
    const buffer = await adapter.renderCodeOffline({
      code: message.code,
      fromCycle: message.fromCycle,
      toCycle: message.toCycle,
      sampleRate: message.sampleRate,
      cps: message.cps,
      prepare: determinism.prepare,
    });
    const channels = audioBufferToChannels(buffer).map((ch) => ch.buffer);
    reply({ type: 'result', id, sampleRate: buffer.sampleRate, channels }, channels);
  } catch (error) {
    reply({ type: 'error', id, message: String(error?.message || error) });
  }
});