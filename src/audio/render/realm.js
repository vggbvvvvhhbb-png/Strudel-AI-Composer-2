// Изоляция офлайн-рендера в свежем realm (фикс E-020 / D-133 → D-143).
//
// ЗАЧЕМ. superdough 1.3.0 пулит узлы эффектов глобально и переиспользует их
// без проверки контекста: быстрые последовательные офлайн-рендеры в одной
// странице ловят InvalidAccessError «different audio context» (E-020).
// Дренаж пула и паузы не помогают (проверено, откачено — D-133). Структурный
// фикс: каждый рендер живёт в собственном iframe-realm (/render-realm.html),
// который уничтожается после рендера — все глобальные удержания узлов
// умирают вместе с ним. Живой контекст студии рендер больше не трогает.
//
// КОНТРАКТ. Менеджер не знает про DOM: spawnRealm — инъекция (в браузере
// iframe, в тестах — фейк). Один realm на рендер, вызовы сериализуются.
// Протокол сообщений:
//   realm → родитель: {type:'ready'} | {type:'result', id, sampleRate,
//                      channels: ArrayBuffer[]} | {type:'error', id?, message}
//   родитель → realm: {type:'render', id, code, fromCycle, toCycle,
//                      sampleRate, cps, timbre?: {sampleMap, presets}}

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_RENDER_TIMEOUT_MS = 180_000;

/**
 * Realm в скрытом iframe того же origin. Страница /render-realm.html грузит
 * тот же чанк движка (браузерный кэш), но её window — отдельный: глобальные
 * пулы superdough не пересекаются с родительской страницей.
 */
function spawnIframeRealm(url = '/render-realm.html') {
  const iframe = document.createElement('iframe');
  iframe.src = url;
  iframe.style.display = 'none';
  iframe.setAttribute('aria-hidden', 'true');
  iframe.title = 'Изолированный рендер';
  document.body.appendChild(iframe);
  const listeners = new Set();
  const onMessage = (event) => {
    if (event.source !== iframe.contentWindow) return;
    for (const listener of listeners) listener(event.data);
  };
  window.addEventListener('message', onMessage);
  return {
    post(message) {
      iframe.contentWindow?.postMessage(message, window.location.origin);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      window.removeEventListener('message', onMessage);
      iframe.remove();
    },
  };
}

/**
 * @param {object} [options]
 * @param {Function} [options.spawnRealm] фабрика realm (тестовая инъекция)
 * @param {number} [options.readyTimeoutMs] ожидание готовности realm
 * @param {number} [options.renderTimeoutMs] ожидание результата рендера
 */
export function createRealmRenderer({
  spawnRealm = spawnIframeRealm,
  readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
  renderTimeoutMs = DEFAULT_RENDER_TIMEOUT_MS,
} = {}) {
  let queue = Promise.resolve();
  let nextId = 0;

  function renderOnce({ code, fromCycle = 0, toCycle = 16, sampleRate = 48000, cps = 0.5, timbre = null }) {
    return new Promise((resolve, reject) => {
      const id = `r${++nextId}`;
      let realm;
      let unsubscribe = () => {};
      let timer = null;
      let settled = false;

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        try {
          realm?.destroy();
        } catch {
          /* realm мог не создаться */
        }
        fn(value);
      };

      const armTimer = (ms, label) => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          finish(reject, new Error(`Рендер-realm: ${label} (таймаут ${ms} мс)`));
        }, ms);
      };

      try {
        realm = spawnRealm();
      } catch (error) {
        finish(reject, error);
        return;
      }

      unsubscribe = realm.subscribe((message) => {
        if (!message || typeof message !== 'object') return;
        if (message.type === 'ready') {
          armTimer(renderTimeoutMs, 'рендер не завершился');
          realm.post({ type: 'render', id, code, fromCycle, toCycle, sampleRate, cps, timbre });
          return;
        }
        if (message.type === 'error' && (message.id === id || message.id == null)) {
          finish(reject, new Error(`Рендер-realm: ${message.message ?? 'неизвестная ошибка'}`));
          return;
        }
        if (message.type === 'result' && message.id === id) {
          const channels = (message.channels ?? []).map((buf) => new Float64Array(buf));
          finish(resolve, { channels, sampleRate: message.sampleRate ?? sampleRate });
        }
      });

      armTimer(readyTimeoutMs, 'realm не поднялся');
    });
  }

  return {
    /** Один рендер в свежем realm. Вызовы сериализуются очередью. */
    render(args) {
      const run = queue.then(() => renderOnce(args));
      // Очередь не должна ломаться от отказа одного рендера.
      queue = run.catch(() => {});
      return run;
    },
  };
}