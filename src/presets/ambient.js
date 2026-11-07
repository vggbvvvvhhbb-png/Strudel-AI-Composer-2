export const ambient = {
  id: 'ambient',
  name: 'Ambient пад',
  tags: ['ambient', 'drone'],
  bpm: 60,
  key: 'c:major',
  code: [
    'setCpm(60/4)',
    'const key = "c:major"',
    '$PAD: chord("<c3 maj> <a2 min> <f2 maj>").voicing().s("sawtooth").slow(4).attack(.4).gain(.3).room(1)._pianoroll()',
    '$SPARKLE: note("<c5 g5 ~ e5> ~").s("triangle").slow(2).gain(.4).room(1)._pianoroll()',
    '$SUB: note("c1 ~ ~ ~").s("sine").slow(4).gain(.5)._pianoroll()',
  ].join('\n'),
};
