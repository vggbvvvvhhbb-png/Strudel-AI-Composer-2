// Разнообразие на уровне спеки: отпечаток, расстояние и порог отсечения.
//
// Зачем это отдельным модулем: компилятор отвечает за ЗВУК спеки, а здесь мы
// отвечаем на вопрос «а это вообще другой трек?». Разные варианты должны
// отличаться структурно (форма, гармония, состав партий), иначе «ещё вариант»
// будет тем же треком с другим зерном.
//
// Метрика расстояния — взвешенная доля различий по пяти независимым
// составляющим. Каждая составляющая лежит в [0, 1], веса в сумме дают 1,
// поэтому расстояние тоже лежит в [0, 1] и читается как «доля несхожести».
// Расстояние НЕ метрика в строгом смысле (не симметрично-транзитивно по
// построению через выравнивание по индексу), но для отсечения повторов это
// и не требуется: нужен порядок «похоже / не похоже», а не метрика.
//
// Отпечаток — три составляющие: форма, гармония и рисунки ролей.
// Это «скелет» варианта: если он совпал, вариант отличается только мелочами
// (мотив, энергия) и как отдельный трек не считается.

/**
 * Устойчивый хэш строки (FNV-1a) — тот же алгоритм, что в компиляторе.
 *
 * Хэш, а не PRNG: результат best-of-N обязан воспроизводиться по зерну
 * (D-018). Кроме того, хэш не зависит от порядка обхода — добавление
 * кандидата не сдвигает остальные.
 *
 * @param {string} text
 * @returns {number} 32-битное беззнаковое число
 */
export function hashText(text) {
  let hash = 2166136261;
  const str = String(text ?? '');
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Веса составляющих расстояния. Сумма = 1, иначе расстояние вышло бы
 * за [0, 1].
 *
 * form     — самая крупная составляющая: смена формы меняет сам трек;
 * harmony  — смена строк гармонии меняет гармонический материал;
 * roles    — состав партий и рисунки (то, что слышно как аранжировка);
 * motif    — мелодический материал: у лида свой рисунок;
 * energy   — арка энергии секций (влияет на плотность через D-017).
 */
export const DISTANCE_WEIGHTS = {
  form: 0.3,
  harmony: 0.22,
  roles: 0.28,
  energy: 0.08,
  motif: 0.12,
};

/**
 * Порог отсечения «это тот же трек».
 *
 * Сохраняем прежний порог и веса при переходе на канонические поля;
 * калибровка значения под новые рисунки партий — отдельная задача.
 */
export const MIN_DISTANCE = 0.1;

/** Глубокая копия спеки: дальше всё работает с копией, оригинал не трогаем. */
export function cloneSpec(spec) {
  return JSON.parse(JSON.stringify(spec));
}

/**
 * Канонический JSON: ключи объектов отсортированы.
 *
 * Нужен для честного сравнения «спека изменилась»: порядок ключей после
 * разбора JSON не значим, а сравнение строк без сортировки давало бы
 * ложные различия.
 *
 * @param {*} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

/**
 * Две спеки совпадают по содержанию (порядок ключей не учитывается).
 * @param {object} a
 * @param {object} b
 */
export function sameSpec(a, b) {
  return canonicalJson(a) === canonicalJson(b);
}

/** Упорядоченные секции; индекс различает одноимённые секции. */
function sectionsOf(spec) {
  return spec?.structure?.sections || [];
}

/** Состав партии, действующий во всех секциях с указанным именем. */
function roleSignature(role, part) {
  return `${role}=${part.pattern}:${part.sound}:${canonicalJson(part.effects || [])}`;
}

function rolesInSection(spec, section) {
  return Object.entries(spec?.parts?.roles || {})
    .filter(([, part]) => part.activeIn.includes(section.name))
    .sort(([a], [b]) => a.localeCompare(b, 'en'));
}

/**
 * Декомпозиция спеки на три составляющие отпечатка.
 *
 * Отдельная функция, чтобы объяснять пользователю, ЧЕМ именно вариант
 * отличается от исходного, а не просто «другим хэшем».
 *
 * @param {object} spec
 * @returns {{form: string, harmony: string, recipes: string}}
 */
export function specFingerprintParts(spec) {
  const sections = sectionsOf(spec);
  const form = sections
    .map((section) => `${section.name}:${section.cycles}:${round2(section.energy)}`)
    .join('|');
  const harmony = sections.map((section) => section.harmony).join('|');
  const recipes = sections
    .map((section) => rolesInSection(spec, section)
      .map(([role, part]) => roleSignature(role, part)).join(','))
    .join('|');
  return { form, harmony, recipes };
}

/**
 * Отпечаток спеки: короткая строка по трём составляющим ТЗ
 * (форма + гармония + рисунки ролей).
 *
 * @param {object} spec
 * @returns {string} например `fp-1a2b3c`
 */
export function specFingerprint(spec) {
  const parts = specFingerprintParts(spec);
  const text = `${parts.form}||${parts.harmony}||${parts.recipes}`;
  return `fp-${hashText(text).toString(36)}`;
}

/** Округление до двух знаков — чтобы 0.3 и 0.30 не считались различием. */
function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

/**
 * Различие форм: доля секций, которые не совпали, плюс разница длин.
 *
 * Секции выравниваются по индексу: сравнение «по смыслу» (например, intro
 * с intro) дало бы слишком мягкую метрику — трек с переставленными
 * секциями это другой трек.
 */
function formDistance(a, b) {
  const formA = sectionsOf(a);
  const formB = sectionsOf(b);
  const max = Math.max(formA.length, formB.length);
  if (!max) return 0;
  let diff = Math.abs(formA.length - formB.length);
  const common = Math.min(formA.length, formB.length);
  for (let i = 0; i < common; i += 1) {
    if (formA[i].name !== formB[i].name || formA[i].cycles !== formB[i].cycles) diff += 1;
  }
  return Math.min(1, diff / max);
}

/**
 * Различие гармонии: общая последовательность и строки отдельных секций.
 * Совпадающие имена секций различаются позицией в последовательности.
 */
function harmonyDistance(a, b) {
  const formA = sectionsOf(a);
  const formB = sectionsOf(b);
  const max = Math.max(formA.length, formB.length) || 1;
  let diff = 0;
  for (let i = 0; i < max; i += 1) {
    if (formA[i]?.harmony !== formB[i]?.harmony) diff += 1;
  }
  // Общая гармония доминирует, локальное отличие секции учитывается отдельно.
  const base = formA.map((section) => section.harmony).join('|') ===
    formB.map((section) => section.harmony).join('|') ? 0 : 1;
  return 0.7 * base + 0.3 * (diff / max);
}

/**
 * Различие состава партий и их рецептов.
 *
 * Считается по объединению ключей «индекс секции:роль»: и исчезновение роли,
 * и смена рисунка дают одно и то же различие, а не две разные метрики.
 */
function rolesDistance(a, b) {
  const mapA = new Map();
  const mapB = new Map();
  sectionsOf(a).forEach((section, index) => {
    for (const [role, part] of rolesInSection(a, section)) {
      mapA.set(`${index}:${role}`, roleSignature(role, part));
    }
  });
  sectionsOf(b).forEach((section, index) => {
    for (const [role, part] of rolesInSection(b, section)) {
      mapB.set(`${index}:${role}`, roleSignature(role, part));
    }
  });
  const keys = new Set([...mapA.keys(), ...mapB.keys()]);
  if (!keys.size) return 0;
  let diff = 0;
  for (const key of keys) {
    if (mapA.get(key) !== mapB.get(key)) diff += 1;
  }
  return diff / keys.size;
}

/** Различие арки энергии: среднее расстояние энергий по секциям. */
function energyDistance(a, b) {
  const formA = sectionsOf(a);
  const formB = sectionsOf(b);
  const max = Math.max(formA.length, formB.length);
  if (!max) return 0;
  let sum = 0;
  for (let i = 0; i < max; i += 1) {
    const ea = Number(formA[i]?.energy ?? 0.5);
    const eb = Number(formB[i]?.energy ?? 0.5);
    sum += Math.abs(ea - eb);
  }
  return sum / max;
}

/** Различие мелодического материала по рисунку канонической партии lead. */
function motifDistance(a, b) {
  const leadA = a?.parts?.roles?.lead?.pattern;
  const leadB = b?.parts?.roles?.lead?.pattern;
  if (!leadA && !leadB) return 0;
  if (!leadA || !leadB) return 1;
  if (leadA === leadB) return 0;
  return leadA.split(/\s+/).length === leadB.split(/\s+/).length ? 0.5 : 1;
}

/**
 * Разложение расстояния по составляющим — для объяснений и отладки.
 * @param {object} a
 * @param {object} b
 * @returns {{form: number, harmony: number, roles: number, energy: number, motif: number, total: number}}
 */
export function distanceBreakdown(a, b) {
  const parts = {
    form: formDistance(a, b),
    harmony: harmonyDistance(a, b),
    roles: rolesDistance(a, b),
    energy: energyDistance(a, b),
    motif: motifDistance(a, b),
  };
  let total = 0;
  for (const [key, weight] of Object.entries(DISTANCE_WEIGHTS)) {
    total += weight * parts[key];
  }
  parts.total = Math.max(0, Math.min(1, total));
  return parts;
}

/**
 * Расстояние между двумя спеками: 0 — совпадают, 1 — не имеют ничего
 * общего.
 *
 * @param {object} a
 * @param {object} b
 * @returns {number} число в [0, 1]
 */
export function specDistance(a, b) {
  if (!a || !b) return 1;
  if (sameSpec(a, b)) return 0;
  return distanceBreakdown(a, b).total;
}

/**
 * Слишком ли похожи две спеки.
 *
 * @param {object} a
 * @param {object} b
 * @param {number} [threshold] по умолчанию MIN_DISTANCE
 * @returns {boolean}
 */
export function tooSimilar(a, b, threshold = MIN_DISTANCE) {
  return specDistance(a, b) < threshold;
}
