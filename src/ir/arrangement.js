// Аранжировщик: арка → секции.
//
// Форма трека — не украшение, а измеряемая величина: контраст соседних
// секций и корреляция профиля энергии с целевой кривой (North Star, §4.2).
// Поэтому арка задаётся числами ДО генерации, а компилятор лишь исполняет её.
//
// Источник: skills/arrangement-arcs.md.

/** Арки: такты и целевая энергия по секциям. */
export const ARCS = {
  'song-64': [
    { kind: 'intro', bars: 8, energy: 0.2 },
    { kind: 'verse', bars: 16, energy: 0.45 },
    { kind: 'build', bars: 8, energy: 0.65 },
    { kind: 'peak', bars: 16, energy: 0.85 },
    { kind: 'break', bars: 8, energy: 0.3 },
    { kind: 'outro', bars: 8, energy: 0.2 },
  ],
  'club-64': [
    { kind: 'intro', bars: 16, energy: 0.3 },
    { kind: 'build', bars: 16, energy: 0.6 },
    { kind: 'drop', bars: 16, energy: 0.9 },
    { kind: 'break', bars: 8, energy: 0.25 },
    { kind: 'drop', bars: 8, energy: 0.85 },
  ],
  'slow-burn-48': [
    { kind: 'intro', bars: 8, energy: 0.15 },
    { kind: 'verse', bars: 12, energy: 0.4 },
    { kind: 'verse', bars: 12, energy: 0.65 },
    { kind: 'break', bars: 8, energy: 0.25 },
    { kind: 'outro', bars: 8, energy: 0.2 },
  ],
  'bloom-40': [
    { kind: 'air', bars: 8, energy: 0.1 },
    { kind: 'grow', bars: 12, energy: 0.35 },
    { kind: 'bloom', bars: 12, energy: 0.55 },
    { kind: 'fade', bars: 8, energy: 0.15 },
  ],
};

/**
 * Матрица «роль × секция»: множитель гейна роли в секции.
 * Ноль означает «роли в секции нет».
 *
 * Снейр обязателен: без него у трека нет акцента на 2 и 4 долю, и любой
 * жанр с грувом звучит как «бит без бэкбита». До правки снейра в матрице
 * не было вообще — ни один трек из IR не имел снейра.
 */
export const ROLE_MATRIX = {
  intro: { kick: 0, snare: 0, bass: 0, chords: 0.7, pad: 0.6, lead: 0, hats: 0, perc: 0, fx: 0.8, texture: 0.5, sub: 0, arp: 0.3 },
  verse: { kick: 0.9, snare: 0.85, bass: 0.85, chords: 0.8, pad: 0.6, lead: 0.6, hats: 0.6, perc: 0.5, fx: 0.4, texture: 0.4, sub: 0.7, arp: 0.5 },
  build: { kick: 1, snare: 1, bass: 0.95, chords: 0.9, pad: 0.7, lead: 0.8, hats: 0.9, perc: 0.7, fx: 1, texture: 0.5, sub: 0.9, arp: 0.7 },
  peak: { kick: 1, snare: 1, bass: 1, chords: 1, pad: 0.8, lead: 1, hats: 1, perc: 0.8, fx: 0.5, texture: 0.6, sub: 1, arp: 0.8 },
  break: { kick: 0, snare: 0, bass: 0, chords: 0.9, pad: 0.9, lead: 0.8, hats: 0.3, perc: 0, fx: 0.9, texture: 0.7, sub: 0, arp: 0.5 },
  outro: { kick: 0.7, snare: 0.6, bass: 0.6, chords: 0.7, pad: 0.8, lead: 0, hats: 0.3, perc: 0, fx: 0.7, texture: 0.6, sub: 0.5, arp: 0 },
  // Арка эмбиента: пик — это пространство, а не громкость.
  air: { kick: 0, snare: 0, bass: 0, chords: 0, pad: 0.5, lead: 0, hats: 0, perc: 0, fx: 0.6, texture: 0.8, sub: 0.4, arp: 0 },
  grow: { kick: 0, snare: 0, bass: 0.4, chords: 0.6, pad: 0.8, lead: 0, hats: 0, perc: 0, fx: 0.7, texture: 0.7, sub: 0.6, arp: 0.2 },
  bloom: { kick: 0.3, snare: 0.25, bass: 0.5, chords: 0.8, pad: 1, lead: 0.4, hats: 0.2, perc: 0, fx: 0.8, texture: 0.9, sub: 0.6, arp: 0.4 },
  fade: { kick: 0, snare: 0, bass: 0, chords: 0.4, pad: 0.7, lead: 0, hats: 0, perc: 0, fx: 0.7, texture: 0.8, sub: 0.3, arp: 0.2 },
};

/** Роли, у которых есть рисунок ударов (сетка 1/16). */
export const DRUM_ROLES = new Set(['kick', 'snare', 'hats', 'perc']);

/**
 * Планирует секции трека по арке.
 *
 * @param {object} options
 * @param {string} options.arc имя арки ('song-64' и т. п.)
 * @param {string} options.id префикс id секций
 * @returns {Array<{id:string, kind:string, bars:number, energy:number, tension:number, layers:object}>}
 */
export function planSections({ arc = 'song-64', id = 'sec' } = {}) {
  const shape = ARCS[arc] || ARCS['song-64'];
  const used = new Map();
  return shape.map((step, index) => {
    const count = (used.get(step.kind) || 0) + 1;
    used.set(step.kind, count);
    const sectionId = count > 1 ? `${id}-${step.kind}-${count}` : `${id}-${step.kind}`;
    const matrix = ROLE_MATRIX[step.kind] || ROLE_MATRIX.verse;
    const layers = {};
    for (const [role, weight] of Object.entries(matrix)) {
      if (!weight) continue;
      layers[role] = {
        plan: planForRole(role),
        density: 1,
        register: registerForRole(role),
        gainDb: undefined,
        weight,
      };
    }
    return {
      id: sectionId,
      kind: step.kind,
      bars: step.bars,
      energy: step.energy,
      // Напряжение растёт к пику и падает в break — по энергии секции.
      tension: Math.round(step.energy * 100) / 100,
      layers,
      enter: enterFor(step.kind, index),
    };
  });
}

/** План партии по роли. */
export function planForRole(role) {
  if (DRUM_ROLES.has(role)) return 'drums';
  if (role === 'bass' || role === 'sub') return 'bassline';
  if (role === 'chords') return 'chords';
  if (role === 'pad') return 'pad';
  if (role === 'lead') return 'melody';
  if (role === 'arp') return 'arp';
  if (role === 'texture') return 'texture';
  return 'fx';
}

/** Регистр роли в MIDI-нотах: [низ, верх]. */
export function registerForRole(role) {
  switch (role) {
    case 'kick': return [36, 48];
    case 'snare': return [48, 60];
    case 'hats': return [72, 84];
    case 'perc': return [60, 72];
    case 'sub': return [28, 40];
    case 'bass': return [36, 52];
    case 'chords': return [55, 76];
    case 'pad': return [48, 72];
    case 'lead': return [60, 84];
    case 'arp': return [60, 84];
    case 'fx': return [48, 84];
    default: return [48, 84];
  }
}

/** Переход в секцию: ризер, открытие фильтра, филл или тишина перед дропом. */
function enterFor(kind, index) {
  if (kind === 'build') return 'riser';
  if (kind === 'peak' || kind === 'drop') return 'filter-open';
  if (kind === 'break') return 'silence';
  if (kind === 'outro') return 'fill';
  return 'none';
}
