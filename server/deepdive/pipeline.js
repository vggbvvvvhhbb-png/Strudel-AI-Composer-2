// Пайплайн режима «Разбор» — фасад.
//
// Сама логика разбита по этапам в ./pipeline/:
//   analyze.js  — измерения по миксу;
//   stems.js    — разделение на стемы и дескрипторы слоёв;
//   render.js   — рендер двойника и его слоёв;
//   compare.js  — сравнение с оригиналом;
//   helpers.js  — общие утилиты;
//   constants.js— что мы считаем слоем и ролью.
//
// Этот файл оставлен как фасад, чтобы старые импорты
// ('../deepdive/pipeline.js') продолжали работать.

export {
  PIPELINE_VERSION,
  SCHEMA_VERSION,
  BASE_CAVEATS,
  runDeepDive,
  buildReference,
  bassNotesFromPlan,
} from './pipeline/index.js';
