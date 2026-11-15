// Почему сдвиг регистра меняет громкость? Измеряем, а не гадаем.

import { createRenderWorker } from '../server/deepdive/render/render-worker.mjs';

const worker = await createRenderWorker();

const variants = [
  { name: 'без сдвига', code: 'setCpm(120/4)\nconst A = n("0 ~ 2 ~").scale("c:minor").s("sawtooth")\n$A: arrange([4, A])._pianoroll()' },
  { name: 'сдвиг -12', code: 'setCpm(120/4)\nconst A = n("0 ~ 2 ~").scale("c:minor").transpose(-12).s("sawtooth")\n$A: arrange([4, A])._pianoroll()' },
  { name: 'сдвиг -24', code: 'setCpm(120/4)\nconst A = n("0 ~ 2 ~").scale("c:minor").transpose(-24).s("sawtooth")\n$A: arrange([4, A])._pianoroll()' },
  { name: 'сдвиг +12', code: 'setCpm(120/4)\nconst A = n("0 ~ 2 ~").scale("c:minor").transpose(12).s("sawtooth")\n$A: arrange([4, A])._pianoroll()' },
  { name: 'sine без сдвига', code: 'setCpm(120/4)\nconst A = n("0 ~ 2 ~").scale("c:minor").s("sine")\n$A: arrange([4, A])._pianoroll()' },
  { name: 'sine -12', code: 'setCpm(120/4)\nconst A = n("0 ~ 2 ~").scale("c:minor").transpose(-12).s("sine")\n$A: arrange([4, A])._pianoroll()' },
];

for (const variant of variants) {
  const render = await worker.render({ code: variant.code, fromCycle: 0, toCycle: 4, wantEvents: false });
  const r = render.report ?? {};
  console.log(
    `${variant.name.padEnd(20)} LUFS ${String(r.lufsI?.toFixed(2)).padStart(7)}  пик ${String(r.truePeakDbtp?.toFixed(2)).padStart(7)}  событий ${render.events?.length ?? '—'}`,
  );
}

await worker.close();
