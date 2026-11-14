---
id: mix-roles
version: 1.0.0
kind: mix
tags: [mix, automix, lufs, truepeak, sidechain, orbit]
refs: []
paramRanges: { gain: [0, 1.2], lufsTarget: [-24, -8], duckdepth: [0, 1], duckattack: [0.05, 0.4] }
compact: true
scoreHistory: []
---

## COMPACT
Роли и orbit (один delay/reverb на orbit — роли НЕ делят orbit!):
| роль | orbit | территория Гц | старт gain | room | delay | pan |
|---|---|---|---|---|---|---|
| kick | 1 | 50–100 + клик 2–5k | .95 | 0 | 0 | .5 |
| snare/clap | 1 | 200–4k | .8 | .1–.15 | 0 | .5 |
| hats | 1 | 5–12k | .5–.7 | 0 | 0 | .4–.6 |
| bass | 2 | 40–250, MONO | .75 | 0 | 0 | .5 |
| chords | 3 | 200–2k (hpf 150–250) | .5 | .15–.3 | 0 | широкий |
| lead | 4 | 1–6k | .45 | .2–.35 | .2–.35 | .5 или авто |
| fx/atmos | 5 | свободно | .05–.3 | .5+ | по вкусу | широкий |
Сайдчейн: кик `.duckorbit("2:3").duckdepth("0.7:0.3").duckattack("0.12:0.2")`.
Headroom: сумма до мастера ≤ −6 dBFS. Мастер: LUFS-I −14±1, ≤ −1 dBTP (4×).
Жанровые LUFS: ambient −16..−18, dnb −12..−10, остальные −14. Потолок −1 dBTP всегда.
autoMix: ≤3 итерации, шаг ≤2 дБ; приоритет: clip → truepeak → LUFS → баланс ролей.
Бас моно <120 Гц; бас и кик не делят фундамент (кик 50–60 → бас 80+, или наоборот).

## RECIPE
### Баланс-цели (относительный RMS, кик = 0 дБ)
bass −4 | chords −8 | lead −6 | snare −5 | hats −14 | fx −18.
Это СТАРТ для autoMix, не догма; жанр может сдвигать ±3 дБ.
### Маскинг-правила
- chords hpf 150–250 Гц (освободить бас); lead hpf 300+.
- кик vs бас: выбрать фундамент (кик 50–60, бас 80–120) — не оба в 60.
- хэты hpf 4k+; реверб-хвосты rlp ≤ 8k (грязь сверху).
### Пространство
- Ширина: chords/lead — pan-движение или juxBy(.5); бас/кик строго центр.
- Реверб: snare короткий (size 1–2), chords 2–3, ambient 6–9; delay только lead/fx,
  delaytime = музыкальная доля (восьмая = 60/BPM/2; пунктир = ×1.5), feedback < .6.
### Протокол autoMix
1. Измерить MetricsReport (LUFS, truepeak, clip, crest, RMS по ролям если есть соло).
2. Итерация: clip>0 → −2 дБ виновной роли; truepeak>−1 → мастер-лимитер/−1 дБ;
   LUFS мимо цели → мастер ±≤2 дБ; баланс мимо ±3 дБ → роль ±≤2 дБ.
3. ≤3 итерации; каждая — команда на шину + запись before/after.
### Crest-ориентиры v1 (калибровать): ambient 10–14 | trip-hop 8–12 | lofi 8–11 |
synthpop 6–9 | dnb 5–8.

## EXAMPLES
```js
// сайдчейн: кик дакирует бас и аккорды, у каждого свой orbit
setcpm(118/4)
$: s("bd*4").bank("RolandTR707").gain(.95).orbit(1)
   .duckorbit("2:3").duckdepth("0.8:0.35").duckattack("0.12:0.18")
$: note("a1").struct("~ x ~ x ~ x ~ x").s("sawtooth").lpf(500).gain(.7).orbit(2)
$: chord("<Am7 F^7 C^7 G>").voicing().s("supersaw").lpf(2200)
   .room(.2).size(2).gain(.42).orbit(3)
```

## DO / DON'T
DO: orbit на роль; duck от кика; hpf на chords/lead; отчёт before/after.
DON'T: delayfeedback ≥1; room на бас/кик; два delay на одном orbit; gain>1.2;
«мастер громче» вместо баланса; менять мастер раньше, чем устранён клиппинг.

## MEASURE
0 clip; ≤−1 dBTP (4×, сверка с libebur128 |Δ|≤.1); LUFS в цели; crest в диапазоне;
RMS-баланс ролей ±3 дБ от целей; автоMикс сходится ≤3 итераций.

## EVOLVE
Можно: старт-гейны ±.1, баланс-цели ±2 дБ, duckdepth ±.1, crest-диапазоны.
Заморожено: −1 dBTP потолок, delayfeedback<1, моно-бас, orbit-разделение, ≤3 итерации.
