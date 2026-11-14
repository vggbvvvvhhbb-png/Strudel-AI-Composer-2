---
id: arrangement-arcs
version: 1.0.0
kind: arrangement
tags: [arrangement, sections, energy, tension, form]
refs: [mix-roles]
paramRanges: { totalBars: [32, 80], sections: [3, 6], energy: [0, 1] }
compact: true
scoreHistory: []
---

## COMPACT
Трек ≠ луп: ≥3 контрастных секции, кривая энергии, переходы.
Арки (такты / целевая энергия):
- song-64: intro 8/.2 → verse 16/.45 → build 8/.65 → peak 16/.85 → break 8/.3 → outro 8/.2
- club-64: intro 16/.3 → build 16/.6 → drop 16/.9 → break 8/.25 → drop2 8/.85
- slow-burn-48: intro 8/.15 → A 12/.4 → B 12/.65 → break 8/.25 → outro 8/.2
- bloom-40: air 8/.1 → grow 12/.35 → bloom 12/.55 → fade 8/.15 (без ударных)
Энергия = плотность событий × громкость роли × яркость (lpf). Матрица ролей:
intro: chords+fx; verse: +bass+kick; build: +hats, lpf↑; peak: все роли;
break: −kick −bass, chords+lead; outro: −lead −hats.
Переходы: филл в последнем такте секции; lpf-рампа 2 такта; дроп = 1 такт
тишины баса/кика перед пиком. Автоматизации — сигналами slow(длина арки).

## RECIPE
### Матрица «роль × секция» (множитель гейна)
| роль | intro | verse | build | peak | break | outro |
|---|---|---|---|---|---|---|
| kick | 0 | .9 | 1 | 1 | 0 | .7 |
| bass | 0 | .85 | .95 | 1 | 0 | .6 |
| chords | .7 | .8 | .9 | 1 | .9 | .7 |
| lead | 0 | .6 | .8 | 1 | .8 | 0 |
| hats | 0 | .6 | .9 | 1 | .3 | .3 |
| fx | .8 | .4 | 1 (riser) | .5 | .9 | .7 |

### Компиляция в код (иллюстрация; движок делает это через шину)
- Секционность: `.mask("<1!8 0!8>")`-паттерны или per-section рендер Arrange-графом.
- Рампа фильтра на build (8 тактов): `.lpf(sine.range(500,4000).slow(64)).seg(16)`
  (slow = длина всей арки в циклах; seg — чтобы LFO не был ступенчатым).
- Дроп-тишина: бас `.mask("<1!15 0>")` перед пиком.
- Riser: `s("pink").hpf(sine.range(400,6000).slow(8)).gain(sine.range(0,.25).slow(8))`.

### Измерение формы
Из offline-рендера: RMS по секциям (окно = длина секции) + плотность нот из
query паттерна. Корреляция Пирсона профиля с целевой кривой ≥ 0.7 (North Star).
Контраст: max(RMS) − min(RMS) ≥ 6 дБ между peak и break (кроме ambient ≥ 3).

## EXAMPLES
```js
// build → peak: рампа яркости + дроп-тишина баса (иллюстрация арки)
setcpm(118/4)
$: chord("<Am7 F^7 C^7 G>").voicing().s("supersaw")
   .lpf(sine.range(600,3500).slow(64)).seg(16).gain(.45).orbit(3)
$: "<Am7 F^7 C^7 G>".rootNotes(2).note().s("sawtooth").lpf(500)
   .mask("<1!15 0>").gain(.7).orbit(2) // 1 такт тишины перед циклом 16
```

## DO / DON'T
DO: целевая кривая до генерации; контраст peak/break; филлы на границах;
автоматизации длиной в арку, не в луп.
DON'T: все роли везде (луп-каша); >6 секций; break без снятия кика/баса;
рампы быстрее 1 такта (щёлкает) и без seg (ступеньки).

## MEASURE
Корреляция энергии ≥0.7; контраст ≥6 дБ (ambient ≥3); lint: секции ≥3;
A/B «с аркой vs луп» — главный тест музыкальности.

## EVOLVE
Можно: длины секций ±4 такта, целевые энергии ±.1, матричные множители ±.1.
Заморожено: ≥3 секции, наличие break, контраст-порог.
