// Чистые функции панели выбора инструмента (этап 4, D-131).
// Без DOM и без тяжёлых импортов — тестируются в node, как passportLine
// панели пула. Саму панель (DOM, каталог, резолвер) строит picker.js.

export const PROFILES = ['warm', 'bright', 'dark', 'soft'];
export const FAMILY_LABELS = { keys: 'клавишные', strings: 'струнные', bass: 'бас' };

/**
 * Фильтр каталога по метаданным (без ML): семейство, роль, профиль,
 * текст по имени/тегам. Детерминированный порядок — по id.
 *
 * Профиль совпадает либо с timbreProfile пресета, либо с его тегом —
 * та же семантика, что у текстового шага резолвера (D-128).
 *
 * @param {Array<object>} presets публичные метаданные пресетов
 * @param {{family?:string|null, role?:string|null, profile?:string|null, query?:string|null}} filters
 * @returns {Array<object>}
 */
export function filterPresets(presets, { family = null, role = null, profile = null, query = null } = {}) {
  const q = String(query ?? '').trim().toLowerCase();
  return (presets ?? [])
    .filter((preset) => {
      if (family && preset.family !== family) return false;
      if (role && !(preset.roles ?? []).includes(role)) return false;
      if (profile && preset.timbreProfile !== profile && !(preset.tags ?? []).includes(profile)) return false;
      if (q) {
        const hay = `${preset.name ?? ''} ${(preset.tags ?? []).join(' ')} ${preset.family ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/**
 * Параметры запроса резолвера: роль партии учитывается, пока включён фильтр;
 * иначе — семейство (у экспансии роли-инструменты «piano/violin», у каталога
 * роли-функции «chords/lead»: семейство — общий язык).
 */
export function resolverQuery({ role, family, profile, style, useRole }) {
  const params = new URLSearchParams();
  if (useRole && role) params.set('role', role);
  else if (family) params.set('family', family);
  if (profile) params.set('profile', profile);
  if (style) params.set('style', style);
  params.set('limit', '5');
  return params.toString();
}