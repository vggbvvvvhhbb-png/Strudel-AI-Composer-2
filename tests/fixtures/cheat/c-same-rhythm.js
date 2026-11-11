// Фикстура (c): 8 партий с одним ритмом.
//
// Много партий — скор «разнообразие» по числу партий высокий.
// Но все они играют ОДИН И ТОТ ЖЕ рисунок: это не аранжировка, а дублирование.
// Разнообразие партий должно упасть.
//
// Форма у трека есть (секции разной плотности) — чтобы фикстура проверяла
// именно разнообразие, а не отсутствие формы.
//
// Настоящий код Strudel: каждая партия играет «0 ~ 0 ~ 0 ~ 0 ~» в своей высоте.

setCpm(130/4)
const key = "a:minor"

const RHYTHM = "0 ~ 0 ~ 0 ~ 0 ~";

$P1: arrange([16, n("0").scale(key)], [16, n("0").scale(key).fast(2)], [16, n("0").scale(key)], [16, n("0").scale(key).fast(2)]).s("sawtooth").gain(0.5)._pianoroll()
$P2: arrange([16, n("0").scale(key)], [16, n("0").scale(key).fast(2)], [16, n("0").scale(key)], [16, n("0").scale(key).fast(2)]).s("square").gain(0.5)._pianoroll()
$P3: arrange([16, n("0").scale(key)], [16, n("0").scale(key).fast(2)], [16, n("0").scale(key)], [16, n("0").scale(key).fast(2)]).s("triangle").gain(0.5)._pianoroll()
$P4: arrange([16, n("0").scale(key)], [16, n("0").scale(key).fast(2)], [16, n("0").scale(key)], [16, n("0").scale(key).fast(2)]).s("piano").gain(0.5)._pianoroll()
$P5: arrange([16, n("2").scale(key)], [16, n("2").scale(key).fast(2)], [16, n("2").scale(key)], [16, n("2").scale(key).fast(2)]).s("sawtooth").gain(0.45)._pianoroll()
$P6: arrange([16, n("4").scale(key)], [16, n("4").scale(key).fast(2)], [16, n("4").scale(key)], [16, n("4").scale(key).fast(2)]).s("square").gain(0.45)._pianoroll()
$P7: arrange([16, n("7").scale(key)], [16, n("7").scale(key).fast(2)], [16, n("7").scale(key)], [16, n("7").scale(key).fast(2)]).s("triangle").gain(0.4)._pianoroll()
$P8: arrange([16, n("9").scale(key)], [16, n("9").scale(key).fast(2)], [16, n("9").scale(key)], [16, n("9").scale(key).fast(2)]).s("piano").gain(0.4)._pianoroll()
