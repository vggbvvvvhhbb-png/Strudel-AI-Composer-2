---
id: genre-synthpop
version: 1.0.0
kind: genre
tags: [synthpop, pop, bright, dance, retro]
refs: [emotion-map, groove-templates, harmony-recipes, arrangement-arcs, mix-roles]
paramRanges: { bpm: [105, 128], lufsTarget: [-15, -13], density: [9, 14], crest: [6, 9] }
compact: true
scoreHistory: []
---

## COMPACT
synthpop: 105–128 (дефолт 118), major или светлый minor, mood joy|euphoria|hope.
Барабаны: four-on-floor bd*4 (TR707), clap 2/4, hats 8-е с акцентами, oh оффбит.
groove: straight-16, offsets 0 (жанр про машину, не про пыль).
Бас: оффбит-восьмые («~ x ~ x ~ x ~ x»), sawtooth, lpf 400–700 + lpenv 3 lpd .12 (плак).
Аккорды: supersaw, войсинг anchor c4, lpf-автоматизация 1200–2600 slow(8), sidechain.
Лид/арп: square, 16-е, scale-номера, delay восьмая .254с при 118, feedback .3.
Хук обязателен: 4–8 нот, повторяется ≥4 раза за трек, запоминается.
arc: song-64 (или club-64 для «фестиваля»). LUFS −14, crest 6–9.

## RECIPE
### Палитра
| роль | основной | fallback |
|---|---|---|
| drums | RolandTR707 | RolandTR909 |
| bass | sawtooth + lpenv | gm_synth_bass_1 |
| chords | supersaw | sawtooth ×2 detune (superimpose add .07) |
| arp/lead | square lpf 3000 | triangle + delay |
| fx | pink riser | white hpf sweep |
### Приёмы жанра
- Плак-бас: `.lpf(500).lpq(6).lpenv(3).lpd(.12)` — фильтр «чпокает» на каждой ноте.
- Sidechain-кач: кик duckorbit("2:3") depth .8/.35 attack .12/.18 — сердце жанра.
- Арп: `n("0 2 4 7 4 2").scale("A:minor").fast(2)`; каждые 8 тактов `.every(8,
  x=>x.add(note(12)))` — октавный lift.
- Хук: строится на 1–2 аккордовых тонах + passing; ритм хука = синкопа на «и» 2-й доли.
- Gates/ритм-пэды: `.tremsync(4).tremolodepth(.6).tremoloskew(1)` (опционально).
### Аранжировка
song-64: intro (chords+arp) → verse (+bass+kick) → build (hats 16-е, riser, lpf↑) →
peak (всё + хук) → break (−kick−bass, chords+vox-подобный лид) → outro.

## EXAMPLES
```js
// synthpop • 118 BPM • A minor (светлый) • smoke: 0 clips, lint 0 errors
setcpm(118/4)
$: s("bd*4").bank("RolandTR707").gain(.95).orbit(1)
   .duckorbit("2:3").duckdepth("0.8:0.35").duckattack("0.12:0.18")
$: s("~ cp ~ cp").bank("RolandTR707").gain(.7).room(.15).size(1).orbit(1)
$: s("hh*8").bank("RolandTR707").gain(".5 .8").pan("<.4 .6>").orbit(1)
$: s("~ oh ~ oh").bank("RolandTR707").gain(.45).orbit(1)
$: "<Am7 F^7 C^7 G>".rootNotes(2).struct("~ x ~ x ~ x ~ x").note()
   .s("sawtooth").lpf(500).lpq(6).lpenv(3).lpd(.12).gain(.7).orbit(2)
$: chord("<Am7 F^7 C^7 G>").voicing().anchor("c4").s("supersaw")
   .lpf(sine.range(1200, 2600).slow(8)).seg(8)
   .room(.2).size(2).gain(.42).orbit(3)
$: n("0 2 4 7 4 2").scale("A:minor").fast(2).s("square").lpf(3000)
   .delay(.3).delaytime(.254).delayfeedback(.3)
   .every(8, x => x.add(note(12))).gain(.4).orbit(4)
```

## DO / DON'T
DO: оффбит-бас; sidechain; хук повторять; lpf-движение на аккордах; clap на 2/4.
DON'T: свинг (жанр прямой); суб без плака; >2 лида одновременно; break без снятия
кика; арп громче хука.

## MEASURE
LUFS −14±1, crest 6–9, плотность 9–14/с; duck-глубина измерима по RMS-профилю баса;
A/B: «светлый синтипоп для вечеринки», «эйфоричный фестиваль».

## EVOLVE
Можно: bpm ±5, lpf-диапазоны, арп-паттерны, duckdepth ±.1, хук-ритмы.
Заморожено: four-on-floor, оффбит-бас, наличие хука, sidechain.
