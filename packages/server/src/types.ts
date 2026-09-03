/**
 * The canonical shape every connector normalizes into.
 *
 * `raw` is deliberately kept verbatim: connectors lose fidelity when they
 * flatten source-specific fields, and re-syncing is cheap but re-deriving lost
 * data is not. Anything a later phase needs (CalTopo marker symbols, My Maps
 * style urls) is still in there.
 */
export type SourceType = "mymaps" | "caltopo" | "gpx" | "takeout";

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

export type SourceConfig = RemoteSourceConfig | FileSourceConfig;

export function isFileSource(c: SourceConfig): c is FileSourceConfig {
  return c.type === "gpx" || c.type === "takeout";
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
  durationMs: number;
}
