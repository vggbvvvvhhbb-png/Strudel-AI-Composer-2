// Связь живых метров с интерфейсом: VU и подсветка каналов микшера, «живые» блоки
// визуализаций и подсветка партии, которая звучит прямо сейчас, в редакторе.
import { subscribeLevels, activeLabels } from './meters.js';

const LIVE_THRESHOLD = 0.12;

export function initLive({ editor } = {}) {
  return subscribeLevels((levels) => {
    // Каналы микшера: уровень + подсветка звучащей партии.
    for (const el of document.querySelectorAll('.mixer .channel')) {
      const level = levels.get(el.dataset.label) ?? 0;
      el.style.setProperty('--level', level.toFixed(3));
      el.classList.toggle('live', level >= LIVE_THRESHOLD);
    }

    // Блоки визуализаций: партия светится, когда играет.
    for (const el of document.querySelectorAll('.part-block')) {
      const level = levels.get(el.dataset.label) ?? 0;
      el.classList.toggle('live', level >= LIVE_THRESHOLD);
    }

    // Редактор: строки активной партии подсвечиваются нефритовым фоном.
    editor?.setActiveParts(activeLabels());
  });
}
