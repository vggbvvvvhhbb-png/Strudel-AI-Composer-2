export const house = {
  id: 'house',
  name: 'House грув',
  tags: ['house', 'groove'],
  bpm: 124,
  key: 'f:minor',
  code: [
    'setCpm(124/4)',
    'const key = "f:minor"',
    '$DRUMS: s("bd*4").bank("RolandTR909").gain(.9)._scope()',
    '$HATS: s(". hh . hh . hh . hh").bank("RolandTR909").gain(.5)._scope()',
    '$CLAP: s("~ cp ~ cp").bank("RolandTR909").gain(.55).room(.4)._scope()',
    '$BASS: n("<f1 . ab1 .> <c2 . bb1 .>").s("sine").gain(.8)._pianoroll()',
    '$STAB: chord("<f3 ab3 c4> .").voicing().s("square").gain(.35).room(.4)._pianoroll()',
  ].join('\n'),
};
