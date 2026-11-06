export const dnb = {
  id: 'dnb',
  name: 'Drum & Bass',
  tags: ['dnb', 'breakbeat'],
  bpm: 174,
  key: 'e:minor',
  code: [
    'setCpm(174/4)',
    'const key = "e:minor"',
    '$BREAK: s("bd . sd . . sd . ~").fast(2).bank("RolandTR909").gain(.8)._scope()',
    '$RIDE: s("hh*8").bank("RolandTR909").gain(.35)._scope()',
    '$BASS: n("e1 . <d1 e1> .").s("sawtooth").lpf(220).gain(.85)._pianoroll()',
    '$STAB: chord("<e4 .> <g4 .>").voicing().s("square").gain(.3).room(.4)._pianoroll()',
  ].join('\n'),
};
