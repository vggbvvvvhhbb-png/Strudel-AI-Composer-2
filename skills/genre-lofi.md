---
id: genre-lofi
version: 1.0.0
kind: genre
tags: [lofi, hip-hop, chill, study, jazzy, tape]
refs: [emotion-map, groove-templates, harmony-recipes, arrangement-arcs, mix-roles]
paramRanges: { bpm: [72, 86], lufsTarget: [-15, -13], density: [6, 10], crest: [8, 11] }
compact: true
scoreHistory: []
---

## COMPACT
lofi: 72–86 (дефолт 78), джазовые аккорды (^9, m9, 13), mood nostalgia|tender|melancholy.
Барабаны: LinnDrum (fallback TR707), ленивый кик (0,7), snare 4,12 late +12мс,
hats 16-е swing 56% (swingBy(.12,8)), degrade .12, lpf 6000. groove: swing-16.
Ключи: Rhodes gm_electric_piano_1, lpf 2400, wow/flutter speed ±.4% slow(2), room .18.
Бас: sine-корни rootNotes(2), просто, длинные. Лид: vibraphone, редкий, degrade .35.
Кассета: white noise hpf 4000 gain .02 (шипение) + лёгкий distort .1 на шине ключей (опц.).
Гармония: ii–V–I или Eb^9 Cm9 Ab^9 Bb13, смена 1 такт. arc: song-64 (короткий, лупабельный).
LUFS −14, crest 8–11. Уют = несовершенство в меру.

## RECIPE
### Палитра
| роль | основной | fallback |
|---|---|---|
| drums | LinnDrum (проверить банк!) | RolandTR707 lpf 5000 |
| keys | gm_electric_piano_1 | gm_acoustic_grand_piano lpf 2200 |
| bass | sine | gm_acoustic_bass lpf 300 |
| lead | gm_vibraphone | sine + delay |
| tape | white hpf 4k | brown lpf 800 gain .03 |
### Приёмы жанра
- Wow/flutter: `.speed(sine.range(.996,1.004).slow(2))` — кассета «плывёт» ±7 центов.
- Пыль на барабанах: lpf 5000–6000 на всём ките; снейр не яркий.
- Джаз: 9/13-аккорды через dict('ireal'); ii–V–I обороты; passing-диминишд (опц.).
- Ленивая мелодия: 4–5 нот на 2 такта, паузы обязательны, degrade .35.
- Шипение всегда, но −30 дБ относительно микса (gain .02).
### Аранжировка
song-64 укороченный до 48: intro 4 (keys+tape) → A 12 (всё) → B 12 (+лид) →
break 8 (−барабаны, keys) → A' 8 → outro 4. Лупабельность: конец = начало.

## EXAMPLES
```js
// lofi • 78 BPM • Eb major (джазовый) • smoke: 0 clips, lint 0 errors
setcpm(78/4)
const ms = x => x * (78/4) / 60000
$: s("bd").beat("0,7",16).bank("LinnDrum").gain(".9 .75").orbit(1) // fallback: RolandTR707
$: s("sd").beat("4,12",16).bank("LinnDrum").late(ms(12))
   .gain(".8 .78").room(.1).size(1).orbit(1)
$: s("hh*16").bank("LinnDrum").swingBy(.12, 8)
   .gain(".6 .35 .5 .35").degradeBy(.12).lpf(6000).orbit(1)
$: "<Eb^9 Cm9 Ab^9 Bb13>".rootNotes(2).note().s("sine").gain(.7).orbit(2)
$: chord("<Eb^9 Cm9 Ab^9 Bb13>").dict('ireal').voicing().anchor("c4")
   .s("gm_electric_piano_1").lpf(2400)
   .speed(sine.range(.996, 1.004).slow(2)).room(.18).size(2).gain(.5).orbit(3)
$: n("4 ~ 2 ~ 0 ~ 3 ~").scale("Eb:major").s("gm_vibraphone")
   .degradeBy(.35).lpf(3000).delay(.2).delaytime(.385).delayfeedback(.3).gain(.4).orbit(4)
$: s("white").hpf(4000).gain(.02).orbit(5)
```

## DO / DON'T
DO: swing на хэтах; snare late; wow на ключах; паузы в мелодии; шипение тихо.
DON'T: яркие хэты (lpf обязателен); кик чаще 3/такт; мелодию без пауз;
distort >.2 (будет грязь, не уют); забыть про лупабельность.

## MEASURE
LUFS −14±1, crest 8–11, плотность 6–10/с; lint: swing на хэтах, snare-offset [8,16]мс;
A/B: «уютный лоуфай для учёбы», «ностальгическая кассета из 90-х».

## EVOLVE
Можно: bpm ±4, swing ±.02, degrade ±.03, wow-глубина ±.1%, джазовые замены.
Заморожено: snare late, lpf на хэтах, шипение ≤.03, лупабельность.
