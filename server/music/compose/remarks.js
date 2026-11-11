// Замечания к спеке: конкретные, локальные, пригодные для правки.
//
// Почему отдельный файл: формулировки замечаний — это контракт между
// метриками и моделью. Если метрика изменилась, меняется и текст
// замечания; держать их рядом значит держать согласованными.
//
// Каждое замечание отвечает на два вопроса:
//   • ЧТО не так — с точностью до тактов и ролей;
//   • ЧТО сделать — конкретное действие со спекой (recipe, variant,
//     энергия, переход, прогрессия), а не «сделай лучше».
//
// Формулировки покрыты тестами: у каждой есть проверка, что текст
// упоминает проблему и действие.

/**
 * Типы замечаний. `kind` — по нему refine выбирает, КАК править спеку.
 */
export const REMARK_KINDS = {
  /** Одна и та же гармония слишком долго. */
  HARMONY_WALL: 'harmony-wall',
  /** Энергия трека плоская: секции не различаются. */
  FLAT_ENERGY: 'flat-energy',
  /** Партия повторяет саму себя: рисунок не меняется от секции к секции. */
  REPEATED_PART: 'repeated-part',
  /** Секция без перехода — трек «рвётся» на части. */
  MISSING_TRANSITION: 'missing-transition',
  /** Слишком мало партий: трек пустой. */
  THIN_ARRANGEMENT: 'thin-arrangement',
  /** Мотив не задан: мелодической линии нет. */
  NO_MOTIF: 'no-motif',
};

/**
 * Оценка «плоскости» энергии по спекам.
 *
 * Плоскость — это когда секции не различаются по энергии: размах
 * (максимум − минимум) мал, а разница между соседними секциями
 * почти нулевая. Треку без формы нужен размах.
 *
 * @param {object[]} form секции спеки
 * @returns {{range: number, maxJump: number, flat: boolean}}
 */
export function energyProfile(form) {
  const energies = (form || []).map((s) => Number(s.energy) || 0);
  if (energies.length < 2) return { range: 0, maxJump: 0, flat: true };
  const range = Math.max(...energies) - Math.min(...energies);
  let maxJump = 0;
  for (let i = 1; i < energies.length; i += 1) {
    maxJump = Math.max(maxJump, Math.abs(energies[i] - energies[i - 1]));
  }
  // Размах меньше 0.25 — секции неразличимы; скачок меньше 0.1 между
  // соседями — переходов нет даже при общем размахе.
  return { range, maxJump, flat: range < 0.25 || maxJump < 0.1 };
}

/**
 * Собирает замечания к спеке.
 *
 * @param {object} spec спека (уже прошедшая checkSpec)
 * @param {object} [context] дополнительные данные (например, метрики v2)
 * @returns {Array<{id:string, kind:string, label:string, hint:string, action:object}>}
 */
export function collectRemarks(spec, context = {}) {
  const remarks = [];
  if (!spec || !Array.isArray(spec.form) || !spec.form.length) return remarks;

  const form = spec.form;
  const totalBars = form.reduce((sum, s) => sum + s.bars, 0);

  // --- 1. Гармоническая «обои» ---
  // Одна и та же прогрессия во всех секциях = гармония не меняется.
  // Ключ сравнения — id прогрессии и степени.
  const harmonyKey = (section) => {
    const override = section.progressionOverride;
    if (override?.progressionId) return override.progressionId;
    if (override?.degrees) return override.degrees.join('-');
    return null;
  };
  const globalKey = spec.harmony?.progressionId
    || (spec.harmony?.degrees ? spec.harmony.degrees.join('-') : null);
  const sameHarmony = form.filter((s) => {
    const key = harmonyKey(s);
    return key === null ? true : key === globalKey;
  }).length;
  if (form.length >= 3 && sameHarmony === form.length) {
    const barsInOneHarmony = totalBars;
    remarks.push({
      id: 'harmony-wall',
      kind: REMARK_KINDS.HARMONY_WALL,
      label: 'Гармония не меняется',
      hint:
        `Одна и та же гармония ${barsInOneHarmony} тактов подряд — это «обои». ` +
        'Задай в одной-двух секциях progressionOverride с другими степенями, ' +
        'чтобы гармония двигалась.',
      action: { type: 'change-progression', sectionIndex: Math.min(1, form.length - 1) },
    });
  }

  // --- 2. Плоская энергия ---
  const energy = energyProfile(form);
  if (energy.flat) {
    // Ищем тихую и громкую секции. Если ни одной нет (все секции на
    // одном уровне) — назначаем по краям: начало тише, конец громче.
    let quiet = form.findIndex((s) => (Number(s.energy) || 0) < 0.45);
    let loud = form.findIndex((s) => (Number(s.energy) || 0) > 0.8);
    if (quiet < 0 && loud < 0) {
      quiet = 0;
      loud = form.length - 1;
    }
    remarks.push({
      id: 'flat-energy',
      kind: REMARK_KINDS.FLAT_ENERGY,
      label: 'Энергия плоская',
      hint:
        `Размах энергии ${energy.range.toFixed(2)} — секции почти неразличимы. ` +
        (quiet >= 0
          ? `Сделай секцию «${form[quiet].kind}» тише (энергия 0.3). `
          : 'Опусти энергию первой секции до 0.3. ') +
        (loud >= 0
          ? `Подними «${form[loud].kind}» до 0.9.`
          : 'Подними энергию кульминационной секции до 0.9.'),
      action: { type: 'reshape-energy', quietIndex: quiet, loudIndex: loud },
    });
  }

  // --- 3. Повторяющаяся партия ---
  // Роль, рисунок которой не меняется от секции к секции: если во всех
  // секциях у роли один и тот же recipe и нет явного variant — партия
  // звучит как один длинный цикл.
  const roleRecipes = new Map();
  form.forEach((section, sectionIndex) => {
    for (const [role, choice] of Object.entries(section.roles || {})) {
      const key = `${choice.recipe || 'default'}|${choice.variant || ''}`;
      if (!roleRecipes.has(role)) roleRecipes.set(role, []);
      roleRecipes.get(role).push({ section, sectionIndex, key });
    }
  });
  for (const [role, entries] of roleRecipes.entries()) {
    if (entries.length < 2) continue;
    const variants = new Set(entries.map((e) => e.key));
    if (variants.size === 1) {
      const first = entries[0].section;
      const last = entries[entries.length - 1].section;
      remarks.push({
        id: `repeated-part:${role}`,
        kind: REMARK_KINDS.REPEATED_PART,
        label: `Партия «${role}» не меняется`,
        hint:
          `«${role}» играет один и тот же рисунок от «${first.kind}» до «${last.kind}». ` +
          `Задай другой variant (A/B/C) в следующих секциях или смени recipe на busy/sparse.`,
        // Правка начинается со секции ПОСЛЕ первой: первая задаёт
        // рисунок, дальше — отличия от него.
        action: { type: 'vary-part', role, fromSection: entries[0].sectionIndex },
      });
    }
  }

  // --- 4. Секции без перехода ---
  const transitionKinds = new Set(['drop', 'chorus', 'breakdown']);
  for (let i = 0; i < form.length - 1; i += 1) {
    const section = form[i];
    const next = form[i + 1];
    if (section.transition) continue;
    if (!transitionKinds.has(next.kind)) continue;
    remarks.push({
      id: `missing-transition:${i}`,
      kind: REMARK_KINDS.MISSING_TRANSITION,
      label: `Нет перехода в «${next.kind}»`,
      hint:
        `Секция «${section.kind}» переходит в «${next.kind}» без перехода — ` +
        `трек распадается на куски. Добавь transition: {into: "${next.kind}", type: "riser"}.`,
      action: { type: 'add-transition', sectionIndex: i, into: next.kind },
    });
  }

  // --- 5. Мало партий ---
  const thin = form.findIndex((s) => Object.keys(s.roles || {}).length < 2);
  if (thin >= 0) {
    remarks.push({
      id: 'thin-arrangement',
      kind: REMARK_KINDS.THIN_ARRANGEMENT,
      label: 'Секция почти пустая',
      hint:
        `Секция «${form[thin].kind}» играет ${Object.keys(form[thin].roles || {}).length} партии. ` +
        'Добавь вторую партию — иначе трек проваливается в пустоту.',
      action: { type: 'add-role', sectionIndex: thin },
    });
  }

  // --- 6. Мотив не задан ---
  if (!spec.motif && form.some((s) => s.roles && (s.roles.lead || s.roles.arp))) {
    remarks.push({
      id: 'no-motif',
      kind: REMARK_KINDS.NO_MOTIF,
      label: 'Нет мелодического мотива',
      hint:
        'В треке есть лид или арпеджио, но не задан мотив — мелодия вырождается ' +
        'в повтор верхних ступеней аккорда. Задай motif: {degrees: [...], rhythm: "x ~ x x"}.',
      action: { type: 'add-motif' },
    });
  }

  // Замечания из метрик v2 (если они есть) — дополняют разбор спеки.
  if (Array.isArray(context.extraRemarks)) {
    remarks.push(...context.extraRemarks);
  }

  return remarks;
}

/**
 * Применяет замечание к спеке — возвращает НОВУЮ спеку.
 *
 * Правки детерминированные: одно замечание — одно конкретное изменение.
 * Так же, как и смена рецепта, выбор варианта делается по индексу
 * секции, а не случайно.
 *
 * @param {object} spec спека
 * @param {object} remark замечание из collectRemarks
 * @returns {object} новая спека
 */
export function applyRemark(spec, remark) {
  if (!spec || !remark) return spec;
  const next = {
    ...spec,
    meta: { ...spec.meta },
    harmony: { ...spec.harmony },
    form: spec.form.map((section) => ({
      ...section,
      roles: { ...(section.roles || {}) },
      ...(section.transition ? { transition: { ...section.transition } } : {}),
      ...(section.progressionOverride
        ? { progressionOverride: { ...section.progressionOverride } }
        : {}),
    })),
  };

  switch (remark.action?.type) {
    case 'change-progression': {
      const index = remark.action.sectionIndex;
      const section = next.form[index];
      if (!section) break;
      // Сдвиг на две ступени по кругу лада — гарантированно в ладу.
      const base = spec.harmony?.degrees || [0, 5, 2, 6];
      const shifted = base.map((d) => (d + 2) % 7);
      section.progressionOverride = {
        degrees: shifted,
        mode: spec.harmony?.mode || 'minor',
        barsPerChord: spec.harmony?.barsPerChord || 2,
      };
      break;
    }

    case 'reshape-energy': {
      const quiet = remark.action.quietIndex;
      const loud = remark.action.loudIndex;
      if (quiet >= 0 && next.form[quiet]) next.form[quiet].energy = 0.3;
      if (loud >= 0 && next.form[loud]) next.form[loud].energy = 0.9;
      break;
    }

    case 'vary-part': {
      const role = remark.action.role;
      const from = remark.action.fromSection;
      // Начиная со секции ПОСЛЕ указанной — другой вариант рисунка.
      for (let i = from + 1; i < next.form.length; i += 1) {
        const choice = next.form[i].roles?.[role];
        if (!choice) continue;
        const current = String(choice.variant || '').toUpperCase();
        const order = ['A', 'B', 'C'];
        const index = order.indexOf(current);
        next.form[i].roles[role] = {
          ...choice,
          variant: order[(index + 1) % order.length],
        };
      }
      break;
    }

    case 'add-transition': {
      const index = remark.action.sectionIndex;
      const section = next.form[index];
      if (!section) break;
      section.transition = {
        into: remark.action.into,
        type: 'riser',
      };
      break;
    }

    case 'add-role': {
      const index = remark.action.sectionIndex;
      const section = next.form[index];
      if (!section) break;
      const used = new Set(Object.keys(section.roles || {}));
      const candidate = ['hats', 'pad', 'texture', 'perc'].find((role) => !used.has(role));
      if (candidate) {
        section.roles[candidate] = { recipe: 'default' };
      }
      break;
    }

    case 'add-motif': {
      next.motif = {
        degrees: [4, 2, 0, 2],
        rhythm: 'x ~ x x',
        transforms: ['sequence'],
      };
      break;
    }

    default:
      break;
  }

  return next;
}
