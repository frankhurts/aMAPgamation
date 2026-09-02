import type { NormalizedFeature, NormalizedLayer } from "../types.js";

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

/**
 * Collapses each layer to a single color, so everything under one sidebar item
 * renders identically and the sidebar swatch actually predicts what is on the
 * map.
 *
 * The layer adopts whichever color most of its features already carried
 * upstream — a My Maps folder styled all-green stays green instead of jumping
 * to an arbitrary palette entry — and falls back to the palette color the
 * connector pre-assigned when a folder has no styling at all.
 *
 * Per-feature styling is not discarded: it stays on `props.sourceColor` so the
 * styling/templating pass can offer "revert to source colors" later.
 */
export function applyLayerColors(
  layers: NormalizedLayer[],
  features: NormalizedFeature[],
): void {
  const byLayer = new Map<string, NormalizedFeature[]>();
  for (const f of features) {
    if (!f.layerId) continue;
    const list = byLayer.get(f.layerId) ?? [];
    list.push(f);
    byLayer.set(f.layerId, list);
  }

  for (const layer of layers) {
    const members = byLayer.get(layer.id) ?? [];

    // Ties resolve to the first color encountered, and feature order is stable
    // across syncs, so a layer's color does not flicker between runs.
    const counts = new Map<string, number>();
    for (const f of members) {
      const c = f.props["sourceColor"];
      if (typeof c === "string" && c) counts.set(c, (counts.get(c) ?? 0) + 1);
    }

    let dominant: string | null = null;
    let best = 0;
    for (const [color, n] of counts) {
      if (n > best) {
        dominant = color;
        best = n;
      }
    }

    layer.color = dominant ?? layer.color;
    for (const f of members) f.color = layer.color;
  }
}

/** Hex colors are compared as strings, so casing must not split a group. */
export function normalizeColor(c: string | null | undefined): string | null {
  if (typeof c !== "string" || !c) return null;
  const hex = c.startsWith("#") ? c : `#${c}`;
  return /^#[0-9a-fA-F]{3,8}$/.test(hex) ? hex.toLowerCase() : null;
}
