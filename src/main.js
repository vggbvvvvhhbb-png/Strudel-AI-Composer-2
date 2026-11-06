import { initUI } from './ui.js';
import { initEngine } from './strudel-engine.js';
import { initHistory } from './history.js';
import { syncMixer } from './mixer.js';
import { syncTransport } from './transport.js';
import { applyMixerState } from './core/code-model.js';
import { codeFromHash } from './core/share.js';

initUI();
initEngine(document.getElementById('strudel-container'));

initHistory({
  load: ({ code, mixer }) => {
    const el = document.getElementById('code-input');
    el.value = applyMixerState(code, mixer);
    syncMixer(el.value);
    syncTransport(el.value);
  },
});

// Трек по ссылке (#c=…): загрузить в редактор БЕЗ автозапуска (политика автовоспроизведения).
const shared = codeFromHash();
if (shared) {
  const el = document.getElementById('code-input');
  el.value = shared;
  syncMixer(shared);
  const st = document.getElementById('status');
  st.hidden = false;
  st.textContent = '🔗 Загружен трек по ссылке — нажмите ▶, чтобы играть';
}
