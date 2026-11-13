// Версии аудио-стека.
//
// Значение попадает в MetricsReport.engineVersion — по нему метрики всегда
// можно связать с тем, на какой версии движка они посчитаны.
//
// Правило: аудио-пакеты запинены ТОЧНО (без ^ и ~). Минорное обновление
// @strudel/web может изменить и DSP, и API — поэтому оно обязано ломать
// контрактные тесты (tests/unit/engine-contract.test.js), а не молча менять звук.

export const ENGINE_VERSION = Object.freeze({
  strudelWeb: '1.3.0',
  strudelCore: '1.2.6',
  superdough: '1.3.0',
});

/** Строка для отчётов и логов: `strudel-web@1.3.0/superdough@1.3.0`. */
export const ENGINE_VERSION_STRING = `strudel-web@${ENGINE_VERSION.strudelWeb}/superdough@${ENGINE_VERSION.superdough}`;
