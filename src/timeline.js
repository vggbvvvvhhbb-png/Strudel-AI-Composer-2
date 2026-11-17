// Таймлайн дорожек — главный экран студии (фаза F).
//
// Дорожки видны сразу, не за кликом: строки сгруппированы по семьям
// (strings, brass, drums…), у каждой — цвет, роль, mute/solo и громкость.
// Правки применяются к коду в редакторе тем же механизмом, что и микшер
// (src/core/code-model.js), поэтому пресет и шеринг сохраняют состояние.
//
// 100 дорожек — рабочий режим, не витрина: строки компактные, группы
// сворачиваются, перестроение только при смене состава партий.

import { getEngine } from './engine-loader.js';
import { parseParts, setPartMuted, setPartSolo, unsoloAll, setPartGain, getPartGain, getPartSound } from './core/code-model.js';
import { staticValidate } from './core/validator.js';
import { groupOf } from './music/expand.js';
import { log } from './ui.js';

const $ = (id) => document.getElementById(id);

// Порядок семей на экране: ритм-секция снизу по смыслу, но сверху по важности
// для бита; оркестр идёт следом. Неизвестная роль — в «other».
const GROUP_ORDER = [
  'drums', 'bass', 'lead', 'arp', 'chords',
  'strings', 'brass', 'woodwinds', 'keys', 'choir',
  'pads', 'fx', 'other',
];

const GROUP_LABELS = {
  drums: 'Ударные', bass: 'Бас', lead: 'Лид', arp: 'Арпеджио', chords: 'Аккорды',
  strings: 'Струнные', brass: 'Медные', woodwinds: 'Деревянные', keys: 'Клавишные',
  choir: 'Хор', pads: 'Пэды', fx: 'Эффекты', other: 'Прочее',
};

// signature начинается с null, не с '': пустой код тоже даёт '', и иначе
// первый sync пропустил бы отрисовку пустого состояния (демо-оперы).
const state = { solo: null, soloBackup: [], applyTimer: null, signature: null, sections: [] };

const hooks = { getCode: () => '', setCode: () => {} };
const currentCode = () => hooks.getCode();
const setEditorCode = (code) => hooks.setCode(code);

function applyLive(code) {
  clearTimeout(state.applyTimer);
  state.applyTimer = setTimeout(async () => {
    if (!staticValidate(code).ok) return;
    const { evaluateCode } = await getEngine();
    const res = await evaluateCode(code);
    if (!res.ok) log(`Ошибка после правки таймлайна: ${res.error}`, 'error');
  }, 250);
}

// Роль из комментария компилятора: `$VIOLIN_1: … // role=violin`.
// Без комментария роль выводится из метки (легаси-код: $BASS: → bass).
function roleOf(part, code) {
  const line = code.split('\n')[part.startLine] ?? '';
  const m = line.match(/\/\/\s*role=([a-z][a-z0-9_]*)/);
  if (m) return m[1];
  return String(part.label || '').toLowerCase().replace(/_\d+$/, '') || 'other';
}

// Стиль из шапки компилятора: `// lo-fi — 84 BPM, …`. Нужен резолверу
// тембра (аффинитет семейства к стилю); у свободного кода стиля нет.
function styleOf(code) {
  const m = code.match(/^\/\/\s*([a-z][a-z-]*)\s+—\s+\d+\s+BPM/m);
  return m ? m[1] : null;
}

function mutate(code) {
  setEditorCode(code);
  applyLive(code);
  syncTimeline(code);
}

function toggleSolo(label) {
  if (state.solo === label) {
    const next = unsoloAll(currentCode(), state.soloBackup);
    state.solo = null;
    state.soloBackup = [];
    mutate(next);
    return;
  }
  const { code, previous } = setPartSolo(currentCode(), label);
  state.solo = label;
  state.soloBackup = previous;
  mutate(code);
}

function trackRow(part, role) {
  const row = document.createElement('div');
  row.className = 'tl-row';
  row.dataset.label = part.label;
  row.classList.toggle('is-muted', Boolean(part.muted));

  const name = document.createElement('span');
  name.className = 'tl-name';
  name.textContent = part.label || '$';
  name.title = `${part.label} · роль ${role}`;

  const roleTag = document.createElement('span');
  roleTag.className = 'tl-role';
  roleTag.textContent = role;

  // Чип звука (этап 4, D-131): открывает панель выбора инструмента.
  // У партий с groups (ударные) заменяемого .s() нет — чипа нет.
  const sound = getPartSound(currentCode(), part.label);
  let soundBtn = null;
  if (sound) {
    soundBtn = document.createElement('button');
    soundBtn.type = 'button';
    soundBtn.className = 'tl-sound';
    soundBtn.textContent = sound;
    soundBtn.title = `Звук партии ${part.label}: ${sound} — нажмите, чтобы выбрать инструмент`;
    soundBtn.addEventListener('click', async () => {
      const { openTimbrePicker } = await import('./timbre/picker.js');
      openTimbrePicker({
        label: part.label,
        role,
        family: groupOf(role),
        style: styleOf(currentCode()),
        getCode: currentCode,
        applyCode: mutate,
      });
    });
  }

  const muteBtn = document.createElement('button');
  muteBtn.type = 'button';
  muteBtn.className = 'tl-chip';
  muteBtn.textContent = 'M';
  muteBtn.title = `Заглушить ${part.label}`;
  muteBtn.setAttribute('aria-pressed', String(Boolean(part.muted)));
  muteBtn.addEventListener('click', () => {
    const nowMuted = !part.muted;
    if (state.solo && !nowMuted) return;
    mutate(setPartMuted(currentCode(), part.label, nowMuted));
  });

  const soloBtn = document.createElement('button');
  soloBtn.type = 'button';
  soloBtn.className = 'tl-chip';
  soloBtn.textContent = 'S';
  soloBtn.title = `Соло ${part.label}`;
  soloBtn.setAttribute('aria-pressed', String(state.solo === part.label));
  soloBtn.addEventListener('click', () => toggleSolo(part.label));

  const fader = document.createElement('input');
  fader.type = 'range';
  fader.min = '0';
  fader.max = '1';
  fader.step = '0.01';
  fader.className = 'tl-fader';
  fader.value = String(getPartGain(currentCode(), part.label) ?? 0.8);
  fader.setAttribute('aria-label', `Громкость ${part.label}`);
  fader.addEventListener('input', () => {
    mutate(setPartGain(currentCode(), part.label, Number(fader.value)));
  });

  row.append(name, roleTag, ...(soundBtn ? [soundBtn] : []), muteBtn, soloBtn, fader);
  return row;
}

function groupBlock(group, entries, code) {
  const details = document.createElement('details');
  details.className = `tl-group tl-group-${group}`;
  details.open = true;
  details.dataset.group = group;

  const summary = document.createElement('summary');
  summary.className = 'tl-group-head';

  const title = document.createElement('span');
  title.className = 'tl-group-title';
  title.textContent = GROUP_LABELS[group] ?? group;

  const count = document.createElement('span');
  count.className = 'tl-group-count';
  count.textContent = String(entries.length);

  // Mute/solo всей группы: те же операции code-model, что и у дорожки,
  // только по списку меток семьи.
  const labels = entries.map(({ part }) => part.label);
  const groupMute = document.createElement('button');
  groupMute.type = 'button';
  groupMute.className = 'tl-chip';
  groupMute.textContent = 'M';
  groupMute.title = `Заглушить группу «${GROUP_LABELS[group] ?? group}»`;
  groupMute.addEventListener('click', (event) => {
    event.preventDefault();
    const anyAudible = entries.some(({ part }) => !part.muted);
    let next = currentCode();
    for (const label of labels) next = setPartMuted(next, label, anyAudible);
    mutate(next);
  });

  const groupSolo = document.createElement('button');
  groupSolo.type = 'button';
  groupSolo.className = 'tl-chip';
  groupSolo.textContent = 'S';
  groupSolo.title = `Соло группы «${GROUP_LABELS[group] ?? group}»`;
  groupSolo.addEventListener('click', (event) => {
    event.preventDefault();
    const parts = parseParts(currentCode());
    const alreadySolo = labels.every((label) => !parts.find((p) => p.label === label)?.muted)
      && parts.some((p) => !labels.includes(p.label) && p.muted);
    let next = currentCode();
    if (alreadySolo) {
      for (const p of parts) next = setPartMuted(next, p.label, false);
      state.solo = null;
      state.soloBackup = [];
    } else {
      for (const p of parts) next = setPartMuted(next, p.label, !labels.includes(p.label));
      state.solo = null;
      state.soloBackup = [];
    }
    mutate(next);
  });

  summary.append(title, count, groupMute, groupSolo);
  details.appendChild(summary);

  const rows = document.createElement('div');
  rows.className = 'tl-rows';
  for (const { part, role } of entries) rows.appendChild(trackRow(part, role));
  details.appendChild(rows);
  return details;
}

function sectionsStrip() {
  const strip = document.createElement('div');
  strip.className = 'tl-sections';
  if (!state.sections.length) {
    const span = document.createElement('span');
    span.className = 'tl-section tl-section-free';
    span.textContent = 'свободный цикл';
    strip.appendChild(span);
    return strip;
  }
  const total = state.sections.reduce((sum, s) => sum + (Number(s.bars) || 0), 0) || 1;
  for (const section of state.sections) {
    const span = document.createElement('span');
    span.className = 'tl-section';
    span.style.flexGrow = String(Math.max(1, Number(section.bars) || 1));
    span.textContent = `${section.name} · ${section.bars} т.`;
    span.title = `Секция ${section.name}: ${section.bars} тактов${section.harmony ? `, гармония ${section.harmony}` : ''}`;
    strip.appendChild(span);
  }
  strip.title = `Всего тактов: ${total}`;
  return strip;
}

function emptyState() {
  const box = document.createElement('div');
  box.className = 'tl-empty';
  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = 'Дорожки появятся после генерации. Можно начать с демо-оперы — 66 дорожек, детерминированная экспансия плана.';
  const demoBtn = document.createElement('button');
  demoBtn.type = 'button';
  demoBtn.className = 'btn';
  demoBtn.id = 'tl-demo-opera';
  demoBtn.textContent = '🎻 Загрузить демо-оперу (66 дорожек)';
  demoBtn.addEventListener('click', loadOperaDemo);
  box.append(hint, demoBtn);
  return box;
}

// Демо-опера собирается тем же кодом, что и серверный демо-скрипт
// (scripts/build-opera-demo.mjs): план → экспансия → компиляция.
// Модули маленькие (~15 КБ) и грузятся динамически — в первый экран не входят.
async function loadOperaDemo() {
  const btn = $('tl-demo-opera');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Собираем оркестр…'; }
  try {
    const [{ specFromPlan }, { compileTrackSpec }, { validateTrackSpec }] = await Promise.all([
      import('./music/expand.js'),
      import('../server/music/compiler/index.js'),
      import('./schemas/track-spec.schema.js'),
    ]);
    const plan = {
      style: 'cinematic',
      key: 'Cmin',
      bpm: 90,
      sections: [
        { name: 'intro', bars: 8, energy: 0.35, harmony: 'Cm' },
        { name: 'verse', bars: 8, energy: 0.55, harmony: 'Cm Ab' },
        { name: 'drop', bars: 16, energy: 0.9, harmony: 'Cm Gm Ab Bb' },
      ],
      groups: [
        { group: 'strings', role: 'violin', count: 10 },
        { group: 'strings', role: 'viola', count: 4 },
        { group: 'strings', role: 'cello', count: 4 },
        { group: 'brass', role: 'horn', count: 4 },
        { group: 'brass', role: 'trumpet', count: 2 },
        { group: 'woodwinds', role: 'flute', count: 4 },
        { group: 'woodwinds', role: 'clarinet', count: 2 },
        { group: 'keys', role: 'piano', count: 4 },
        { group: 'keys', role: 'harp', count: 2 },
        { group: 'choir', role: 'choir_soprano', count: 4 },
        { group: 'choir', role: 'choir_bass', count: 2 },
        { group: 'choir', role: 'choir_alto', count: 4 },
        { group: 'pads', role: 'pad', count: 4 },
        { group: 'bass', role: 'bass', count: 2 },
        { group: 'perc', role: 'perc', count: 8 },
        { group: 'drums', role: 'kick', count: 1 },
        { group: 'drums', role: 'hats', count: 1 },
        { group: 'lead', role: 'lead', count: 2 },
        { group: 'fx', role: 'fx', count: 2 },
      ],
    };
    const { spec: rawSpec } = specFromPlan(plan);
    const spec = validateTrackSpec(rawSpec);
    const code = compileTrackSpec(spec);
    setEditorCode(code);
    state.sections = plan.sections;
    syncTimeline(code);
    const { unlockAudio, evaluateCode } = await getEngine();
    await unlockAudio();
    const res = await evaluateCode(code);
    if (res.ok) {
      log('Демо-опера загружена и играет — 66 дорожек', 'ok');
      window.dispatchEvent(new CustomEvent('studio:track-ready'));
    } else {
      log(`Демо-опера загружена, но не заиграла: ${res.error}`, 'error');
    }
  } catch (err) {
    log(`Демо-опера не собралась: ${err?.message || err}`, 'error');
    if (btn) { btn.disabled = false; btn.textContent = '🎻 Загрузить демо-оперу (66 дорожек)'; }
  }
}

export function initTimeline({ getCode, setCode }) {
  hooks.getCode = getCode;
  hooks.setCode = setCode;
  // Секции приходят от структурной композиции: таймлайн показывает форму.
  window.addEventListener('compose:sections', (event) => {
    state.sections = Array.isArray(event.detail) ? event.detail : [];
    const strip = document.querySelector('#track-timeline .tl-sections');
    if (strip) strip.replaceWith(sectionsStrip());
  });
  syncTimeline(getCode());
}

export function syncTimeline(code) {
  const box = $('track-timeline');
  if (!box) return;
  const parts = parseParts(code);

  // Подпись состава не меняется — обновляем только состояния кнопок.
  const signature = parts.map((p) => p.label).join('|');
  if (signature === state.signature) {
    box.querySelectorAll('.tl-row').forEach((row) => {
      const part = parts.find((p) => p.label === row.dataset.label);
      if (!part) return;
      row.classList.toggle('is-muted', Boolean(part.muted));
      const chips = row.querySelectorAll('.tl-chip');
      chips[0]?.setAttribute('aria-pressed', String(Boolean(part.muted)));
      chips[1]?.setAttribute('aria-pressed', String(state.solo === part.label));
      // Смена инструмента не меняет состав партий: чип звука обновляется
      // здесь, иначе панель применила бы пресет, а строка показывала старый.
      const soundBtn = row.querySelector('.tl-sound');
      if (soundBtn) {
        const sound = getPartSound(code, part.label);
        soundBtn.textContent = sound ?? '—';
        soundBtn.title = `Звук партии ${part.label}: ${sound ?? '—'} — нажмите, чтобы выбрать инструмент`;
      }
    });
    return;
  }
  state.signature = signature;
  state.solo = null;
  state.soloBackup = [];

  const head = document.createElement('div');
  head.className = 'tl-head';
  const title = document.createElement('span');
  title.className = 'tl-title';
  title.textContent = '◆ Таймлайн дорожек';
  const count = document.createElement('span');
  count.className = 'tl-count';
  count.textContent = parts.length ? `${parts.length} дорожек` : '';
  head.append(title, count, sectionsStrip());

  if (!parts.length) {
    box.replaceChildren(head, emptyState());
    return;
  }

  const byGroup = new Map();
  for (const part of parts) {
    const role = roleOf(part, code);
    const mapped = groupOf(role);
    const group = GROUP_ORDER.includes(mapped) ? mapped : 'other';
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group).push({ part, role });
  }
  const groups = [...byGroup.keys()].sort(
    (a, b) => GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b),
  );
  const body = document.createElement('div');
  body.className = 'tl-body';
  for (const group of groups) body.appendChild(groupBlock(group, byGroup.get(group), code));
  box.replaceChildren(head, body);
}