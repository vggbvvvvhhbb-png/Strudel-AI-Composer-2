export const synthwave = {
  id: 'synthwave',
  name: 'Synthwave арпеджио',
  tags: ['synthwave', 'retro'],
  bpm: 100,
  key: 'g:major',
  code: [
    'setCpm(100/4)',
    'const key = "g:major"',
    '$ARP: note("<g4 b4 d5 b4>*2").s("sawtooth").gain(.45).room(.5)._pianoroll()',
    '$PAD: chord("<g2 maj> <e2 min>").s("sawtooth").slow(2).attack(.3).gain(.3).room(.8)._pianoroll()',
    '$BASS: note("g1 g1 d1 d1").s("square").lpf(400).gain(.75)._pianoroll()',
    '$DRUMS: s("bd ~ sd ~").gain(.75)._scope()',
    '$HATS: s("hh ~ hh ~ hh ~ hh*2").gain(.4)._scope()',
  ].join('\n'),
};
