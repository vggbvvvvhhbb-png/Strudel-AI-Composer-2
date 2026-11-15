// Что означает @ в mini-нотации этой версии Strudel?
//
// Мотивы оркестра должны держать звук (половинная, целая), а не и��ить
// шестнадцатыми с тишиной после. Прежде чем строить мотив на длительностях,
// измеряем: сколько длится нота при @1, @2, @4 и как это соотносится с
// длиной такта.

import { createRenderWorker } from '../server/deepdive/render/render-worker.mjs';

const worker = await createRenderWorker();

const variants = [
  { name: 'без @', code: 'setCpm(120/4)\nconst A = n("0 2 4 ~").scale("c:minor").s("sine")\n$A: arrange([4, A])._pianoroll()' },
  { name: '@1', code: 'setCpm(120/4)\nconst A = n("0@1 2@1 4@1 ~").scale("c:minor").s("sine")\n$A: arrange([4, A])._pianoroll()' },
  { name: '@2', code: 'setCpm(120/4)\nconst A = n("0@2 2@2 ~").scale("c:minor").s("sine")\n$A: arrange([4, A])._pianoroll()' },
  { name: '@4', code: 'setCpm(120/4)\nconst A = n("0@4").scale("c:minor").s("sine")\n$A: arrange([4, A])._pianoroll()' },
];

for (const variant of variants) {
  const render = await worker.render({ code: variant.code, fromCycle: 0, toCycle: 1, wantEvents: true });
  const events = render.events ?? [];
  const times = events
    .map((event) => Number(event.begin ?? event.time ?? 0))
    .sort((a, b) => a - b);
  console.log(`${variant.name.padEnd(8)} событий ${events.length}: ${times.map((t) => t.toFixed(3)).join(', ')}`);
}

await worker.close();
