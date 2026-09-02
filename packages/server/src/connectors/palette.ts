/**
 * Fallback layer colors, used when a source gives us no styling of its own.
 * Chosen to stay legible over both topo and satellite basemaps.
 */
const PALETTE = [
  "#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4",
  "#008080", "#f032e6", "#bcf60c", "#9a6324", "#800000",
  "#808000", "#000075", "#e6beff", "#fabebe", "#469990",
];

export function paletteColor(index: number): string {
  return PALETTE[index % PALETTE.length]!;
}
