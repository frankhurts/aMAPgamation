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

export interface SourceConfig {
  type: SourceType;
  /** Stable local key, used to namespace ids. Safe to appear in the UI. */
  id: string;
  label: string;
  /** Share-token-ish id from the upstream service. Never logged in full. */
  mapId: string;
  enabled?: boolean;
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
