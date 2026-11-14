---
id: genre-trip-hop
version: 1.0.0
kind: genre
tags: [trip-hop, downtempo, bristol, dark, dusty]
refs: [emotion-map, groove-templates, harmony-recipes, arrangement-arcs, mix-roles]
paramRanges: { bpm: [70, 92], lufsTarget: [-15, -13], density: [6, 11], crest: [8, 12] }
compact: true
scoreHistory: []
---

## COMPACT
trip-hop: 70–92 BPM (дефолт 82), minor/dorian, mood dark|melancholy.
Барабаны: пыльный брейк (clean-breaks amen, splice) + подпорка 808 (kick 0,7,10;
snare 4,12 late +12мс); hats swing 54–58%, degrade .08. groove: drunken.
Бас: суб-синус, корни rootNotes(2), длинные ноты, mono.
Аккорды: Rhodes (gm_electric_piano_1), m9/^9, смена раз в 2 такта, lpf 1500–2000,
wow/flutter speed ±.5%. Лид: редкий (vibraphone/сэмпл), degrade .3, delay пунктир.
Атмосфера: vinyl-шум (brown, lpf 700, gain .03), тёмные пэды.
arc: slow-burn-48. LUFS −14, crest 8–12. Настроение важнее скорости.

## RECIPE
### Палитра (проверить паспорта; fallback указан)
| роль | основной | fallback |
|---|---|---|
| break | clean-breaks amen (лицензию пака — в манифест!) | 808-кит целиком |
| kick/snare | RolandTR808 | синтез: sine+penv 36, pdec .12, distort 8:.4 |
| keys | gm_electric_piano_1 | triangle + lpf 1800 + rel .8 |
| bass | sine (суб) | sawtooth lpf 200 |
| lead | gm_vibraphone | sine + delay |
| atmos | brown noise | pink lpf 500 |
### Приёмы жанра
- Брейк切碎: `.fit().splice(8, "0 1 <2 2*2> 3 [4 0] 5 <6 7>")` — пересборка, не луп.
- Пыль: lpf 3000–3500 на брейке; vinyl-подложка; лёгкий crush 12–14 (опц.).
- Вес: суб-бас держит корни по 2 такта; кик-подпорка только 3 удара/такт.
- Тьма: phrygian b2 как краска в 4-м такте; обманная каденция V→VI.
### Аранжировка
slow-burn: intro (break+atmos) → A (+бас+keys) → B (+lead, lpf↑) → break (−кик−бас,
только keys+atmos) → outro. Переходы — филл снейра и lpf-рампа 2 такта.

## EXAMPLES
```js
// trip-hop • 82 BPM • D minor • smoke: 0 clips, lint 0 errors
setcpm(82/4)
const ms = x => x * (82/4) / 60000
samples('github:yaxu/clean-breaks/main') // runtime-источник; вендор после проверки лицензии
$: s("amen/4").fit().splice(8, "0 1 <2 2*2> 3 [4 0] 5 <6 7>")
   .lpf(3200).gain(.7).late(ms(6)).orbit(1)
$: s("bd").beat("0,7,10",16).bank("RolandTR808").gain(.9).orbit(1)
   .duckorbit(2).duckdepth(.6).duckattack(.15)
$: s("sd").beat("4,12",16).bank("RolandTR808").late(ms(12))
   .gain(".85 .8").room(.12).size(1).orbit(1)
$: s("hh*16").bank("RolandTR808").swingBy(.12, 8)
   .gain(".65 .35 .5 .35").degradeBy(.08).orbit(1)
$: "<Dm9 Dm9 Gm9 A7b13>".rootNotes(2).note().s("sine").gain(.8).orbit(2)
$: chord("<Dm9 Dm9 Gm9 A7b13>").dict('ireal').voicing().anchor("c4")
   .s("gm_electric_piano_1").lpf(1800).room(.25).size(2)
   .speed(sine.range(.995, 1.005).slow(3)).gain(.5).orbit(3)
$: n("4 ~ 2 ~ 5 ~ 3 ~").scale("D:minor").s("gm_vibraphone")
   .degradeBy(.3).delay(.25).delaytime(.549).delayfeedback(.35)
   .room(.3).gain(.45).orbit(4)
$: s("brown").lpf(700).gain(.035).orbit(5)
```

## DO / DON'T
DO: брейк пересобирать; snare late; суб длинными; 2 такта на аккорд; пыль умеренно.
DON'T: прямые 16-е без свинга; яркий lpf>4k на всём; busy-лид (жанр про пространство);
кик чаще 4/такт; забыть vinyl-подложку (будет «пластик»).

## MEASURE
LUFS −14±1, crest 8–12, плотность 6–11/с; lint: snare-offset в [8,16]мс;
A/B промты: «мрачный трип-хоп про дождь», «меланхолия осеннего города».

## EVOLVE
Можно: bpm ±4, splice-паттерны, lpf ±300, degrade ±.03, vinyl gain ±.01.
Заморожено: swung hats, snare late, суб-моно, 2-тактная гармония.
