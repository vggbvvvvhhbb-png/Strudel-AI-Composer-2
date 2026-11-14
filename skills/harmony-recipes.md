---
id: harmony-recipes
version: 1.0.0
kind: harmony
tags: [harmony, chords, voicing, voice-leading, cadence]
refs: [emotion-map]
paramRanges: { chordChangeBars: [1, 8], bassOctave: [1, 2], leadMinOctave: [4, 5] }
compact: true
scoreHistory: []
---

## COMPACT
Прогрессии по настроению (символы tonal: ^7 maj7, m9, 13, 7b13, sus4):
joy: <C G Am F> | euphoria: <Cadd9 Gadd9 Am7 Fadd9> | tender: <C^9 Am9 F^9 Gadd9>
hope: <Am F C G> + iv-краска | nostalgia: <Eb^9 Cm9 Ab^9 Bb13> или <Dm9 G13 C^9 C^9>
melancholy: <Am9 F^7 C^7 G6> | dark: <Dm Bb^7 Gm7 A7b13> или phrygian <Dm Eb^7>
anxiety: <Dm Eb^7 Dm Eb^7> (b2-vamp) | anger: <Em C G B7> | void: <C^9 F^9>/2
Бас: `"<прогрессия>".rootNotes(2).note()` — корни, октава 1–2.
Аккорды: `chord("<...>").dict('ireal').voicing().anchor("c4")` — верх ≤ c4.
Лид: ≥ c4. Общие тоны держать, скачки ≤ квинты (бас исключён).
Смена аккорда: pop/lofi 1 такт, trip-hop 2, dnb 2–4, ambient 4–8.
Каденции: V→i разрешение; V→VI обманная (напряжение); IV→I плагальная (тепло).

## RECIPE
### Войсинг-правила (theory-lint v1)
1. Бас: корни в октаве 1–2, не выше c3; не дублировать бас в аккорде ниже c3.
2. Аккорды: shell/ireal-войсинг, anchor c4 mode below; 3–4 голоса, не больше.
3. Лид: ≥ c4; с аккордами не пересекаться больше чем на 1 голос.
4. Voice leading: параллельные квинты/октавы между басом и лидом — warning;
   скачок > квинты в любом голосе кроме баса — warning.
5. Плотность: ≤ 1 аккордовый удар на такт в спокойных жанрах; стаккато-компы
   (synthpop) — исключение, до 4/такт.
6. Диссонанс (b2, tritone, m9 в басу) — только как краска с разрешением,
   кроме anxiety/dark (там неразрешённость = приём, lint-info).

### Модальные краски и заимствования
- dorian: натуральная 6 над минором → «надежда в грусти» (Am + F#dim passing).
- iv в мажоре (C: Fm) → ностальгия; bVII (C: Bb) → гимн; bVI (C: Ab) → кино-тьма.
- add9/sus2 = тепло без сентиментальности; maj9 = «дорогой» звук.

### Ритм гармонии
chordChangeBars: pop 1 | lofi 1 | trip-hop 2 | dnb 2–4 | ambient 4–8.
Быстрее 1/такт = тревога/энергия; медленнее 4 = пространство/вес.

## EXAMPLES
```js
// nostalgia: джазовый ii–V–I с басом из корней (78 BPM)
setcpm(78/4)
$: "<Dm9 G13 C^9 C^9>".rootNotes(2).note().s("sine").gain(.7).orbit(2)
$: chord("<Dm9 G13 C^9 C^9>").dict('ireal').voicing().anchor("c4")
   .s("gm_electric_piano_1").lpf(2400).room(.18).gain(.5).orbit(3)
```
```js
// dark: обманная каденция — ждёшь Dm, получаешь Bb (82 BPM)
setcpm(82/4)
$: chord("<Dm Dm Gm7 A7b13 Dm Dm Gm7 Bb^7>").dict('ireal')
   .voicing().anchor("c3").s("triangle").lpf(1200).room(.3).gain(.5).orbit(3)
```

## DO / DON'T
DO: rootNotes для баса; dict('ireal') для 9/13; общие тоны; каденции осознанно.
DON'T: >4 голосов в аккорде; бас выше c3; случайные инверсии без anchor;
менять прогрессию каждые полтакта в спокойном жанре; дублировать корень в лиде.

## MEASURE
theory-lint: 0 errors (параллели/диапазоны/скачки); A/B: таблица vs свободная
генерация на 5 промтов; метрика-кандидат: % общих тонов между соседними войсингами.

## EVOLVE
Можно: заменять прогрессии из корпуса победителей,的节奏 chordChangeBars ±1.
Заморожено: диапазоны октав, лимит голосов, правила lint.
