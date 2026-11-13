/**
 * French prose for the reconciliation tests: a base, and two sides that each changed it, with three conflicts and
 * several changes that merge cleanly.
 */
export const base = `Le phare se dressait au bout de la jetée, blanc et seul. Chaque soir, Marthe montait les cent douze marches pour allumer la lanterne.

Elle aimait l’heure où la mer hésitait entre le gris et le bleu. Les bateaux rentraient lentement, et les mouettes se taisaient enfin.

Ce soir-là, pourtant, une lettre l’attendait sur la dernière marche. L’écriture était fine, presque effacée par le sel.`;

/** This device: a word changed, a sentence added, a passage removed, and three edits that meet the other side's. */
export const mine = `Le phare se dressait au bout de la jetée, blanc et solitaire. Chaque soir, la gardienne montait les cent douze marches pour allumer la lanterne.

Elle aimait l’heure où la mer hésitait entre l’ardoise et le bleu. Les bateaux rentraient lentement, et les mouettes se taisaient enfin. Le vent tombait.

Ce soir-là, pourtant, une lettre l’attendait sur la première marche. L’écriture était fine.`;

/** The other device: changes of its own, three of which overlap this device's. */
export const theirs = `Le vieux phare se dressait au bout de la jetée, blanc et seul. Chaque soir, Marthe gravissait les cent douze marches pour allumer la lanterne.

Elle aimait l’heure où la mer hésitait entre le vert et le bleu. Les bateaux rentraient lentement, et les mouettes se taisaient enfin.

Ce soir-là, pourtant, une enveloppe l’attendait sur la dernière marche. L’écriture était fine, presque effacée par les embruns.`;

/**
 * The three paragraphs of the fixture written out by hand as they read once merged, with the clean changes of both
 * sides applied, so the tests compare whole texts against expectations not computed by the merge.
 */
export const merged = (first: string, second: string, third: string) => [first, '', second, '', third].join('\n');
export const opening = (who: string) =>
  `Le vieux phare se dressait au bout de la jetée, blanc et solitaire. Chaque soir, ${who} les cent douze marches pour allumer la lanterne.`;
export const middle = (colour: string) =>
  `Elle aimait l’heure où la mer hésitait entre ${colour}et le bleu. Les bateaux rentraient lentement, et les mouettes se taisaient enfin. Le vent tombait.`;
export const closing = (end: string) =>
  `Ce soir-là, pourtant, une enveloppe l’attendait sur la première marche. L’écriture était fine${end}.`;
