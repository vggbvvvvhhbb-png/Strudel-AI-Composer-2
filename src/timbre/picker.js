// Панель выбора инструмента на партии (этап 4, D-131).
//
// Открывается с чипа звука в таймлайне. Два взгляда на каталог:
//   • подбор резолвера (server/samples/timbre-resolver.js): 3–5 кандидатов
//     с числовым обоснованием — какие фильтры и измерения сработали;
//   • каталог: фильтр по метаданным (семейство, роль, теги, профиль).
// Карточка пресета — по образцу карточки пула (D-121): имя, лицензия,
// строка паспорта, превью preload=none.
//
// Правка применяется двумя путями (D-131):
//   • партия есть в последней спеке → типизированная правка setInstrument
//     и перекомпиляция (секционные override сохраняются, D-128);
//   • свободного кода спека нет → setPartSound уровня кода (code-model):
//     редактор — источник истины, пресет и шеринг сохраняют состояние.
//
// Модуль грузится динамически по первому клику: каталог и панель не входят
// в основной чанк студии.

import { passportLine } from '../pool-panel.js';
import { getPartSound, setPartSound } from '../core/code-model.js';
import { specHasPart, applyInstrumentToSpec } from '../compose.js';
import { fetchTimbreCatalog } from './register.js';
import { filterPresets, resolverQuery, PROFILES, FAMILY_LABELS } from './picker-filter.js';
import { log } from '../ui.js';
import '../styles/timbre.css';

let overlay = null;

function closePicker() {
  if (overlay) overlay.remove();
  overlay = null;
  document.removeEventListener('keydown', onKeydown);
}

function onKeydown(event) {
  if (event.key === 'Escape') closePicker();
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Карточка пресета: имя, лицензия, паспорт, превью, обоснование резолвера.
 * @param {object} preset
 * @param {{onApply: (preset:object)=>void, reasons?: string[], score?: number, busy?: boolean}} handlers
 */
function presetCard(preset, { onApply, reasons, score }) {
  const card = el('div', 'tp-card');
  card.dataset.presetId = preset.id;

  const head = el('div', 'tp-card-head');
  const name = el('span', 'tp-card-name', preset.name ?? preset.id);
  name.title = preset.attribution ?? '';
  const license = el('span', 'tp-license', preset.license ?? 'лицензия?');
  head.append(name, license);
  card.append(head);

  const meta = el('p', 'tp-card-meta');
  meta.textContent = [
    FAMILY_LABELS[preset.family] ?? preset.family,
    preset.timbreProfile,
    (preset.roles ?? []).join(', '),
  ].filter(Boolean).join(' · ');
  card.append(meta);

  const passport = el('p', 'tp-card-passport', passportLine(preset.descriptor));
  card.append(passport);

  if (preset.tags?.length) {
    card.append(el('p', 'tp-card-tags', preset.tags.join(' · ')));
  }

  if (Number.isFinite(score)) {
    card.append(el('p', 'tp-card-score', `скор резолвера: ${score}`));
  }
  if (reasons?.length) {
    const list = el('ul', 'tp-card-reasons');
    for (const reason of reasons) list.append(el('li', null, reason));
    card.append(list);
  }

  if (preset.preview) {
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.preload = 'none';
    audio.src = preset.preview;
    card.append(audio);
  }

  const apply = el('button', 'btn tp-apply', 'Применить');
  apply.type = 'button';
  apply.addEventListener('click', () => onApply(preset));
  card.append(apply);
  return card;
}

/**
 * Открыть панель выбора инструмента для партии таймлайна.
 *
 * @param {{label:string, role:string|null, family?:string|null, style?:string|null,
 *          getCode:()=>string, applyCode:(code:string)=>void}} context
 *   applyCode — путь таймлайна (редактор + live + пересинхронизация).
 *   family — семейство группы партии (groupOf): общий язык с каталогом,
 *   когда роль партии — инструмент («piano»), а не функция («chords»).
 */
export async function openTimbrePicker({ label, role, family = null, style = null, getCode, applyCode }) {
  closePicker();
  overlay = el('div', 'tp-overlay');
  const panel = el('div', 'tp-panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', `Выбор инструмента для партии ${label}`);
  overlay.append(panel);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closePicker();
  });
  document.addEventListener('keydown', onKeydown);
  document.body.append(overlay);

  const head = el('div', 'tp-head');
  const currentSound = getPartSound(getCode(), label);
  head.append(el('span', 'tp-title', `Инструмент · ${label}`));
  head.append(el('span', 'tp-sub', `роль ${role ?? '—'} · сейчас: ${currentSound ?? '—'}`));
  const closeBtn = el('button', 'btn ghost tp-close', '✕');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Закрыть панель');
  closeBtn.addEventListener('click', closePicker);
  head.append(closeBtn);
  panel.append(head);

  const status = el('p', 'tp-status', 'Загружаем каталог…');
  panel.append(status);

  let catalog;
  try {
    catalog = await fetchTimbreCatalog();
  } catch (err) {
    status.textContent = `Каталог недоступен: ${err?.message || err}. Пресеты не показаны — это честно, а не «ничего не нашлось».`;
    return;
  }
  const presets = catalog.presets ?? [];
  if (!presets.length) {
    status.textContent = 'Каталог пуст: пресеты не импортированы (scripts/import-timbre.mjs).';
    return;
  }
  status.remove();

  // --- фильтры ---
  const filters = el('div', 'tp-filters');
  const familySelect = document.createElement('select');
  familySelect.setAttribute('aria-label', 'Семейство');
  for (const [value, text] of [['', 'все семейства'], ...Object.entries(FAMILY_LABELS)]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    familySelect.append(option);
  }
  // Роль-инструмент экспансии («piano», «violin») в словаре каталога
  // («chords», «lead») не встречается: фильтр роли включается только
  // когда роль есть у пресетов, иначе стартовое семейство — по группе.
  const catalogRoles = new Set(presets.flatMap((preset) => preset.roles ?? []));
  const roleKnown = Boolean(role && catalogRoles.has(role));
  if (!roleKnown && family && FAMILY_LABELS[family]) familySelect.value = family;
  const profileSelect = document.createElement('select');
  profileSelect.setAttribute('aria-label', 'Профиль тембра');
  for (const [value, text] of [['', 'любой профиль'], ...PROFILES.map((p) => [p, p])]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    profileSelect.append(option);
  }
  const roleLabel = el('label', 'tp-role-filter');
  const roleCheck = document.createElement('input');
  roleCheck.type = 'checkbox';
  roleCheck.checked = roleKnown;
  roleLabel.append(roleCheck, document.createTextNode(` только под роль ${role ?? ''}`));
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'теги, имя…';
  search.setAttribute('aria-label', 'Поиск по тегам и имени');
  filters.append(familySelect, profileSelect, roleLabel, search);
  panel.append(filters);

  // --- секции ---
  const resolverTitle = el('h3', 'tp-section-title', 'Подбор резолвера');
  const resolverBox = el('div', 'tp-cards');
  const catalogTitle = el('h3', 'tp-section-title', 'Каталог');
  const catalogBox = el('div', 'tp-cards');
  panel.append(resolverTitle, resolverBox, catalogTitle, catalogBox);

  const state = { busy: false };

  async function applyPreset(preset) {
    if (state.busy) return;
    state.busy = true;
    try {
      if (specHasPart(label)) {
        const result = await applyInstrumentToSpec(label, preset.id);
        if (!result.ok) {
          log(`Инструмент не применён: ${result.error}`, 'error');
          return;
        }
      } else {
        const code = setPartSound(getCode(), label, preset.strudelAlias);
        if (code === getCode()) {
          log(`У партии ${label} нет заменяемого .s() — пресет не применён`, 'error');
          return;
        }
        applyCode(code);
      }
      log(`Инструмент партии ${label}: ${preset.name} (${preset.license ?? 'лицензия?'})`, 'ok');
      closePicker();
    } catch (err) {
      log(`Инструмент не применён: ${err?.message || err}`, 'error');
    } finally {
      state.busy = false;
    }
  }

  async function refreshResolver() {
    resolverBox.replaceChildren(el('p', 'tp-status', 'Резолвер считает…'));
    try {
      const query = resolverQuery({
        role,
        family: familySelect.value || null,
        profile: profileSelect.value || null,
        style,
        useRole: roleCheck.checked,
      });
      const res = await fetch(`/api/timbre/resolve?${query}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const candidates = body.candidates ?? [];
      resolverBox.replaceChildren();
      if (!candidates.length) {
        resolverBox.append(el('p', 'tp-status', 'Резолвер: под эти фильтры пресетов нет. Снимите фильтр роли или выберите другой профиль.'));
        return;
      }
      for (const candidate of candidates) {
        const preset = presets.find((entry) => entry.id === candidate.id) ?? candidate;
        resolverBox.append(presetCard(preset, {
          onApply: applyPreset,
          reasons: candidate.reasons,
          score: candidate.score,
        }));
      }
    } catch (err) {
      resolverBox.replaceChildren(el('p', 'tp-status', `Резолвер недоступен: ${err?.message || err}. Каталог ниже работает.`));
    }
  }

  function refreshCatalog() {
    const filtered = filterPresets(presets, {
      family: familySelect.value || null,
      role: roleCheck.checked ? role : null,
      profile: profileSelect.value || null,
      query: search.value,
    });
    catalogBox.replaceChildren();
    if (!filtered.length) {
      catalogBox.append(el('p', 'tp-status', 'Под эти фильтры пресетов нет — фильтры честные, каталог не пуст.'));
      return;
    }
    for (const preset of filtered) catalogBox.append(presetCard(preset, { onApply: applyPreset }));
  }

  // Сброс к исходному звуку спеки возможен только путём спеки:
  // у свободного кода «исходный звук» после правки неизвестен.
  if (specHasPart(label)) {
    const reset = el('button', 'btn ghost tp-reset', 'Вернуть исходный звук спеки');
    reset.type = 'button';
    reset.addEventListener('click', async () => {
      const result = await applyInstrumentToSpec(label, null);
      if (result.ok) {
        log(`Инструмент партии ${label} сброшен к звуку спеки`, 'ok');
        closePicker();
      } else {
        log(`Сброс не удался: ${result.error}`, 'error');
      }
    });
    panel.append(reset);
  }

  familySelect.addEventListener('change', refreshCatalog);
  roleCheck.addEventListener('change', () => { refreshCatalog(); refreshResolver(); });
  profileSelect.addEventListener('change', () => { refreshCatalog(); refreshResolver(); });
  search.addEventListener('input', refreshCatalog);

  refreshCatalog();
  await refreshResolver();
}