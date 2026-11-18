// Единый объект API @strudel/web в форме, которую ждёт адаптер движка.
// Живая студия (src/strudel-engine.js) и изолированный рендер
// (src/render-realm.js) обязаны передавать адаптеру ОДИН И ТОТ ЖЕ набор
// функций — иначе пути разойдутся по поведению (инвариант D-104).

import {
  initStrudel,
  evaluate,
  hush,
  getAudioContext,
  setAudioContext,
  getSuperdoughAudioController,
  setSuperdoughAudioController,
  initAudio,
  registerSynthSounds,
  superdough,
  samples,
  loadBuffer,
} from '@strudel/web';

export const strudelApi = {
  initStrudel,
  evaluate,
  hush,
  getAudioContext,
  setAudioContext,
  getSuperdoughAudioController,
  setSuperdoughAudioController,
  initAudio,
  registerSynthSounds,
  superdough,
  samples,
  loadBuffer,
};