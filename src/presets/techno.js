export const techno = {
  id: 'techno',
  name: 'Techno 4/4',
  tags: ['techno', 'club'],
  bpm: 132,
  key: 'e:minor',
  code: [
    'setCpm(132/4)',
    'const key = "e:minor"',
    '$BASS: note("e1 e1 <e2 g2> e1").s("sawtooth").lpf(300).gain(.8)._pianoroll()',
    '$STAB: chord("<e4 ~ ~ ~> <g4 ~ ~ ~>").voicing().s("square").gain(.3).room(.4)._pianoroll()',
    '$DRUMS: s("bd*4").gain(.9)._scope()',
    '$HATS: s("~ hh ~ hh ~ hh ~ hh").gain(.5)._scope()',
    '$CLAP: s("~ ~ cp ~").gain(.6).room(.5)._scope()',
  ].join('\n'),
};
