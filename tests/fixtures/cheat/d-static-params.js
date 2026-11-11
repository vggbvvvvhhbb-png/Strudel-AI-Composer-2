// Фикстура (d): статичные параметры — автоматизация ноль.
//
// Каждая партия имеет эффекты, но все параметры — константы.
// По тексту кода это выглядит богато (lpf, room, delay, gain), но
// ничего не движется: доля автоматизированных параметров должна быть 0.
//
// Форма у трека есть (секции разной плотности, переходы) — чтобы фикстура
// проверяла именно автоматизацию.
//
// Настоящий код Strudel.

setCpm(120/4)
const key = "d:minor"

$KICK: arrange(
  [16, s("bd*4")],
  [16, s("bd*4 bd*2")],
  [16, s("bd*8")],
  [16, s("bd*2")],
).gain(0.9)._scope()

$HATS: arrange(
  [16, s("hh*8")],
  [16, s("hh*16")],
  [16, s("hh*8 ~ hh*4")],
  [16, s("hh*4")],
).gain(0.35)._scope()

$BASS: arrange(
  [16, n("0 0 3 5").scale(key)],
  [16, n("0 0 3 5 7 5").scale(key)],
  [16, n("0 3 5 7").scale(key)],
  [16, n("0 0 3 5").scale(key)],
).s("sawtooth").lpf(400).gain(0.6)._pianoroll()

$PAD: arrange(
  [16, stack(n("0 2 4").scale(key), n("3 5 7").scale(key))],
  [16, stack(n("0 2 4").scale(key), n("3 5 7").scale(key))],
  [16, stack(n("5 7 9").scale(key), n("8 10 0").scale(key))],
  [16, stack(n("0 2 4").scale(key), n("3 5 7").scale(key))],
).s("sawtooth").room(0.5).gain(0.25)._pianoroll()

$LEAD: arrange(
  [16, n("4 2 0 2").scale(key)],
  [16, n("5 3 1 3").scale(key)],
  [16, n("4 2 0 2").scale(key).fast(2)],
  [16, n("2 4 6 4").scale(key)],
).s("square").delay(0.3).gain(0.4)._pianoroll()

$ARP: arrange(
  [16, n("0 4 7 4").scale(key)],
  [16, n("0 4 7 4").scale(key).fast(2)],
  [16, n("2 5 9 5").scale(key)],
  [16, n("0 4 7 4").scale(key).fast(2)],
).s("square").lpf(1200).gain(0.35)._pianoroll()
