// Справочники ударных: имя сэмпла Strudel и роль партии по нотам General MIDI.
//
// ОТДЕЛЬНЫЙ ФАЙЛ — чтобы таблицей пользовались и сетка (grid.js), и сборка
// ролей (roles.js) без циклического импорта: справочник ни от чего не
// зависит, поэтому стоит в самом низу графа зависимостей.
//
// ГЛАВНОЕ ПРАВИЛО. Каждое имя здесь обязано быть в реестре банков
// (server/music/data/sample-banks.json). Сэмпла, которого нет в банке, нет и
// в звуке: движок пишет «sound <имя> not found! Is it loaded?» и рендер
// двойника падает целиком. Раньше здесь стояли `oh`, `crash`, `ride`, `rim` —
// таких имён в банке нет, и 4-минутный разбор падал на рендере.
//
// Открытый хайхет в банке — `808oh`, тарелка — `cr`. Отдельных сэмплов ride и
// rim в банке нет: для ride берём тарелку, для rim — общий перкуссионный
// `perc` (роль роли не меняет: это всё равно «perc» в разбивке по ролям).
export const GM_TO_SAMPLE = {
  35: 'bd',   // acoustic bass drum
  36: 'bd',   // bass drum 1
  37: 'sd',   // side stick
  38: 'sd',   // snare 1
  39: 'cp',   // hand clap
  40: 'sd',   // snare 2
  42: 'hh',   // closed hi-hat
  44: 'hh',   // pedal hi-hat
  46: '808oh',// open hi-hat
  49: 'cr',   // crash cymbal
  51: 'cr',   // ride cymbal — отдельного сэмпла нет
  53: 'perc', // rimshot — отдельного сэмпла нет
};

// Роли ударных по нотам GM. Всё остальное ударное — в «perc».
export const GM_TO_ROLE = {
  36: 'kick', 35: 'kick',
  38: 'snare', 40: 'snare', 37: 'snare',
  42: 'hats', 44: 'hats', 46: 'hats',
};

// Имена ударных, которые есть в банке. Список взят из того же реестра, что и
// в server/music/extract.js: без него метка удара (`label`) могла бы попасть в
// код как имя сэмпла — и сломать рендер так же, как сломал `oh`.
export const DRUM_SAMPLE_NAMES = new Set([
  'bd', 'sd', 'hh', 'hh27', 'cp', 'perc', 'rm', 'cb', 'odx', 'ho',
  '808', '808bd', '808sd', '808oh', '808mc', '808ht', '808lc', '909',
  'breaks125', 'breaks152', 'breaks157', 'breaks165', 'realclaps',
  'rave', 'gab', 'industrial', 'jungle', 'techno', 'dr', 'dr2', 'dr55', 'house',
]);

/**
 * Имя сэмпла для удара: гарантированно существующее в банке.
 *
 * Порядок: нота GM → метка удара (если она есть в банке) → `perc`.
 * Ни одна ветка не может вернуть имя, которого нет в банке, — иначе рендер
 * двойника упадёт с «sound ... not found».
 *
 * @param {{gm?:number, label?:string}} hit
 * @returns {string}
 */
export function sampleNameForHit(hit) {
  const byGm = GM_TO_SAMPLE[hit?.gm];
  if (byGm) return byGm;
  const label = typeof hit?.label === 'string' ? hit.label : '';
  return DRUM_SAMPLE_NAMES.has(label) ? label : 'perc';
}
