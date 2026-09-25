/**
 * The vocabulary every corridor provider normalizes into.
 *
 * Providers disagree about names for the same thing — BLM says "Campsite -
 * Primitive", OSM says `tourism=camp_site` + `backcountry=yes` — so each
 * provider maps its own terms onto this list, and everything downstream (the
 * per-category buffer, the layer it lands in, its color) keys off it.
 *
 * Kept deliberately short. A category earns its place by having a different
 * answer to "how far off-route would I still detour for this?" — which is
 * exactly what `defaultMiles` encodes.
 */
export const CATEGORIES = {
  camping: {
    label: "Camping",
    /** Worth a long detour: it decides where the day ends. */
    defaultMiles: 25,
    color: "#2e7d32",
  },
  dispersed: {
    label: "Dispersed camping",
    defaultMiles: 25,
    color: "#7cb342",
  },
  fuel: {
    label: "Fuel",
    /** Short: a gas station 20 miles off-route is not a gas station. */
    defaultMiles: 5,
    color: "#e65100",
  },
  water: {
    label: "Drinking water",
    defaultMiles: 5,
    color: "#0277bd",
  },
  groceries: {
    label: "Groceries",
    defaultMiles: 10,
    color: "#6a1b9a",
  },
  dump: {
    label: "Dump stations",
    defaultMiles: 25,
    color: "#5d4037",
  },
  toilets: {
    label: "Toilets",
    defaultMiles: 10,
    color: "#00838f",
  },
  showers: {
    label: "Showers",
    defaultMiles: 25,
    color: "#00acc1",
  },
  ranger: {
    label: "Ranger stations",
    defaultMiles: 25,
    color: "#c62828",
  },
} as const;

export type Category = keyof typeof CATEGORIES;

export const CATEGORY_KEYS = Object.keys(CATEGORIES) as Category[];

export function isCategory(s: string): s is Category {
  return Object.hasOwn(CATEGORIES, s);
}

/**
 * Resolves the configured buffers against the defaults.
 *
 * A category the user did not mention keeps its default rather than being
 * dropped: `"buffers": { "fuel": 10 }` means "fuel reaches further than I
 * said", not "fetch nothing but fuel". Narrowing what is fetched is what
 * `categories` is for.
 */
export function resolveBuffers(
  configured: Record<string, number> | undefined,
  only: string[] | undefined,
): Map<Category, number> {
  const wanted = only?.length
    ? only.filter(isCategory)
    : CATEGORY_KEYS;

  const out = new Map<Category, number>();
  for (const key of wanted) {
    const miles = configured?.[key];
    out.set(key, typeof miles === "number" && miles > 0 ? miles : CATEGORIES[key].defaultMiles);
  }
  return out;
}

/** Names in `categories` or `buffers` that match nothing, for a clear error. */
export function unknownCategories(cfg: {
  buffers?: Record<string, number>;
  categories?: string[];
}): string[] {
  const named = [...(cfg.categories ?? []), ...Object.keys(cfg.buffers ?? {})];
  return [...new Set(named.filter((n) => !isCategory(n)))];
}
