/**
 * The canonical shape every connector normalizes into.
 *
 * `raw` is deliberately kept verbatim: connectors lose fidelity when they
 * flatten source-specific fields, and re-syncing is cheap but re-deriving lost
 * data is not. Anything a later phase needs (CalTopo marker symbols, My Maps
 * style urls) is still in there.
 */
export type SourceType = "mymaps" | "caltopo" | "gpx" | "takeout" | "corridor";

/**
 * How each service is named in the UI. Distinct from a SourceConfig's `id`
 * (a config key like "roadtrip-main") and its `label` (which names one
 * particular map) — this names the service the data came from.
 */
export const SOURCE_LABELS: Record<SourceType, string> = {
  mymaps: "MyMaps",
  caltopo: "CalTopo",
  gpx: "GPX",
  takeout: "Google Saved Places",
  corridor: "Along Route",
};

interface SourceConfigBase {
  /** Stable local key, used to namespace ids. Safe to appear in the UI. */
  id: string;
  label: string;
  enabled?: boolean;
}

/** Sources fetched from a service by a share-token-ish map id. */
export interface RemoteSourceConfig extends SourceConfigBase {
  type: "mymaps" | "caltopo";
  /** Never logged in full — see redactMapId. */
  mapId: string;
}

/**
 * Sources read from files on disk. OnX has no API and its terms forbid
 * scraping, so its data arrives as exported GPX; the same connector covers
 * Gaia, AllTrails and Strava exports.
 */
export interface FileSourceConfig extends SourceConfigBase {
  type: "gpx" | "takeout";
  /** File or directory, absolute or relative to the repo root. */
  path: string;
}

/**
 * A corridor source fetches public-land and services data along a route,
 * instead of importing a map somebody already drew.
 *
 * It is addressed by `route` — the same ref the Along route tab uses, so a
 * trip folder of GPX or a synced layer of lines both work — plus how far off
 * that route each kind of thing is still worth knowing about.
 */
export interface CorridorSourceConfig extends SourceConfigBase {
  type: "corridor";
  /** A route ref: "trips/C-balanced", a .gpx file, or "layer:<id>". */
  route: string;
  /** Miles off-route per category. Omitted categories use their defaults. */
  buffers?: Record<string, number>;
  /** Defaults to every provider that is usable without a key. */
  providers?: string[];
  /** Categories to fetch. Defaults to all of them. */
  categories?: string[];
}

export type SourceConfig = RemoteSourceConfig | FileSourceConfig | CorridorSourceConfig;

export function isFileSource(c: SourceConfig): c is FileSourceConfig {
  return c.type === "gpx" || c.type === "takeout";
}

export function isCorridorSource(c: SourceConfig): c is CorridorSourceConfig {
  return c.type === "corridor";
}

export interface NormalizedLayer {
  /** Deterministic: hash(source, sourceMapId, upstream folder id/name). */
  id: string;
  source: SourceType;
  sourceKey: string;
  name: string;
  color: string | null;
  sortOrder: number;
}

export interface NormalizedFeature {
  id: string;
  source: SourceType;
  sourceKey: string;
  sourceId: string | null;
  layerId: string | null;
  name: string | null;
  description: string | null;
  color: string | null;
  geometry: GeoJSON.Geometry;
  props: Record<string, unknown>;
  raw: Record<string, unknown>;
}

export interface SyncResult {
  sourceKey: string;
  type: SourceType;
  label: string;
  ok: boolean;
  layers: number;
  features: number;
  error?: string;
  /**
   * Things worth saying that are not failures: a provider skipped for want of
   * an API key, one provider down while the rest succeeded, cache hit counts.
   * A corridor sync can half-work in ways a map import cannot.
   */
  notes?: string[];
  durationMs: number;
}
