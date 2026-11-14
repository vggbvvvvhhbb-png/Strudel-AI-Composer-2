// Справочники ударных: имя сэмпла Strudel и роль партии по нотам General MIDI.
//
// ОТДЕЛЬНЫЙ ФАЙЛ — чтобы таблицей пользовались и сетка (grid.js), и сборка
// ролей (roles.js) без циклического импорта: справочник ни от чего не
// зависит, поэтому стоит в самом низу графа зависимостей.

// Имена сэмплов Strudel по нотам General MIDI.
// Источник — реестр банка server/music/data/sample-banks.json (dirt-samples).
// Не выдумываем имён: неизвестное имя молча выпадает из звука.
export const GM_TO_SAMPLE = {
  35: 'bd',   // acoustic bass drum
  36: 'bd',   // bass drum 1
  37: 'sd',   // side stick
  38: 'sd',   // snare 1
  39: 'cp',   // hand clap
  40: 'sd',   // snare 2
  42: 'hh',   // closed hi-hat
  44: 'hh',   // pedal hi-hat
  46: 'oh',   // open hi-hat
  49: 'crash',
  51: 'ride',
  53: 'rim',
};

// Роли ударных по нотам GM. Всё остальное ударное — в «perc».
export const GM_TO_ROLE = {
  36: 'kick', 35: 'kick',
  38: 'snare', 40: 'snare', 37: 'snare',
  42: 'hats', 44: 'hats', 46: 'hats',
};
