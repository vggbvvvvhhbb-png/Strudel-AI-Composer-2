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

import { createSeededRandom, RENDER_SEED } from './audio/render/seed.js';
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

// IR реверберации и детюн бочки superdough берут из Math.random (E-022):
// фиксируем зерно до первого рендера — все realm дают идентичный звук.
// Живая страница не трогается: подмена действует только в этом window.
Math.random = createSeededRandom(RENDER_SEED);

// superdough применяет IR к конвольверу АСИНХРОННО (generateReverb →
// OfflineAudioContext-свип → oncomplete → convolver.buffer). Без ожидания
// startRendering стартует с пустым конвольвером — звук зависит от тайминга
// макрозадач (замерено: maxAbsDiff ~0.03 между realm). ВАЖНО: createReverb
// сам вызывает generate в конце — первый generate нужно отслеживать сразу
// после создания узла, а не только через обёртку node.generate.
const reverbNodes = new Set();
const origCreateReverb = BaseAudioContext.prototype.createReverb;
BaseAudioContext.prototype.createReverb = function createReverbTracked(...args) {
  const node = origCreateReverb.apply(this, args);
  reverbNodes.add(node);
  const watchIR = () => {
    node.__irPending = true;
    const watch = setInterval(() => {
      if (node.buffer) {
        node.__irPending = false;
        clearInterval(watch);
      }
    }, 5);
  };
  // generate уже отработал внутри createReverb: буфер ещё не пришёл — ждём.
  if (!node.buffer) watchIR();
  const origGenerate = node.generate;
  node.generate = function generateTracked(...gargs) {
    const result = origGenerate.apply(node, gargs);
    if (!node.buffer) watchIR();
    return result;
  };
  return node;
};

async function waitForReverbIR(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while ([...reverbNodes].some((node) => node.__irPending)) {
    if (Date.now() > deadline) {
      throw new Error(`IR реверберации не сгенерировалась за ${timeoutMs} мс — рендер недостоверен`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

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
      prepare: waitForReverbIR,
    });
    const channels = audioBufferToChannels(buffer).map((ch) => ch.buffer);
    reply({ type: 'result', id, sampleRate: buffer.sampleRate, channels }, channels);
  } catch (error) {
    reply({ type: 'error', id, message: String(error?.message || error) });
  }
});