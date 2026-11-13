// Общая спека для тестов студии: 48 тактов, пять партий, четыре секции.
export const SPEC = {
  meta: { style: 'techno', bpm: 128, key: 'Cmin' },
  structure: { sections: [
    { name: 'intro', cycles: 8, energy: 0.3, harmony: 'Cm Ab Fm Gm' },
    { name: 'build', cycles: 16, energy: 0.65, harmony: 'Fm Cm Ab Gm', parameters: { cutoff: [300, 7000] } },
    { name: 'drop', cycles: 16, energy: 1, harmony: 'Cm Ab Fm Gm', parameters: { gain: [0.6, 1] } },
    { name: 'outro', cycles: 8, energy: 0.2, harmony: 'Ab Fm Gm Cm' },
  ] },
  parts: { roles: {
    kick: { activeIn: ['intro', 'build', 'drop', 'outro'], pattern: 'bd*4', sound: 's' },
    hats: { activeIn: ['build', 'drop'], pattern: 'hh*8', sound: 's' },
    snare: { activeIn: ['drop'], pattern: '~ sd ~ sd', sound: 's' },
    bass: { activeIn: ['intro', 'build', 'drop'], pattern: '0 ~ 2 4', sound: 'sawtooth' },
    arp: { activeIn: ['drop'], pattern: '0 2 4 6', sound: 'triangle' },
  } },
};

export const copySpec = () => structuredClone(SPEC);
