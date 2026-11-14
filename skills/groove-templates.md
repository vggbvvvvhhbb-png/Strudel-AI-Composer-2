---
id: groove-templates
version: 1.0.0
kind: groove
tags: [groove, microtiming, swing, velocity, humanize]
refs: [mix-roles]
paramRanges: { offsetMs: [-20, 20], swingRatio: [0.5, 0.68], velocity: [0.2, 1.0] }
compact: true
scoreHistory: []
---

## COMPACT
Грув = структурированные микросмещения + velocity, НЕ равномерный рандом.
Конверсия: `const ms = x => x * (BPM/4) / 60000` (late/early в циклах!).
Свинг: `swingBy(2*swingRatio−1, n)`, n = пар шагов на цикл (16-е → n=8).
56% → swingBy(.12, 8); 54% → .08; триоль 66.7% → swing(8).
Якоря: кик на 0 и снейр на 4/12 — в пределах ±14 мс от сетки, всегда.
Шаблоны (16 шагов; offset мс / velocity):
- straight-16: offsets 0; vel акценты 1/.75/.5 (доли/восьмые/16-е).
- swing-16: нечётные 16-е +step*(2s−1); vel .9/.55 чередование.
- laid-back: snare +12, hats +6, kick 0; ghost snare vel .3.
- funk: kick 0,7,10; snare 4,12 + ghosts 7,15 vel .25–.35; oh на 14.
- halftime: kick 0,10; snare 4,12; hats 16-е vel .7/.35/.5/.35.
- drunken: kick 0/+0, 7/+6, 10/−4; snare 4/+12, 12/+9; hats swing 54–58% + degrade .1.
Дыхание: каждый 4-й такт vel×.85; каждый 8-й — филл в последней четверти.
Литература по микротаймингу противоречива → любой шаблон живёт только пока выигрывает A/B.

## RECIPE
### Формулы
- 16-я нота, мс: step = 60000/BPM/4. (82→183; 78→192; 90→167; 118→127; 174→86)
- Свинг: offbeat задержка = step*(2s−1). 56% при 90 BPM = 167*.12 ≈ 20 мс.
- swingBy(x,n): x относительно ПОЛОВИНЫ слайса; x = 2s−1; n = число пар.
- late(ms(12)) — сдвиг вперёд; early(ms(4)) — назад (rush).

### Таблицы (шаг: offset/vel)
straight-16 hats: 0:0/1.0 1:0/.5 2:0/.75 3:0/.5 4:0/1.0 ... (повтор каждые 4)
laid-back: snare 4:+12/.9, 12:+10/.85; hats все +6, vel .6/.4; kick 0.
funk: kick 0:0/1.0, 7:+3/.8, 10:0/.85; snare 4:0/.95, 12:0/.9,
      ghost 7:0/.3, 15:+4/.25; hats 16-е .7/.4, oh 14:0/.6.
halftime: kick 0:0/1.0, 10:0/.9; snare 4:0/.95, 12:0/.9;
      hats 16-е .7/.35/.5/.35, ±2 мс фикс-карта (не рандом!).
drunken: как COMPACT; hats degradeBy(.08–.12), vel-карта «пьяная» .65/.3/.55/.4.

### Филлы и дыхание
- Филл (каждый 8-й цикл, последняя четверть):
  `s("sd*4").compress(.75,1).gain(".45 .6 .75 .95").mask("<0!7 1>")`
- Дыхание: на 4-м такте фразы `.gain(x*0.85)`; перед филлом убрать последний хэт.
- Ghost-ноты: тихие снейры между якорями (vel ≤ .35), не чаще 2 на такт.

### Guardrails
|offset| ≤ 20 мс; якоря ±14 мс; velocity ∈ [.2,1]; degrade ≤ .15;
никакого rand на каждый ивент без seed — только фикс-карты или seeded rand.

## EXAMPLES
```js
// swing-16 + laid-back snare + дыхание (90 BPM)
setcpm(90/4)
const ms = x => x * (90/4) / 60000
$: s("bd").beat("0,10",16).bank("RolandTR909").gain(.95).orbit(1)
$: s("sd").beat("4,12",16).bank("RolandTR909").late(ms(12))
   .gain(".9 .85").every(4, x => x.gain(.72)).orbit(1)
$: s("hh*16").bank("RolandTR909").swingBy(.12, 8)
   .gain(".7 .4 .55 .4").degradeBy(.08).orbit(1)
$: s("sd*4").compress(.75,1).gain(".45 .6 .75 .95")
   .mask("<0!7 1>").bank("RolandTR909").orbit(1)
```

## DO / DON'T
DO: фикс-карты; якоря плотно; свинг только на перкуссии/хэтах; филл раз в 8.
DON'T: джиттер на бас/аккорды (грязь, не грув); swing > .68; одинаковый velocity
на всех 16 хэтах (робот); рандом без seed (ломает бит-в-бит рендер).

## MEASURE
- Рендер: maxAbsDiff=0 при повторе (seeded!).
- A/B: тот же трек straight vs шаблон, 5 пар на жанр, цель ≥60%.
- Метрика-кандидат: std межударных интервалов хэтов (должна быть >0 и <15 мс).

## EVOLVE
Можно: offsets ±2 мс, velocity ±.05, swingRatio ±.02, частота филлов.
Заморожено: guardrails, якорные правила, seed-политика.
