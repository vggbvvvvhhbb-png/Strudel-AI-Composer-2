// Главная страница: примеры, переход в студию, тема.
// Страница лёгкая: без Strudel — генерация живёт в студии.
import './styles/tokens.css';
// components.css — обязателен: без него `.btn.primary` (главная кнопка
// обложки) не существует в бандле обложки, и кнопка выглядит серой
// кнопкой без оформления. Импорт до landing.css, чтобы общие правила
// уступали правилам обложки при равной специфичности.
import './styles/components.css';
import './styles/landing.css';

const $ = (id) => document.getElementById(id);

function initExamples() {
  const input = $('hero-input');
  const chips = $('hero-chips');
  if (!input || !chips) return;
  chips.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-prompt]');
    if (!btn) return;
    input.value = btn.dataset.prompt || '';
    input.focus();
    // Фокус в конец текста, чтобы дописывать было удобно.
    input.setSelectionRange(input.value.length, input.value.length);
  });
}

function initForm() {
  const form = $('hero-form');
  const input = $('hero-input');
  if (!form || !input) return;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const prompt = input.value.trim();
    if (!prompt) {
      input.focus();
      input.placeholder = 'Опишите трек словами — например: «тёмный ло-фай, 88 BPM»';
      return;
    }
    const target = `/studio.html?autogen=1&prompt=${encodeURIComponent(prompt)}`;
    window.location.href = target;
  });
  // Ctrl+Enter — отправить, как в студии.
  input.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      form.requestSubmit();
    }
  });
}

// Предрассчитанное демо: 4 секунды, тот же движок, что в студии.
// Файл собирает scripts/build-demo.mjs из demo/preview.js — лежит в public/,
// поэтому обложка не грузит движок и не ждёт сеть: звук начинается сразу.
const DEMO_URL = 'demo/preview.wav';

function initDemo() {
  const btn = $('hero-demo');
  const label = $('hero-demo-label');
  const bar = $('hero-demo-fill');
  if (!btn) return;

  const audio = new Audio();
  audio.preload = 'auto';
  audio.src = DEMO_URL;

  const setLabel = (text) => {
    if (label) label.textContent = text;
  };

  const paint = () => {
    if (!bar) return;
    const ratio = audio.duration ? audio.currentTime / audio.duration : 0;
    bar.style.width = `${Math.min(100, Math.max(0, ratio * 100)).toFixed(1)}%`;
  };

  btn.addEventListener('click', async () => {
    if (!audio.paused) {
      audio.pause();
      setLabel('▶ Демо — 4 секунды');
      return;
    }
    try {
      await audio.play();
      setLabel('⏸ Стоп');
    } catch (err) {
      // Честная деградация: если файл не отдался — говорим об этом, а не
      // делаем вид, что звук играет.
      setLabel('⚠ Демо недоступно');
      console.error('[demo] не проигрался:', err);
    }
  });

  audio.addEventListener('timeupdate', paint);
  audio.addEventListener('ended', () => {
    setLabel('▶ Демо — 4 секунды');
    paint();
  });
  audio.addEventListener('error', () => {
    setLabel('⚠ Демо недоступно');
  });
}

function initTheme() {  const btn = $('theme-toggle');
  const THEMES = [
    { id: 'jade', label: 'Jade' },
    { id: 'obsidian', label: 'Obsidian' },
  ];
  const applyTheme = (id) => {
    const theme = THEMES.find((t) => t.id === id) || THEMES[0];
    document.documentElement.classList.remove('theme-jade', 'theme-obsidian');
    document.documentElement.classList.add(`theme-${theme.id}`);
    document.documentElement.dataset.theme = theme.id;
    if (btn) {
      btn.textContent = `◐ ${theme.label}`;
      btn.title = `Тема: ${theme.label} — переключить`;
    }
  };
  applyTheme(localStorage.getItem('strudel.theme') || 'jade');
  btn?.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'obsidian' ? 'jade' : 'obsidian';
    applyTheme(next);
    localStorage.setItem('strudel.theme', next);
  });
}

initExamples();
initForm();
initTheme();
initDemo();
