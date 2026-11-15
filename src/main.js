import './styles/tokens.css';
import './styles/layout.css';
import './styles/components.css';
import './styles/compose.css';
import './styles/animations.css';
import './styles/steps.css';
import './styles/agent.css';
import { initEditor } from './editor.js';
import { initUI } from './ui.js';
import { initCompose } from './compose.js';
import { getEngine } from './engine-loader.js';
import { initHistory } from './history.js';
import { syncMixer } from './mixer.js';
import { syncTransport } from './transport.js';
import { initLive } from './live.js';
import { initVoice } from './voice.js';
import { applyMixerState } from './core/code-model.js';
import { codeFromHash } from './core/share.js';
import { initDeepDive } from './deepdive/panel.js';
import { initStudioSteps } from './studio-steps.js';
import { initAgentPanel } from './agent-panel.js';

const editor = initEditor();

initUI({ editor });
// Движок (725 КБ) грузится динамически: оболочка студии рисуется сразу,
// а звуковой движок приезжает следом и к моменту, когда до него дотянется
// пользователь, уже готов. Ошибка загрузки — в лог, а не в консоль молча.
getEngine()
  .then((engine) => engine.initEngine(document.getElementById('strudel-container')))
  .catch((err) => {
    console.error('[engine] не загрузился:', err);
  });
initLive({ editor });
initVoice();
initDeepDive();
// Шаги студии («Опишите → Слушайте → Правьте») — после разбора,
// чтобы флаг ?dive=1 уже был разобран и шапка шагов знала про режим.
initStudioSteps();

// Помощник-агент: план, вызовы инструментов и ответ — раздельно.
// Код, который агент собрал, попадает в редактор только по кнопке.
initAgentPanel({
  getCode: () => document.getElementById('code-input')?.value ?? '',
  setCode: (code) => {
    const el = document.getElementById('code-input');
    if (!el) return;
    el.value = code;
    syncMixer(code);
    syncTransport(code);
  },
});

// Мобильная шторка микшера
document.getElementById('mixer-toggle')?.addEventListener('click', () => {
  document.querySelector('.col-right')?.classList.toggle('open');
});

initHistory({
  // Пресет сохраняется из текущего кода в редакторе.
  getCode: () => document.getElementById('code-input').value,
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
