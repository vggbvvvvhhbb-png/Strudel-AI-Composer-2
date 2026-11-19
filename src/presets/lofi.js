export const lofi = {
  id: 'lofi',
  name: 'Lo-fi пианино',
  tags: ['lo-fi', 'chill'],
  bpm: 72,
  key: 'a:minor',
  code: [
    'setCpm(72/4)',
    'const key = "a:minor"',
    '$CHORDS: note("<[a3,c4,e4] [f3,a3,c4]>").s("sawtooth").gain(.35).slow(2).room(.6)._pianoroll()',
    '$MEL: note("a4 ~ c5 e5 ~ g5 ~ e4").s("piano").gain(.6).room(.7)._pianoroll()',
    '$BASS: note("<a1 ~ ~ ~> <f1 ~ ~ ~>").s("sine").gain(.75)._pianoroll()',
    '$DRUMS: s("bd ~ sd ~").gain(.7)._scope()',
    '$HATS: s("hh ~ hh ~ hh*2 ~").gain(.35)._scope()',
  ].join('\n'),
};
