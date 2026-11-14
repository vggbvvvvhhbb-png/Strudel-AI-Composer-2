---
id: genre-ambient
version: 1.0.0
kind: genre
tags: [ambient, drone, space, calm, generative]
refs: [emotion-map, groove-templates, harmony-recipes, arrangement-arcs, mix-roles]
paramRanges: { bpm: [50, 70], lufsTarget: [-18, -15], density: [0.5, 2.5], crest: [10, 14] }
compact: true
scoreHistory: []
---

## COMPACT
ambient: 50–70 (дефолт 60) или свободное время, mood void|tender|melancholy.
Ударных НЕТ (или редкий пульс ≤1/такт). groove: none.
Пэды: triangle/sine стеки, attack 2–3с release 4–6с, lpf 1000–1600, room .6–.8 size 6–9.
Гармония: 2–4 аккорда, смена раз в 4–8 тактов (^9, m9, sus), морф медленный.
Генеративные колокольчики: n(irand(10).segment(3)).scale(...), degrade .4,
release 3, delay .75с feedback .5, pan rand — «звёзды», не мелодия.
Бас: суб-корни attack 1 release 4, почти неслышимый фундамент.
Атмосфера: pink/brown noise, lpf-дыхание 300–900 slow(24), gain .05.
arc: bloom-40. LUFS −16..−18, crest 10–14. Тишина — полноценный элемент.

## RECIPE
### Палитра
| роль | основной | fallback |
|---|---|---|
| pad | triangle + ADSR | supersaw lpf 800 gain .3 |
| bells | sine + delay/room | gm_vibraphone rel 2 |
| sub | sine att 1 rel 4 | triangle lpf 150 |
| air | pink noise lfo | brown lpf 400 |
### Приёмы жанра
- Дыхание фильтра: `.lpf(sine.range(300,900).slow(24)).seg(16)` — медленно, незаметно.
- Звёзды: `n(irand(10).segment(3)).scale("C:major").degradeBy(.4)` — seeded!
  (для повторяемости: ribbon(offset,cycles) фиксирует «случайность»).
- Пространство: room size 6–9, rlp ≤ 8000; delay feedback .5–.55 (НЕ выше).
- Морф аккордов: смена раз в 8 тактов + общие тоны → почти незаметный переход.
- Если нужен пульс: sine-кик без атаки, 1 удар/такт, gain .3, lpf 200.
### Аранжировка
bloom: air (шум+суб) → grow (+пэды) → bloom (+звёзды, lpf↑, room↑) → fade (−звёзды,
пэды релиз). Никаких дропов; пик = максимум пространства, не громкости.

## EXAMPLES
```js
// ambient • 60 BPM • C major (воздушный) • smoke: 0 clips, lint 0 errors
setcpm(60/4)
$: chord("<C^9 F^9 Am9 Gadd9>/2").dict('ireal').voicing().anchor("c4")
   .s("triangle").attack(2.5).decay(1).sustain(.7).release(5)
   .lpf(1400).room(.7).size(8).gain(.5).orbit(3)
$: "<C^9 F^9 Am9 Gadd9>/2".rootNotes(2).note().s("sine")
   .attack(1).release(4).gain(.45).orbit(2)
$: n(irand(10).segment(3)).scale("C:major").s("sine")
   .attack(.05).release(3).degradeBy(.4)
   .delay(.4).delaytime(.75).delayfeedback(.5)
   .room(.6).pan(rand.range(.2, .8)).gain(.35).orbit(4)
$: s("pink").lpf(sine.range(300, 900).slow(24)).seg(16).gain(.05).orbit(5)
```

## DO / DON'T
DO: длинные attack/release; seeded-случайность; тишину между звёздами; rlp на реверб.
DON'T: ударные (кроме пульса по запросу); плотность >2.5/с; delayfeedback ≥.6;
резкие смены аккордов; мелодию вместо текстуры; LUFS −14 (жанр тише).

## MEASURE
LUFS −16..−18, crest 10–14, плотность 0.5–2.5/с; бит-в-бит при seeded rand;
контраст секций ≥3 дБ; A/B: «тревожный эмбиент, пустой космос», «нежная колыбельная».

## EVOLVE
Можно: bpm ±5, длины attack/release ±20%, densitи ±.5, size реверба ±1.
Заморожено: без ударных, feedback <.6, seeded-случайность, LUFS-пол.
