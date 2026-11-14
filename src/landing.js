// Главная страница: примеры, переход в студию, тема.
// Страница лёгкая: без Strudel — генерация живёт в студии.
import './styles/tokens.css';
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

function initTheme() {
  const btn = $('theme-toggle');
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
