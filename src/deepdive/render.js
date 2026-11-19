// Отрисовка результата разбора: паспорт трека, структура, матрица «секция × слой»,
// код-двойник, метрики похожести и честность.
//
// Числа берутся только из ответа сервера: если поля нет — показываем «—»
// или «нет данных», но никогда не подставляем ноль вместо отсутствующих данных.
import { $, el, clear, num, conf, pct, fmtTime, clamp01 } from './dom.js';

const LAYERS = ['drums', 'bass', 'vocals', 'other'];
const LAYER_TITLES = {
  drums: 'Барабаны',
  bass: 'Бас',
  vocals: 'Вокал',
  other: 'Прочее',
};

const MODE_TITLES = {
  major: 'мажор',
  minor: 'минор',
  dorian: 'дорический',
  phrygian: 'фригийский',
  lydian: 'лидийский',
  mixolydian: 'миксолидийский',
  harmonic_minor: 'гармонический минор',
  unknown: 'не определён',
};

const BANDS = [
  ['sub', 'Саб'],
  ['low', 'Низ'],
  ['low_mid', 'Низ-середина'],
  ['mid', 'Середина'],
  ['high_mid', 'Верх-середина'],
  ['high', 'Верх'],
];

const METRIC_LAYERS = [
  ['rhythm', 'Ритм'],
  ['bass', 'Бас'],
  ['timbre', 'Тембр'],
  ['groove', 'Грув'],
  ['loudness', 'Громкость'],
];

const METRIC_LABELS = {
  f1: 'F1',
  precision: 'точность',
  recall: 'полнота',
  tolerance_ms: 'допуск, мс',
  note_overlap: 'совпадение нот',
  note_match_ratio: 'совпадение нот',
  mean_midi_delta: 'среднее отклонение MIDI',
  f0_rmse_cents: 'RMSE f0, центы',
  octave_agnostic: 'октава не важна',
  logmel_cosine: 'косинус log-mel',
  cosine: 'косинус спектра',
  mel_bands: 'полос mel',
  envelope_correlation: 'корреляция огибающих',
  swing_delta: 'дельта свинга',
  similarity: 'похожесть грува',
  matched: 'совпало нот',
  reference_count: 'нот оригинала',
  candidate_count: 'нот двойника',
  source: 'источник данных',
  per_layer: 'по слоям',
  lufs_delta_db: 'разница LUFS, дБ',
  twin_lufs_i: 'LUFS двойника',
  reference_lufs_i: 'LUFS оригинала',
  mean_frame_cosine: 'косинус по кадрам',
  reference_frames: 'кадров оригинала',
  candidate_frames: 'кадров двойника',
};

/* --- Паспорт трека --- */

function metricCard(label, value, { unit = '', confidence = null } = {}) {
  const card = el('div', 'dive-metric');
  card.append(el('div', 'dive-metric-label', label));
  const row = el('div', 'dive-metric-value');
  row.append(el('span', 'dive-metric-num', value));
  if (unit) row.append(el('span', 'dive-metric-unit', unit));
  card.append(row);
  const c = conf(confidence);
  if (c) card.append(el('div', 'dive-metric-conf', c));
  return card;
}

function spectralCard(balance) {
  const card = el('div', 'dive-metric dive-metric-wide');
  card.append(el('div', 'dive-metric-label', 'Спектральный баланс'));
  if (!balance || typeof balance !== 'object') {
    card.append(el('div', 'dive-metric-none', 'нет данных'));
    return card;
  }
  const list = el('div', 'dive-bands');
  for (const [key, title] of BANDS) {
    const value = Number(balance[key]);
    const row = el('div', 'dive-band');
    row.append(el('span', 'dive-band-label', title));
    const track = el('div', 'dive-band-track');
    const fill = el('div', 'dive-band-fill');
    fill.style.width = `${clamp01(Number.isFinite(value) ? value : 0) * 100}%`;
    if (!Number.isFinite(value)) fill.classList.add('is-empty');
    track.append(fill);
    row.append(track);
    row.append(el('span', 'dive-band-value', num(value, 2)));
    list.append(row);
  }
  card.append(list);
  return card;
}

export function renderPassport(payload) {
  const box = $('dive-passport');
  if (!box) return;
  clear(box);

  const m = payload?.measurements || {};
  const tempo = m.tempo || {};
  const key = m.key || {};
  const loud = m.loudness || {};
  const stereo = m.stereo || {};
  const track = payload?.track || {};

  box.append(metricCard('Темп', num(tempo.bpm, 2), { unit: 'BPM', confidence: tempo.confidence }));
  box.append(
    metricCard('Тональность', key.tonic ? `${key.tonic} · ${MODE_TITLES[key.mode] ?? key.mode ?? '—'}` : '—', {
      confidence: key.confidence,
    }),
  );
  box.append(metricCard('Громкость', num(loud.lufs_integrated, 1), { unit: 'LUFS' }));
  box.append(metricCard('True peak', num(loud.true_peak_dbtp, 1), { unit: 'dBTP' }));
  box.append(metricCard('Корреляция стерео', num(stereo.correlation, 2)));
  box.append(metricCard('Ширина стерео', num(stereo.width, 2)));
  box.append(metricCard('Длительность', fmtTime(track.duration_s), { unit: track.duration_s ? '' : '' }));
  box.append(spectralCard(m.spectral_balance));

  // Альтернативные темпы — половина/двойной размер: их полезно видеть, но не спорить.
  if (Array.isArray(tempo.candidates) && tempo.candidates.length) {
    const note = el('div', 'dive-note');
    note.append(el('span', 'dive-note-label', 'Другие темпы: '));
    note.append(
      el(
        'span',
        'dive-note-text',
        tempo.candidates
          .map((c) => `${num(c?.bpm, 2)} BPM (${c?.kind ?? '—'}${c?.confidence !== undefined ? `, ${conf(c.confidence)}` : ''})`)
          .join(' · '),
      ),
    );
    box.append(note);
  }
}

/* --- Структура: таймлайн секций --- */

export function renderStructure(payload) {
  const box = $('dive-structure');
  if (!box) return;
  clear(box);

  const sections = Array.isArray(payload?.structure) ? payload.structure : [];
  if (!sections.length) {
    box.append(el('p', 'hint', 'Сервер не вернул структуру трека — данных нет'));
    return;
  }

  const durations = sections.map((s) => Math.max(0, Number(s?.end_s ?? 0) - Number(s?.start_s ?? 0)));
  const total = durations.reduce((sum, d) => sum + d, 0) || 1;

  const bar = el('div', 'dive-timeline');
  sections.forEach((s, i) => {
    const block = el('div', 'dive-tl-block');
    // Ширина пропорциональна длительности: глаз сразу видит форму трека.
    block.style.flexGrow = String(Math.max(0.04, durations[i] / total));
    block.style.setProperty('--energy', String(clamp01(s?.energy)));
    block.title = `${s?.label ?? s?.index ?? i}: ${fmtTime(s?.start_s)}–${fmtTime(s?.end_s)}, энергия ${pct(s?.energy)}`;
    block.append(el('span', 'dive-tl-label', s?.label ?? String(s?.index ?? i)));
    bar.append(block);
  });
  box.append(bar);

  const list = el('div', 'dive-struct-list');
  sections.forEach((s, i) => {
    const row = el('div', 'dive-struct-row');
    row.append(el('span', 'dive-struct-label', s?.label ?? String(s?.index ?? i)));
    row.append(el('span', 'dive-struct-time', `${fmtTime(s?.start_s)} – ${fmtTime(s?.end_s)}`));
    row.append(el('span', 'dive-struct-energy', `энергия ${pct(s?.energy)}`));
    row.append(el('span', 'dive-struct-dur', `${fmtTime(durations[i])}`));
    list.append(row);
  });
  box.append(list);
}

/* --- Слои: матрица «секция × слой» и микшер стемов --- */

function activityFor(layerDesc, section, index) {
  const activity = layerDesc?.activity;
  if (!activity || typeof activity !== 'object') return null;
  const raw = activity[index] ?? activity[String(index)] ?? activity[section?.label];
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function stemMeta(payload, layer) {
  const stems = payload?.stems;
  if (Array.isArray(stems)) {
    const found = stems.find((s) => s?.name === layer);
    if (!found) return null;
    return { available: found.available !== false, duration: found.duration_s };
  }
  if (stems && typeof stems === 'object') {
    const found = stems[layer];
    if (!found) return null;
    return { available: found.available !== false, duration: found.duration_s };
  }
  return null;
}

export function renderLayers(payload) {
  renderMatrix(payload);
  renderStemMixer(payload);
}

function renderMatrix(payload) {
  const box = $('dive-matrix');
  if (!box) return;
  clear(box);

  const sections = Array.isArray(payload?.structure) ? payload.structure : [];
  const descriptors = payload?.stem_descriptors || {};

  if (!sections.length) {
    box.append(el('p', 'hint', 'Без структуры матрицу «секция × слой» построить нельзя'));
    return;
  }

  const grid = el('div', 'dive-matrix-grid');
  // Плюс первая колонка — названия слоёв; остальные колонки — секции.
  grid.style.setProperty('--cols', String(sections.length));

  const head = el('div', 'dive-matrix-cell dive-matrix-head');
  head.append(el('span', null, 'слой / секция'));
  grid.append(head);
  sections.forEach((s, i) => {
    const cell = el('div', 'dive-matrix-cell dive-matrix-head');
    cell.append(el('span', null, s?.label ?? String(i)));
    cell.title = `${fmtTime(s?.start_s)}–${fmtTime(s?.end_s)}`;
    grid.append(cell);
  });

  for (const layer of LAYERS) {
    const desc = descriptors[layer];
    const name = el('div', 'dive-matrix-cell dive-matrix-rowname');
    name.append(el('span', null, LAYER_TITLES[layer] ?? layer));
    if (!desc) name.append(el('span', 'dive-matrix-tag', 'нет данных'));
    grid.append(name);

    sections.forEach((s, i) => {
      const value = desc ? activityFor(desc, s, i) : null;
      const cell = el('div', 'dive-matrix-cell');
      if (value === null) {
        cell.classList.add('is-empty');
        cell.append(el('span', null, '—'));
        cell.title = 'нет данных';
      } else {
        cell.style.setProperty('--v', String(clamp01(value)));
        cell.append(el('span', null, num(value, 2)));
        cell.title = `${LAYER_TITLES[layer] ?? layer} · ${s?.label ?? i}: ${num(value, 3)}`;
      }
      grid.append(cell);
    });
  }

  box.append(grid);
  box.append(el('p', 'hint', 'Цвет — интенсивность активности слоя в секции; «—» означает, что данных нет, а не ноль.'));
}

function renderStemMixer(payload) {
  const box = $('dive-layers');
  if (!box) return;
  clear(box);

  const descriptors = payload?.stem_descriptors || {};
  const rows = el('div', 'dive-layer-list');

  for (const layer of LAYERS) {
    const desc = descriptors[layer];
    const meta = stemMeta(payload, layer);
    const row = el('div', 'dive-layer-row');

    const name = el('div', 'dive-layer-name');
    name.append(el('span', 'dive-layer-title', LAYER_TITLES[layer] ?? layer));
    if (!desc && !meta) {
      name.append(el('span', 'dive-layer-state is-missing', 'слой недоступен'));
    } else if (meta && meta.available === false) {
      name.append(el('span', 'dive-layer-state is-missing', 'слой недоступен'));
    }
    row.append(name);

    const activity = desc?.activity && typeof desc.activity === 'object' ? Object.values(desc.activity) : [];
    const numbers = activity.map((v) => Number(v)).filter((v) => Number.isFinite(v));
    const mean = numbers.length ? numbers.reduce((s, v) => s + v, 0) / numbers.length : null;

    const meter = el('div', 'dive-layer-meter');
    const fill = el('div', 'dive-layer-fill');
    fill.style.width = `${clamp01(mean ?? 0) * 100}%`;
    if (mean === null) fill.classList.add('is-empty');
    meter.append(fill);
    row.append(meter);

    row.append(el('span', 'dive-layer-value', mean === null ? 'нет данных' : pct(mean, 0)));
    rows.append(row);
  }

  box.append(rows);
  box.append(el('p', 'hint', 'Средняя активность слоя по секциям. Разделение на стемы включается галочкой при разборе.'));
}

/* --- Код-двойник --- */

export function renderTwin(payload) {
  const pre = $('dive-code');
  if (!pre) return;
  const code = payload?.code_twin?.code ?? '';
  pre.textContent = code ? code.slice(0, 4000) : 'Код не пришёл — данных нет';
  if (code && code.length > 4000) pre.textContent += '\n… (полный код — в модальном окне)';

  const status = $('dive-twin-status');
  if (status) {
    const render = payload?.code_twin?.render || {};
    const statusText = render.status === 'rendered'
      ? `Рендер готов (${fmtTime(render.duration_s)})`
      : render.status === 'failed'
        ? 'Рендер двойника не удался — сравнение по звуку недоступно'
        : 'Рендер не выполнялся';
    status.textContent = statusText;
    status.classList.toggle('is-warn', render.status !== 'rendered');
  }

  const take = $('dive-code-take');
  if (take) take.disabled = !code;
  const show = $('dive-code-show');
  if (show) show.disabled = !code;
}

/* --- Метрики похожести --- */

export function renderMetrics(payload) {
  const box = $('dive-metrics');
  if (!box) return;
  clear(box);

  const metrics = Array.isArray(payload?.code_twin?.metrics) ? payload.code_twin.metrics : [];
  if (!metrics.length) {
    box.append(el('p', 'hint', 'Метрики сравнения не пришли — данных нет'));
    return;
  }

  const latest = metrics[metrics.length - 1];
  const overall = el('div', 'dive-overall');
  overall.append(el('span', 'dive-overall-num', num(latest?.overall, 3)));
  // Покрытие — рядом с общей оценкой. Общая оценка нормирована по тем слоям,
  // которые измерены, поэтому без покрытия она вводит в заблуждение:
  // «0.92» при двух слоях из четырёх — это не то же, что «0.92» при четырёх.
  const coverageLabel = latest?.coverage?.label
    ? ` · слои ${latest.coverage.label}`
    : '';
  overall.append(el('span', 'dive-overall-label', `общее сходство${coverageLabel} · ${latest?.label ?? `итерация ${latest?.iteration ?? '—'}`}`));
  box.append(overall);

  const grid = el('div', 'dive-metric-layers');
  for (const [key, title] of METRIC_LAYERS) {
    const data = latest?.layers?.[key];
    const card = el('div', 'dive-metric-layer');
    card.append(el('div', 'dive-metric-layer-title', title));
    if (!data || typeof data !== 'object' || !Object.keys(data).length) {
      card.append(el('div', 'dive-metric-none', 'нет данных'));
      grid.append(card);
      continue;
    }
    const list = el('div', 'dive-metric-pairs');
    for (const [name, value] of Object.entries(data)) {
      // Объект (например, per_layer с метриками по слоям) нельзя превращать
      // в строку: получалось «[object Object]». Такие значения раскрываются
      // списком, а не строкой.
      if (value && typeof value === 'object') {
        const row = el('div', 'dive-metric-pair');
        row.append(el('span', 'dive-metric-key', METRIC_LABELS[name] ?? name));
        const details = el('span', 'dive-metric-val');
        for (const [subName, subValue] of Object.entries(value)) {
          const line = el('div', 'dive-metric-sub');
          line.append(el('span', 'dive-metric-key', METRIC_LABELS[subName] ?? subName));
          line.append(el('span', 'dive-metric-val', typeof subValue === 'number' ? num(subValue, 3) : String(subValue)));
          details.append(line);
        }
        row.append(details);
        list.append(row);
        continue;
      }
      const row = el('div', 'dive-metric-pair');
      row.append(el('span', 'dive-metric-key', METRIC_LABELS[name] ?? name));
      row.append(el('span', 'dive-metric-val', typeof value === 'number' ? num(value, 3) : String(value)));
      list.append(row);
    }
    card.append(list);
    grid.append(card);
  }
  box.append(grid);

  if (metrics.length > 1) {
    const history = el('div', 'dive-note');
    history.append(el('span', 'dive-note-label', 'Итерации: '));
    history.append(
      el(
        'span',
        'dive-note-text',
        metrics.map((m) => `${m?.label ?? `итерация ${m?.iteration ?? '—'}`}: ${num(m?.overall, 3)}`).join(' · '),
      ),
    );
    box.append(history);
  }
}

/* --- Отказы и деградации --- */

/**
 * Что не получилось измерить. Сервер отдаёт это в payload.errors.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫМ БЛОКОМ. «Нет данных» и «ноль» — разные вещи (D-102): если
 * разделение на стемы не состоялось из-за нехватки памяти, то метрик по слоям
 * НЕТ, а не «они нулевые». Без этого блока человек видит пустую матрицу и не
 * понимает, что произошло.
 */
export function renderFailures(payload) {
  const box = $('dive-failures');
  if (!box) return;
  clear(box);

  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  if (!errors.length) {
    box.append(el('p', 'hint', 'Отказов и деградаций не зафиксировано.'));
    return;
  }
  const list = el('ul', 'dive-failure-list');
  for (const item of errors) {
    const text = item?.message ? String(item.message) : 'причина не указана';
    list.append(el('li', 'dive-failure-item', `${item?.stage ? `[${item.stage}] ` : ''}${text}`));
  }
  box.append(list);
}

/* --- Честность --- */

export function renderHonesty(payload) {
  const box = $('dive-honesty');
  if (!box) return;
  clear(box);

  const honesty = payload?.code_twin?.honesty || {};
  const caveats = Array.isArray(honesty.caveats) ? honesty.caveats : [];
  const notReproduced = Array.isArray(honesty.not_reproduced) ? honesty.not_reproduced : [];
  const claims = Array.isArray(honesty.claims) ? honesty.claims : [];
  const all = [...caveats, ...notReproduced];

  if (!all.length) {
    box.append(el('p', 'dive-honesty-empty', 'Сервер не прислал список ограничений. Это не значит, что ограничений нет.'));
  } else {
    const list = el('ul', 'dive-honesty-list');
    for (const item of all) list.append(el('li', 'dive-honesty-item', item));
    box.append(list);
  }

  if (claims.length) {
    const claimsBox = el('div', 'dive-honesty-claims');
    claimsBox.append(el('div', 'dive-metric-layer-title', 'Что измерено'));
    const list = el('ul', 'dive-honesty-list');
    for (const item of claims) list.append(el('li', 'dive-honesty-item', item));
    claimsBox.append(list);
    box.append(claimsBox);
  }
}

/* --- Журнал итераций улучшения --- */

export function renderIterations(payload) {
  const box = $('dive-iterations');
  if (!box) return;
  clear(box);

  const iterations = Array.isArray(payload?.code_twin?.iterations) ? payload.code_twin.iterations : [];
  if (!iterations.length) {
    box.append(el('p', 'hint', 'Итераций улучшения пока нет'));
    return;
  }

  for (const iteration of iterations) {
    const card = el('div', 'dive-iteration');
    const head = el('div', 'dive-iteration-head');
    head.append(el('span', 'dive-iteration-title', `Итерация ${iteration?.iteration ?? '—'}`));

    const before = iteration?.score_before ?? iteration?.metrics?.before ?? null;
    const after = iteration?.score_after ?? iteration?.metrics?.overall ?? null;
    const delta = iteration?.delta?.overall ?? (before !== null && after !== null ? after - before : null);
    const score = el('span', 'dive-iteration-score');
    if (before !== null || after !== null) {
      score.append(el('span', 'dive-iteration-before', num(before, 3)));
      score.append(el('span', 'dive-iteration-arrow', ' → '));
      score.append(el('span', 'dive-iteration-after', num(after, 3)));
    }
    if (delta !== null && delta !== undefined) {
      const sign = delta > 0 ? '+' : '';
      score.append(el('span', 'dive-iteration-delta', ` (${sign}${num(delta, 3)})`));
    }
    head.append(score);
    card.append(head);

    const changes = Array.isArray(iteration?.changes) ? iteration.changes : [];
    if (changes.length) {
      const list = el('ul', 'dive-iteration-changes');
      for (const change of changes) {
        list.append(el('li', null, describeChange(change)));
      }
      card.append(list);
    } else {
      card.append(el('div', 'dive-metric-none', 'изменения не описаны'));
    }

    const caveats = Array.isArray(iteration?.honesty?.caveats) ? iteration.honesty.caveats : [];
    if (caveats.length) {
      const list = el('ul', 'dive-iteration-caveats');
      for (const caveat of caveats) list.append(el('li', null, caveat));
      card.append(list);
    }

    box.append(card);
  }
}

// Изменение приходит строкой или объектом {field, from, to, reason}.
function describeChange(change) {
  if (typeof change === 'string') return change;
  if (!change || typeof change !== 'object') return String(change ?? '—');
  const from = change.from === undefined ? '—' : JSON.stringify(change.from);
  const to = change.to === undefined ? '—' : JSON.stringify(change.to);
  const reason = change.reason ? ` — ${change.reason}` : '';
  return `${change.field ?? 'поле'}: ${from} → ${to}${reason}`;
}
