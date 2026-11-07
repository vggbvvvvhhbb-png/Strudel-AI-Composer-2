export const house = {
  id: 'house',
  name: 'House грув',
  tags: ['house', 'groove'],
  bpm: 124,
  key: 'f:minor',
  code: [
    'setCpm(124/4)',
    'const key = "f:minor"',
    '$DRUMS: s("bd*4").gain(.9)._scope()',
    '$HATS: s("~ hh ~ hh ~ hh ~ hh").gain(.5)._scope()',
    '$CLAP: s("~ cp ~ cp").gain(.55).room(.4)._scope()',
    '$BASS: note("<f1 ~ ab1 ~> <c2 ~ bb1 ~>").s("sine").gain(.8)._pianoroll()',
    '$STAB: chord("<f3 ab3 c4> ~").s("square").gain(.35).room(.4)._pianoroll()',
  ].join('\n'),
};
