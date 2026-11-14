---
id: genre-dnb
version: 1.0.0
kind: genre
tags: [dnb, drum-and-bass, jungle, liquid, neuro]
refs: [emotion-map, groove-templates, harmony-recipes, arrangement-arcs, mix-roles]
paramRanges: { bpm: [168, 178], lufsTarget: [-13, -10], density: [13, 20], crest: [5, 8] }
compact: true
scoreHistory: []
---

## COMPACT
dnb: 168–178 (дефолт 174), halftime-ощущение при быстром темпе. mood anger|dark|euphoria(liquid).
Барабаны: two-step — kick 0,10; snare 4,12 (16-шаговая сетка); hats 16-е
vel .7/.35/.5/.35, degrade .06; слой брейка (amen splice) gain .3–.4. groove: halftime.
Бас: суб-синус f1 + reese-слой (supersaw, lpf-автоматизация 200–1200 slow(8), seg 16).
Гармония: liquid — m9/^9 (Fm9 Db^9 Ab^9 Eb9), смена 2–4 такта, пэды triangle att .4 rel 2;
dark — i–bII, минимум гармонии, максимум баса.
arc: club-64 (intro 16 → build 16 → drop 16 → break 8 → drop2 8). LUFS −12±1, crest 5–8.
Снейр — король: плотный, сухой, строго на сетке. Бас моно.

## RECIPE
### Палитра
| роль | основной | fallback |
|---|---|---|
| kick/snare | RolandTR909 | 808 + distort |
| break | clean-breaks amen | только 909 |
| sub | sine | triangle lpf 120 |
| reese | supersaw + lpf LFO | sawtooth ×2 detune |
| pads | triangle | gm_string_ensemble_1 lpf 2000 |
### Приёмы жанра
- Two-step — это НЕ four-on-floor: кик на 0 и 10, снейр 4 и 12. Ошибка = жанр сломан.
- Reese: supersaw уже детюнен; движение = lpf LFO, не громкость; `.seg(16)` обязательно.
- Брейк-слой: `.splice(8,"0 1 2 3 <4 4*2> 5 6 7")`, lpf 5000, gain .35 — текстура под китом.
- Drop: после break 8 тактов — всё сразу + бас на полную; перед дропом 1 такт тишины.
- Liquid-вайб: m9-аккорды + мягкие пэды + вокал-подобный лид (vowel «a/e» на saw, опц.).
### Аранжировка
club-64: intro (хэты+атмос) → build (+снейр-ролл, riser) → drop (всё) → break
(−ударные, пэды+вокал) → drop2 (всё + вариация баса). DJ-friendly: фразы по 16.

## EXAMPLES
```js
// dnb • 174 BPM • F minor (liquid-dark) • smoke: 0 clips, lint 0 errors
setcpm(174/4)
samples('github:yaxu/clean-breaks/main')
$: s("bd").beat("0,10",16).bank("RolandTR909").gain(.95).orbit(1)
   .duckorbit(2).duckdepth(.5).duckattack(.08)
$: s("sd").beat("4,12",16).bank("RolandTR909").gain(".9 .85").room(.1).size(1).orbit(1)
$: s("hh*16").bank("RolandTR909").gain(".7 .35 .5 .35").degradeBy(.06).orbit(1)
$: s("amen/4").fit().splice(8, "0 1 2 3 <4 4*2> 5 6 7")
   .lpf(5000).gain(.35).orbit(1)
$: note("f1").s("sine").gain(.75).orbit(2)
$: note("f1").s("supersaw").lpf(sine.range(200, 1200).slow(8)).seg(16)
   .gain(.35).orbit(2)
$: chord("<Fm9 Db^9 Ab^9 Eb9>/2").dict('ireal').voicing().anchor("c4")
   .s("triangle").attack(.4).release(2).lpf(2000)
   .room(.35).size(3).gain(.4).orbit(3)
```

## DO / DON'T
DO: two-step; снейр на сетке; reese с LFO+seg; суб отдельно моно; фразы 16 тактов.
DON'T: four-on-floor (это house); свинг на снейре; бас в стерео; плотность <13/с
(будет пусто); break без снятия ударных.

## MEASURE
LUFS −12±1, crest 5–8, плотность 13–20/с; lint: kick-позиции {0,10}, snare {4,12};
A/B: «злой быстрый dnb», «агрессивный фонк».

## EVOLVE
Можно: bpm ±3, reese lpf-диапазон, break-паттерны, duckdepth ±.1.
Заморожено: two-step, snare on-grid, моно-бас, фразы 16.
