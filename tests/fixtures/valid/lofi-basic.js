setCpm(76/4)
const key = "a:minor"
$MEL: note("a4 c5 e5 g4").scale(key).slow(2).room(0.6)._pianoroll()
$BASS: note("a2 f2 c2 g2").s("sawtooth").gain(0.4)._pianoroll()
$DRUMS: s("bd sd bd sd").bank("RolandTR909")._scope()
