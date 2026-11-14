// Шаги студии: «Опишите → Слушайте → Правьте».
//
// Модуль ничего не генерирует и не ходит в API: генерацию запускает
// существующая кнопка #btn-run. Здесь только переключение шага
// (data-step на <body>), подстановка примеров в #prompt-input и реакция
// на событие studio:track-ready, которое шлёт ui.js после успешного
// исполнения сгенерированного кода.

const $ = (id) => document.getElementById(id);

// Движки возвращают кнопкам служебные подписи («▶ Сгенерировать»,
// «✨ Улучшить по разбору»). Пользователю показываем понятные —
// но только те, что движок сам ставит, чтобы не затирать «⏳ …» в работе.
const FRIENDLY_LABELS = {
  'btn-run': { from: '▶ Сгенерировать', to: '✨ Создать трек' },
  'btn-improve': { from: '✨ Улучшить', to: 'Попросить правку' },
  'btn-analyze': { from: '🎼 Разобрать', to: '🎼 Разобрать трек' },
  'btn-refine': { from: '✨ Улучшить по разбору', to: '🛠 Исправить по замечаниям' },
  'btn-variants': { from: '🎲 Варианты A/B', to: '🎲 Сравнить два варианта' },
};

export function initStudioSteps() {
  const body = document.body;
  const nav = $('studio-steps');
  const buttons = nav ? Array.from(nav.querySelectorAll('[data-step-btn]')) : [];
  const main = document.querySelector('main.app-grid');

  /** Текущий шаг: 1 — описать, 2 — слушать, 3 — править. */
  function setStep(step) {
    const next = String(step);
    body.dataset.step = next;
    for (const btn of buttons) {
      const active = btn.dataset.stepBtn === next;
      btn.classList.toggle('is-active', active);
      if (active) btn.setAttribute('aria-current', 'step');
      else btn.removeAttribute('aria-current');
    }
  }

  // --- Шапка шагов ---
  for (const btn of buttons) {
    btn.addEventListener('click', () => setStep(btn.dataset.stepBtn));
  }

  // «Показать код» из шага 2 открывает шаг 3.
  $('btn-show-code')?.addEventListener('click', () => setStep(3));

  // Кнопка «▶ Играть» на шаге 3 — та же команда, что и на шаге 2.
  $('btn-play-code-3')?.addEventListener('click', () => $('btn-play-code')?.click());

  // --- Примеры: подставляют текст, но не запускают генерацию ---
  $('example-chips')?.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-prompt]');
    if (!chip) return;
    const input = $('prompt-input');
    if (!input) return;
    input.value = chip.dataset.prompt || '';
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });

  // --- Трек готов: переходим на шаг «Слушайте» ---
  window.addEventListener('studio:track-ready', () => {
    if (isDive()) return; // в режиме разбора студия не главная
    setStep(2);
  });

  // --- Понятные подписи кнопок ---
  for (const [id, spec] of Object.entries(FRIENDLY_LABELS)) {
    watchLabel(id, spec);
  }

  // --- Режим «Разбор» (?dive=1): шапка шагов не нужна ---
  syncDive();
  if (main && typeof MutationObserver !== 'undefined') {
    new MutationObserver(syncDive).observe(main, {
      attributes: true,
      attributeFilter: ['data-view'],
    });
  }

  // --- ?prompt=текст&autogen=1 ---
  const params = new URLSearchParams(window.location.search);
  const prompt = (params.get('prompt') || '').trim();
  if (prompt) {
    const input = $('prompt-input');
    if (input) input.value = prompt;
    if (params.get('autogen') === '1') {
      // Генерацию запускает штатная кнопка — модуль сам в API не ходит.
      setTimeout(() => $('btn-run')?.click(), 0);
    }
  }

  setStep(body.dataset.step || '1');

  /** Режим разбора активен (вкладка «Разбор»). */
  function isDive() {
    return main?.dataset.view === 'dive';
  }

  /** Шапку шагов прячем, когда открыт разбор. */
  function syncDive() {
    if (!nav) return;
    nav.hidden = isDive();
  }
}

/**
 * Следить за подписью кнопки: движок после работы возвращает служебный
 * текст — возвращаем понятный.
 */
function watchLabel(id, spec) {
  const el = $(id);
  if (!el) return;
  const fix = () => {
    if (el.textContent.trim() === spec.from) el.textContent = spec.to;
  };
  fix();
  if (typeof MutationObserver === 'undefined') return;
  new MutationObserver(fix).observe(el, {
    childList: true,
    characterData: true,
    subtree: true,
  });
}
