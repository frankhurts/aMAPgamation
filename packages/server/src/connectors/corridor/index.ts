import { stableId } from "../../db.js";
import { Corridor, METERS_PER_MILE, haversine, queryChunks } from "../../geo/corridor.js";
import { loadRoute } from "../../geo/routes.js";
import { CATEGORIES, resolveBuffers, type Category } from "./categories.js";
import type { CacheStats } from "./cache.js";
import type { NormalizedFeature, NormalizedLayer, CorridorSourceConfig } from "../../types.js";
import type { Provider, ProviderContext, RawSite } from "./provider.js";
import { blm } from "./blm.js";
import { osm } from "./osm.js";
import { ridb } from "./ridb.js";

const PROVIDERS: Provider[] = [blm, ridb, osm];

/**
 * Providers that need no API key, so a fresh clone syncs something useful.
 * RIDB is opt-in: listing it without a key should be a clear warning, not a
 * warning every user sees on every sync.
 */
const DEFAULT_PROVIDERS = ["blm", "osm"];

/**
 * How far the decimated query polyline may stray from the true route.
 *
 * Whatever this is, it is added to every query radius and then taken back off
 * by the exact local measurement, so its only real cost is a little
 * over-fetching. 800 m (half a mile) cuts a recorded track down by orders of
 * magnitude while staying far inside the smallest buffer anyone would set.
 */
const DECIMATE_M = Number(process.env.CORRIDOR_DECIMATE_M ?? 800);

/**
 * Two records of one place rarely agree on its coordinates to better than a
 * couple hundred meters.
 *
 * What counts as a duplicate depends on where the two records came from:
 *
 * - **Across providers**, proximity alone is enough. BLM and OSM name the same
 *   campground differently often enough that requiring the names to match
 *   would merge almost nothing.
 * - **Within one provider**, the names must match too. OSM maps a campground
 *   as an area *and* a node inside it, so `out center` genuinely returns the
 *   same place two or three times — but two unnamed pumps either side of a
 *   junction are two real gas stations, and proximity alone would delete one.
 */
const DEDUPE_M = 150;

/** Grid cell for the dedupe index; comfortably wider than DEDUPE_M. */
const DEDUPE_CELL = 0.005;

export interface CorridorSyncResult {
  layers: NormalizedLayer[];
  features: NormalizedFeature[];
  notes: string[];
}

/**
 * Fetches public-land and services data along a route.
 *
 * Unlike every other connector, this one has no upstream map to mirror — it
 * asks several agencies what exists near a line. The shape of the work is
 * therefore inverted: providers fetch coarsely against a simplified polyline,
 * and this module is what decides the truth, measuring every result against
 * the full-resolution route and dropping whatever a provider over-returned.
 *
 * Everything lands in the ordinary layers/features tables, one layer per
 * category, so sidebar toggles, colors, popups and `--prune` work unchanged.
 */
export async function syncCorridor(cfg: CorridorSourceConfig): Promise<CorridorSyncResult> {
  const loaded = loadRoute(cfg.route);
  const buffers = resolveBuffers(cfg.buffers, cfg.categories);
  if (buffers.size === 0) {
    throw new Error(
      `Source "${cfg.id}" asks for no categories. Remove "categories" to fetch all of them.`,
    );
  }

  const wanted = cfg.providers?.length ? cfg.providers : DEFAULT_PROVIDERS;
  const unknown = wanted.filter((w) => !PROVIDERS.some((p) => p.id === w));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown provider(s) ${unknown.map((u) => `"${u}"`).join(", ")} in source "${cfg.id}". ` +
        `Available: ${PROVIDERS.map((p) => p.id).join(", ")}.`,
    );
  }

  const notes: string[] = [];
  const stats: CacheStats = { hits: 0, misses: 0 };
  const ctx: ProviderContext = {
    chunks: (maxPoints) => queryChunks(loaded.route, DECIMATE_M, maxPoints),
    routeKey: `${cfg.route}#${Math.round(loaded.route.lengthM)}#${loaded.route.pieces.length}`,
    buffers,
    slackM: DECIMATE_M,
    stats,
    warn: (m) => notes.push(m),
  };

  // Serial, not parallel: these are free, volunteer-run or government services
  // with real rate limits, and the whole point of the cache is that a sync is
  // cheap after the first one. Ordered so authoritative sources win dedupe.
  const sites: { site: RawSite; provider: Provider }[] = [];
  for (const provider of PROVIDERS) {
    if (!wanted.includes(provider.id)) continue;

    const usable = provider.usable();
    if (!usable.ok) {
      notes.push(`${provider.label} skipped — ${usable.why}`);
      continue;
    }

    try {
      const found = await provider.fetch(ctx);
      for (const site of found) sites.push({ site, provider });
    } catch (err) {
      // One provider being down must not throw away the others' results. A
      // corridor with BLM camping but no OSM fuel is still worth having, and
      // the note says exactly what is missing.
      notes.push(`${provider.label} failed — ${(err as Error).message}`);
    }
  }

  const { features, kept } = measure(cfg, loaded.route, buffers, sites);
  notes.push(
    `${kept.fetched} fetched, ${kept.outside} outside the corridor, ` +
      `${kept.duplicate} duplicate, ${features.length} kept ` +
      `(cache ${stats.hits} hit / ${stats.misses} miss)`,
  );

  const layers = layersFor(cfg, features);
  return { layers, features, notes };
}

/**
 * Measures every fetched site against the real route and keeps what belongs.
 *
 * This is where a provider's approximations are undone. The corridor used here
 * is built from the full-resolution route at the exact buffer the user asked
 * for, so `offRouteMiles` and `mileMarker` mean the same thing for an OSM node
 * and a BLM point, regardless of what polyline either query actually used.
 */
function measure(
  cfg: CorridorSourceConfig,
  route: ReturnType<typeof loadRoute>["route"],
  buffers: Map<Category, number>,
  sites: { site: RawSite; provider: Provider }[],
): { features: NormalizedFeature[]; kept: { fetched: number; outside: number; duplicate: number } } {
  // One corridor per distinct distance, not per category: fuel and water both
  // at 5 miles share the index rather than building it twice.
  const corridors = new Map<number, Corridor>();
  const corridorFor = (miles: number) => {
    let c = corridors.get(miles);
    if (!c) {
      c = new Corridor(route, miles * METERS_PER_MILE);
      corridors.set(miles, c);
    }
    return c;
  };

  const features: NormalizedFeature[] = [];
  // Bucketed by grid cell rather than scanned linearly: a cross-country
  // corridor is tens of thousands of sites, and comparing every one against
  // every earlier one is quadratic.
  const seen = new Map<string, Kept[]>();
  let outside = 0;
  let duplicate = 0;

  for (const { site, provider } of sites) {
    const miles = buffers.get(site.category);
    if (miles === undefined) continue;

    const hit = corridorFor(miles).locate([site.lng, site.lat]);
    if (!hit) {
      outside++;
      continue;
    }

    // Providers run in priority order, so the first record of a place wins and
    // an agency's listing beats a crowdsourced one for the same campground.
    const kept: Kept = {
      lng: site.lng,
      lat: site.lat,
      category: site.category,
      provider: provider.id,
      key: nameKey(site.name),
    };
    if (isDuplicate(seen, kept)) {
      duplicate++;
      continue;
    }
    remember(seen, kept);

    const category = CATEGORIES[site.category];
    features.push({
      // Coordinates are in the id because several providers have no stable id
      // of their own; a site that moves is a new row, which is correct.
      id: stableId(cfg.id, site.category, provider.id, site.sourceId ?? `${site.lng},${site.lat}`),
      source: "corridor",
      sourceKey: cfg.id,
      sourceId: site.sourceId,
      layerId: layerId(cfg, site.category),
      name: site.name ?? category.label,
      description: site.description,
      color: category.color,
      geometry: { type: "Point", coordinates: [site.lng, site.lat] },
      props: {
        sourceColor: category.color,
        provider: provider.id,
        providerLabel: provider.label,
        category: site.category,
        categoryLabel: category.label,
        // The two numbers the whole feature exists to answer.
        offRouteMiles: Math.round((hit.offRouteM / METERS_PER_MILE) * 100) / 100,
        mileMarker: Math.round((hit.alongM / METERS_PER_MILE) * 10) / 10,
        ...site.detail,
      },
      raw: site.raw,
    });
  }

  features.sort(
    (a, b) => (a.props["mileMarker"] as number) - (b.props["mileMarker"] as number),
  );
  return { features, kept: { fetched: sites.length, outside, duplicate } };
}

interface Kept {
  lng: number;
  lat: number;
  category: Category;
  provider: string;
  /** Normalized name, or null when the record had none. */
  key: string | null;
}

/** Names are compared loosely: "Goose Island CG" and "Goose Island cg" are one. */
function nameKey(name: string | null): string | null {
  const k = name?.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return k ? k : null;
}

function cellsAround({ lng, lat }: Kept): string[] {
  const cx = Math.floor(lng / DEDUPE_CELL);
  const cy = Math.floor(lat / DEDUPE_CELL);
  const out: string[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) out.push(`${cx + dx}:${cy + dy}`);
  }
  return out;
}

function isDuplicate(seen: Map<string, Kept[]>, site: Kept): boolean {
  for (const cell of cellsAround(site)) {
    for (const s of seen.get(cell) ?? []) {
      if (s.category !== site.category) continue;
      if (haversine([s.lng, s.lat], [site.lng, site.lat]) >= DEDUPE_M) continue;
      // Same provider: only the same *named* place counts as a repeat.
      if (s.provider === site.provider && (site.key === null || s.key !== site.key)) continue;
      return true;
    }
  }
  return false;
}

function remember(seen: Map<string, Kept[]>, site: Kept): void {
  // Stored in its own cell only; the 3x3 read is what covers the boundaries.
  const cell = `${Math.floor(site.lng / DEDUPE_CELL)}:${Math.floor(site.lat / DEDUPE_CELL)}`;
  const bucket = seen.get(cell);
  // Pushed rather than rebuilt: around Moab one cell holds hundreds of
  // campsites, and copying the bucket per insert makes this quadratic again.
  if (bucket) bucket.push(site);
  else seen.set(cell, [site]);
}

function layerId(cfg: CorridorSourceConfig, category: Category): string {
  return stableId(cfg.id, "category", category);
}

/**
 * One layer per category, not per provider.
 *
 * The question being asked is "where can I camp", not "what does BLM think" —
 * so BLM campgrounds and OSM campsites belong under one toggle, with the
 * provider on each feature for the popup. Empty categories produce no layer,
 * so the sidebar does not fill with zeroes for things the route has none of.
 */
function layersFor(
  cfg: CorridorSourceConfig,
  features: NormalizedFeature[],
): NormalizedLayer[] {
  const used = new Set(features.map((f) => f.props["category"] as Category));
  return [...used]
    .sort((a, b) => Object.keys(CATEGORIES).indexOf(a) - Object.keys(CATEGORIES).indexOf(b))
    .map((category, index) => ({
      id: layerId(cfg, category),
      source: "corridor" as const,
      sourceKey: cfg.id,
      name: CATEGORIES[category].label,
      color: CATEGORIES[category].color,
      sortOrder: index,
    }));
}
