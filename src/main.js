import './styles.css';
import { initEngine } from './strudel-engine.js';
import { initUI } from './ui.js';

// Инициализация Strudel — один раз при загрузке страницы.
initUI();
initEngine(document.getElementById('strudel-container'))
  .then(() => window.dispatchEvent(new CustomEvent('strudel:ready')))
  .catch((err) => window.dispatchEvent(new CustomEvent('strudel:error', { detail: err })));
