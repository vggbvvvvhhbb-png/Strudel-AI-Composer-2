// Панель пула сэмплов (D-115, фаза F).
//
// Найденный «Охотником» звук должен быть слышен до выбора: карточка
// показывает имя, лицензию, паспорт (измеренные признаки) и превью.
// Пустой пул — честно пустой пул, а не «нашлось 12 звуков».

/**
 * Строка паспорта: только измеренное, без догадок.
 * @param {object|null} passport
 * @returns {string}
 */
export function passportLine(passport) {
  if (!passport) return 'паспорт не снят';
  const parts = [];
  if (Number.isFinite(passport.durationS)) parts.push(`${passport.durationS.toFixed(2)} с`);
  if (passport.tonal?.note) parts.push(`нота ${passport.tonal.note}`);
  if (Number.isFinite(passport.spectral?.centroidHz)) parts.push(`центроид ${Math.round(passport.spectral.centroidHz)} Гц`);
  if (Number.isFinite(passport.tempo?.bpm)) parts.push(`${Math.round(passport.tempo.bpm)} BPM`);
  if (Array.isArray(passport.character) && passport.character.length) parts.push(passport.character.join(', '));
  return parts.length ? parts.join(' · ') : 'паспорт пуст: признаков не измерено';
}

/**
 * Карточка сэмпла пула.
 * @param {object} entry
 * @returns {HTMLElement}
 */
export function poolItem(entry) {
  const item = document.createElement('div');
  item.className = 'pool-item';

  const head = document.createElement('div');
  head.className = 'pool-item-head';
  const name = document.createElement('span');
  name.className = 'pool-item-name';
  name.textContent = entry.name ?? entry.id;
  name.title = entry.attribution ?? '';
  const license = document.createElement('span');
  license.className = 'pool-license';
  license.textContent = entry.licenseId === 'cc-by' ? 'CC BY' : entry.licenseId === 'cc0' ? 'CC0' : (entry.license ?? 'лицензия?');
  head.append(name, license);

  const passport = document.createElement('p');
  passport.className = 'pool-passport';
  passport.textContent = passportLine(entry.passport);

  item.append(head, passport);

  if (entry.file) {
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.preload = 'none';
    audio.src = `/api/samples/pool/${encodeURIComponent(entry.id)}/audio`;
    item.append(audio);
  }

  if (entry.licenseId === 'cc-by' && entry.attribution) {
    const attribution = document.createElement('p');
    attribution.className = 'hint';
    attribution.textContent = entry.attribution;
    item.append(attribution);
  }
  return item;
}

export function initPoolPanel() {
  const listEl = document.getElementById('pool-list');
  if (!listEl) return;

  async function refresh() {
    try {
      const res = await fetch('/api/samples/pool');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const samples = body.samples ?? [];
      listEl.replaceChildren();
      if (!samples.length) {
        const hint = document.createElement('p');
        hint.className = 'hint';
        hint.textContent = 'Пул пуст. Попросите агента-«Охотника» найти звук — он появится здесь с паспортом.';
        listEl.append(hint);
        return;
      }
      for (const entry of samples) listEl.append(poolItem(entry));
    } catch (err) {
      listEl.replaceChildren();
      const hint = document.createElement('p');
      hint.className = 'hint';
      hint.textContent = `Пул не прочитан: ${err?.message || err}`;
      listEl.append(hint);
    }
  }

  refresh();
  // «Охотник» мог добавить сэмпл, пока студия открыта.
  window.addEventListener('samples:pool-changed', refresh);
}