// Формы трека по стилям: шаблоны секций, из которых собирается произведение.
//
// Каждая форма — массив секций:
//   { kind, bars, energy, roles, transition? }
//   kind        — тип секции (intro/build/drop/breakdown/outro/verse/chorus/fill)
//   bars        — длина в тактах (кратно 4)
//   energy      — энергия секции 0..1 (кривая энергии трека)
//   roles       — какие роли играют в секции
//   transition  — переход В секцию: { into, type }
//
// Формы различаются по длине (32–96 тактов) и по наличию смены гармонии:
// именно форма даёт треку развитие, а не один длинный цикл.

export const SECTION_KINDS = [
  'intro', 'build', 'drop', 'breakdown', 'fill', 'outro', 'verse', 'chorus', 'bridge',
];

export const FORMS = {
  lofi: [
    {
      id: 'lofi-form-short',
      style: 'lofi',
      tags: ['short', 'loop-friendly'],
      source: 'own',
      verified: true,
      sections: [
        { kind: 'intro', bars: 8, energy: 0.3, roles: ['kick', 'hats', 'bass'] },
        { kind: 'verse', bars: 8, energy: 0.5, roles: ['kick', 'hats', 'bass', 'chords'] },
        { kind: 'chorus', bars: 8, energy: 0.8, roles: ['kick', 'snare', 'hats', 'bass', 'chords', 'lead'] },
        { kind: 'verse', bars: 8, energy: 0.5, roles: ['kick', 'hats', 'bass', 'chords'] },
        { kind: 'outro', bars: 8, energy: 0.25, roles: ['kick', 'hats', 'bass'] },
      ],
    },
    {
      id: 'lofi-form-long',
      style: 'lofi',
      tags: ['long', 'verse-chorus'],
      source: 'own',
      verified: true,
      sections: [
        { kind: 'intro', bars: 8, energy: 0.25, roles: ['hats', 'texture'] },
        { kind: 'verse', bars: 16, energy: 0.45, roles: ['kick', 'hats', 'bass', 'chords'] },
        { kind: 'chorus', bars: 16, energy: 0.8, roles: ['kick', 'snare', 'hats', 'bass', 'chords', 'lead'] },
        { kind: 'verse', bars: 16, energy: 0.5, roles: ['kick', 'hats', 'bass', 'chords'] },
        { kind: 'chorus', bars: 16, energy: 0.85, roles: ['kick', 'snare', 'hats', 'bass', 'chords', 'lead', 'arp'] },
        { kind: 'outro', bars: 8, energy: 0.2, roles: ['hats', 'texture'] },
      ],
    },
  ],
  techno: [
    {
      id: 'techno-form-classic',
      style: 'techno',
      tags: ['classic', 'build-drop'],
      source: 'own',
      verified: true,
      sections: [
        { kind: 'intro', bars: 8, energy: 0.3, roles: ['kick', 'hats', 'bass'] },
        { kind: 'build', bars: 16, energy: 0.65, roles: ['kick', 'hats', 'perc', 'bass'], transition: { into: 'drop', type: 'riser' } },
        { kind: 'drop', bars: 16, energy: 1.0, roles: ['kick', 'snare', 'hats', 'perc', 'bass', 'arp', 'fx'] },
        { kind: 'breakdown', bars: 8, energy: 0.35, roles: ['kick', 'hats', 'pad', 'texture'] },
        { kind: 'build', bars: 16, energy: 0.7, roles: ['kick', 'hats', 'perc', 'bass', 'fx'], transition: { into: 'drop', type: 'riser' } },
        { kind: 'drop', bars: 16, energy: 1.0, roles: ['kick', 'snare', 'hats', 'perc', 'bass', 'arp', 'fx'] },
        { kind: 'outro', bars: 8, energy: 0.2, roles: ['kick', 'hats', 'bass'] },
      ],
    },
    {
      id: 'techno-form-long',
      style: 'techno',
      tags: ['long', 'peak-time'],
      source: 'own',
      verified: true,
      sections: [
        { kind: 'intro', bars: 8, energy: 0.25, roles: ['hats', 'texture', 'bass'] },
        { kind: 'build', bars: 16, energy: 0.6, roles: ['kick', 'hats', 'perc', 'bass'], transition: { into: 'drop', type: 'riser' } },
        { kind: 'drop', bars: 16, energy: 1.0, roles: ['kick', 'snare', 'hats', 'perc', 'sub', 'bass', 'arp', 'fx'] },
        { kind: 'breakdown', bars: 8, energy: 0.3, roles: ['hats', 'pad', 'texture'] },
        { kind: 'build', bars: 16, energy: 0.75, roles: ['kick', 'hats', 'perc', 'bass', 'fx'], transition: { into: 'drop', type: 'riser' } },
        { kind: 'drop', bars: 16, energy: 1.0, roles: ['kick', 'snare', 'hats', 'perc', 'sub', 'bass', 'arp', 'fx'] },
        { kind: 'outro', bars: 8, energy: 0.2, roles: ['hats', 'texture'] },
      ],
    },
  ],
  house: [
    {
      id: 'house-form-standard',
      style: 'house',
      tags: ['standard', 'verse-chorus'],
      source: 'own',
      verified: true,
      sections: [
        { kind: 'intro', bars: 8, energy: 0.35, roles: ['kick', 'hats', 'bass'] },
        { kind: 'verse', bars: 16, energy: 0.6, roles: ['kick', 'hats', 'perc', 'bass'] },
        { kind: 'chorus', bars: 16, energy: 0.9, roles: ['kick', 'snare', 'hats', 'perc', 'sub', 'bass', 'chords', 'arp'] },
        { kind: 'breakdown', bars: 8, energy: 0.3, roles: ['hats', 'pad', 'texture'], transition: { into: 'chorus', type: 'build' } },
        { kind: 'chorus', bars: 16, energy: 0.95, roles: ['kick', 'snare', 'hats', 'perc', 'sub', 'bass', 'chords', 'arp', 'lead'] },
        { kind: 'outro', bars: 8, energy: 0.25, roles: ['kick', 'hats', 'bass'] },
      ],
    },
    {
      id: 'house-form-long',
      style: 'house',
      tags: ['long', 'extended'],
      source: 'own',
      verified: true,
      sections: [
        { kind: 'intro', bars: 8, energy: 0.3, roles: ['hats', 'perc', 'bass'] },
        { kind: 'verse', bars: 16, energy: 0.55, roles: ['kick', 'hats', 'perc', 'bass'] },
        { kind: 'chorus', bars: 16, energy: 0.9, roles: ['kick', 'snare', 'hats', 'perc', 'sub', 'bass', 'chords', 'arp'] },
        { kind: 'verse', bars: 16, energy: 0.6, roles: ['kick', 'hats', 'perc', 'bass', 'chords'] },
        { kind: 'chorus', bars: 16, energy: 1.0, roles: ['kick', 'snare', 'hats', 'perc', 'sub', 'bass', 'chords', 'arp', 'lead'] },
        { kind: 'breakdown', bars: 8, energy: 0.3, roles: ['hats', 'pad', 'texture'], transition: { into: 'chorus', type: 'build' } },
        { kind: 'outro', bars: 8, energy: 0.2, roles: ['hats', 'texture'] },
      ],
    },
  ],
  ambient: [
    {
      id: 'ambient-form-drone',
      style: 'ambient',
      tags: ['drone', 'slow'],
      source: 'own',
      verified: true,
      sections: [
        { kind: 'intro', bars: 16, energy: 0.2, roles: ['pad', 'texture'] },
        { kind: 'verse', bars: 16, energy: 0.4, roles: ['pad', 'sub', 'bass', 'texture'] },
        { kind: 'chorus', bars: 16, energy: 0.7, roles: ['pad', 'sub', 'bass', 'chords', 'lead', 'texture'] },
        { kind: 'breakdown', bars: 16, energy: 0.25, roles: ['pad', 'texture'] },
        { kind: 'chorus', bars: 16, energy: 0.75, roles: ['pad', 'sub', 'bass', 'chords', 'lead', 'arp', 'texture'] },
        { kind: 'outro', bars: 8, energy: 0.15, roles: ['pad', 'texture'] },
      ],
    },
    {
      id: 'ambient-form-minimal',
      style: 'ambient',
      tags: ['minimal', 'short'],
      source: 'own',
      verified: true,
      sections: [
        { kind: 'intro', bars: 8, energy: 0.15, roles: ['pad'] },
        { kind: 'verse', bars: 8, energy: 0.35, roles: ['pad', 'bass', 'texture'] },
        { kind: 'chorus', bars: 8, energy: 0.6, roles: ['pad', 'bass', 'chords', 'lead'] },
        { kind: 'outro', bars: 8, energy: 0.1, roles: ['pad', 'texture'] },
      ],
    },
  ],
  dnb: [
    {
      id: 'dnb-form-standard',
      style: 'dnb',
      tags: ['standard', 'neuro'],
      source: 'own',
      verified: true,
      sections: [
        { kind: 'intro', bars: 8, energy: 0.3, roles: ['kick', 'snare', 'bass'] },
        { kind: 'build', bars: 8, energy: 0.7, roles: ['kick', 'snare', 'hats', 'bass', 'perc'], transition: { into: 'drop', type: 'riser' } },
        { kind: 'drop', bars: 16, energy: 1.0, roles: ['kick', 'snare', 'hats', 'perc', 'sub', 'bass', 'arp'] },
        { kind: 'breakdown', bars: 8, energy: 0.3, roles: ['pad', 'texture', 'bass'] },
        { kind: 'build', bars: 8, energy: 0.75, roles: ['kick', 'snare', 'hats', 'bass'], transition: { into: 'drop', type: 'riser' } },
        { kind: 'drop', bars: 16, energy: 1.0, roles: ['kick', 'snare', 'hats', 'perc', 'sub', 'bass', 'arp', 'lead'] },
        { kind: 'outro', bars: 8, energy: 0.2, roles: ['kick', 'bass', 'texture'] },
      ],
    },
    {
      id: 'dnb-form-long',
      style: 'dnb',
      tags: ['long', 'liquid'],
      source: 'own',
      verified: true,
      sections: [
        { kind: 'intro', bars: 16, energy: 0.25, roles: ['pad', 'texture'] },
        { kind: 'verse', bars: 16, energy: 0.55, roles: ['kick', 'snare', 'hats', 'bass'] },
        { kind: 'drop', bars: 16, energy: 0.95, roles: ['kick', 'snare', 'hats', 'perc', 'sub', 'bass', 'arp'] },
        { kind: 'breakdown', bars: 16, energy: 0.3, roles: ['pad', 'chords', 'lead', 'texture'], transition: { into: 'drop', type: 'build' } },
        { kind: 'drop', bars: 16, energy: 1.0, roles: ['kick', 'snare', 'hats', 'perc', 'sub', 'bass', 'arp', 'lead'] },
        { kind: 'outro', bars: 8, energy: 0.2, roles: ['texture', 'bass'] },
      ],
    },
  ],
  synthwave: [
    {
      id: 'synthwave-form-classic',
      style: 'synthwave',
      tags: ['classic', 'retro'],
      source: 'own',
      verified: true,
      sections: [
        { kind: 'intro', bars: 8, energy: 0.25, roles: ['pad', 'arp'] },
        { kind: 'verse', bars: 16, energy: 0.5, roles: ['kick', 'hats', 'bass', 'arp'] },
        { kind: 'chorus', bars: 16, energy: 0.9, roles: ['kick', 'snare', 'hats', 'bass', 'chords', 'lead', 'arp'] },
        { kind: 'breakdown', bars: 8, energy: 0.3, roles: ['pad', 'lead'], transition: { into: 'chorus', type: 'build' } },
        { kind: 'chorus', bars: 16, energy: 0.95, roles: ['kick', 'snare', 'hats', 'bass', 'chords', 'lead', 'arp'] },
        { kind: 'outro', bars: 8, energy: 0.2, roles: ['pad', 'arp'] },
      ],
    },
  ],
  trap: [
    {
      id: 'trap-form-standard',
      style: 'trap',
      tags: ['standard', '808'],
      source: 'own',
      verified: true,
      sections: [
        { kind: 'intro', bars: 8, energy: 0.3, roles: ['hats', 'sub', 'texture'] },
        { kind: 'verse', bars: 8, energy: 0.5, roles: ['kick', 'hats', 'sub', 'bass'] },
        { kind: 'chorus', bars: 8, energy: 0.85, roles: ['kick', 'snare', 'hats', 'sub', 'bass', 'chords'] },
        { kind: 'breakdown', bars: 4, energy: 0.25, roles: ['pad', 'texture'] },
        { kind: 'chorus', bars: 8, energy: 0.9, roles: ['kick', 'snare', 'hats', 'sub', 'bass', 'chords', 'lead'] },
        { kind: 'outro', bars: 4, energy: 0.2, roles: ['hats', 'texture'] },
      ],
    },
  ],
  jazz: [
    {
      id: 'jazz-form-standard',
      style: 'jazz',
      tags: ['standard', 'head-solos'],
      source: 'own',
      verified: true,
      sections: [
        { kind: 'intro', bars: 8, energy: 0.3, roles: ['kick', 'hats', 'bass'] },
        { kind: 'verse', bars: 8, energy: 0.55, roles: ['kick', 'hats', 'perc', 'bass', 'chords'] },
        { kind: 'chorus', bars: 8, energy: 0.8, roles: ['kick', 'snare', 'hats', 'perc', 'bass', 'chords'] },
        { kind: 'verse', bars: 8, energy: 0.6, roles: ['kick', 'hats', 'perc', 'bass', 'chords', 'lead'] },
        { kind: 'chorus', bars: 8, energy: 0.85, roles: ['kick', 'snare', 'hats', 'perc', 'bass', 'chords', 'lead'] },
        { kind: 'outro', bars: 8, energy: 0.25, roles: ['kick', 'bass', 'chords'] },
      ],
    },
  ],
  rock: [
    {
      id: 'rock-form-verse-chorus',
      style: 'rock',
      tags: ['verse-chorus', 'guitar'],
      source: 'own',
      verified: true,
      sections: [
        { kind: 'intro', bars: 8, energy: 0.4, roles: ['kick', 'hats', 'bass', 'chords'] },
        { kind: 'verse', bars: 8, energy: 0.55, roles: ['kick', 'snare', 'hats', 'bass', 'chords'] },
        { kind: 'chorus', bars: 8, energy: 0.9, roles: ['kick', 'snare', 'hats', 'bass', 'chords', 'lead'] },
        { kind: 'verse', bars: 8, energy: 0.6, roles: ['kick', 'snare', 'hats', 'bass', 'chords'] },
        { kind: 'chorus', bars: 8, energy: 0.95, roles: ['kick', 'snare', 'hats', 'bass', 'chords', 'lead', 'arp'] },
        { kind: 'bridge', bars: 8, energy: 0.5, roles: ['kick', 'hats', 'bass', 'chords'], transition: { into: 'chorus', type: 'build' } },
        { kind: 'chorus', bars: 8, energy: 1.0, roles: ['kick', 'snare', 'hats', 'bass', 'chords', 'lead', 'arp'] },
        { kind: 'outro', bars: 8, energy: 0.3, roles: ['kick', 'hats', 'bass', 'chords'] },
      ],
    },
  ],
  cinematic: [
    {
      id: 'cinematic-form-build-climax',
      style: 'cinematic',
      tags: ['build-climax', 'arc'],
      source: 'own',
      verified: true,
      sections: [
        { kind: 'intro', bars: 8, energy: 0.15, roles: ['pad', 'texture'] },
        { kind: 'build', bars: 16, energy: 0.5, roles: ['sub', 'bass', 'pad', 'perc'], transition: { into: 'chorus', type: 'build' } },
        { kind: 'chorus', bars: 16, energy: 0.85, roles: ['kick', 'snare', 'hats', 'sub', 'bass', 'pad', 'chords', 'lead', 'arp'] },
        { kind: 'breakdown', bars: 8, energy: 0.25, roles: ['pad', 'lead'], transition: { into: 'chorus', type: 'riser' } },
        { kind: 'chorus', bars: 16, energy: 1.0, roles: ['kick', 'snare', 'hats', 'perc', 'sub', 'bass', 'pad', 'chords', 'lead', 'arp'] },
        { kind: 'outro', bars: 8, energy: 0.15, roles: ['pad', 'texture'] },
      ],
    },
    {
      id: 'cinematic-form-long',
      style: 'cinematic',
      tags: ['long', 'scored'],
      source: 'own',
      verified: true,
      sections: [
        { kind: 'intro', bars: 8, energy: 0.12, roles: ['pad', 'texture'] },
        { kind: 'build', bars: 16, energy: 0.45, roles: ['sub', 'bass', 'pad', 'perc'], transition: { into: 'chorus', type: 'build' } },
        { kind: 'chorus', bars: 16, energy: 0.8, roles: ['kick', 'hats', 'sub', 'bass', 'pad', 'chords', 'lead'] },
        { kind: 'breakdown', bars: 8, energy: 0.2, roles: ['pad', 'lead', 'texture'], transition: { into: 'chorus', type: 'riser' } },
        { kind: 'chorus', bars: 16, energy: 0.9, roles: ['kick', 'snare', 'hats', 'perc', 'sub', 'bass', 'pad', 'chords', 'lead', 'arp'] },
        { kind: 'build', bars: 8, energy: 0.6, roles: ['kick', 'hats', 'perc', 'sub', 'bass'], transition: { into: 'chorus', type: 'riser' } },
        { kind: 'chorus', bars: 16, energy: 1.0, roles: ['kick', 'snare', 'hats', 'perc', 'sub', 'bass', 'pad', 'chords', 'lead', 'arp'] },
        { kind: 'outro', bars: 8, energy: 0.1, roles: ['pad', 'texture'] },
      ],
    },
  ],
};

/**
 * Формы для стиля.
 * @param {string} style
 */
export function formsForStyle(style) {
  return FORMS[style] || [];
}

/** Стили, для которых есть формы. */
export const FORM_STYLES = Object.keys(FORMS);

/** Общая длина формы в тактах. */
export function formBars(form) {
  return form.sections.reduce((sum, section) => sum + section.bars, 0);
}
