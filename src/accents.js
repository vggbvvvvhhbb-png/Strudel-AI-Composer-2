// Акценты партий: jade → mint → teal → lime по кругу.
// Используются для индикаторов в микшере и в визуализациях.
// Ноты пианоролла при этом остаются светлыми (--note).
export const ACCENTS = ['jade', 'mint', 'teal', 'lime'];

export function accentOf(index) {
  return ACCENTS[((index % ACCENTS.length) + ACCENTS.length) % ACCENTS.length];
}
