import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { DATA_DIR, DB_PATH, loadSources } from "./config.js";
import { SOURCE_LABELS } from "./types.js";
import type { NormalizedFeature, NormalizedLayer, SourceType } from "./types.js";

mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS layers (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL,
  source_key  TEXT NOT NULL,
  name        TEXT NOT NULL,
  color       TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS features (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL,
  source_key  TEXT NOT NULL,
  source_id   TEXT,
  layer_id    TEXT,
  name        TEXT,
  description TEXT,
  color       TEXT,
  geom_type   TEXT NOT NULL,
  geometry    TEXT NOT NULL,
  props       TEXT NOT NULL,
  raw         TEXT NOT NULL,
  minx REAL, miny REAL, maxx REAL, maxy REAL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_features_layer  ON features(layer_id);
CREATE INDEX IF NOT EXISTS idx_features_source ON features(source_key);
CREATE INDEX IF NOT EXISTS idx_layers_source   ON layers(source_key);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

/** Deterministic ids so re-syncing a map does not churn every row. */
export function stableId(...parts: (string | null | undefined)[]): string {
  return createHash("sha1")
    .update(parts.map((p) => p ?? "").join("|"))
    .digest("hex")
    .slice(0, 16);
}

function bbox(geom: GeoJSON.Geometry): [number, number, number, number] {
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;

  const walk = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") {
      const [x, y] = c as [number, number];
      if (x < minx) minx = x;
      if (y < miny) miny = y;
      if (x > maxx) maxx = x;
      if (y > maxy) maxy = y;
      return;
    }
    for (const child of c) walk(child);
  };

  if (geom.type === "GeometryCollection") {
    geom.geometries.forEach((g) => walk((g as { coordinates?: unknown }).coordinates));
  } else {
    walk((geom as { coordinates?: unknown }).coordinates);
  }
  return Number.isFinite(minx) ? [minx, miny, maxx, maxy] : [0, 0, 0, 0];
}

const delLayers = db.prepare(`DELETE FROM layers WHERE source_key = ?`);
const delFeatures = db.prepare(`DELETE FROM features WHERE source_key = ?`);

const insLayer = db.prepare(`
  INSERT INTO layers (id, source, source_key, name, color, sort_order, updated_at)
  VALUES (@id, @source, @sourceKey, @name, @color, @sortOrder, @updatedAt)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name, color = excluded.color,
    sort_order = excluded.sort_order, updated_at = excluded.updated_at
`);

const insFeature = db.prepare(`
  INSERT INTO features (id, source, source_key, source_id, layer_id, name, description,
                        color, geom_type, geometry, props, raw, minx, miny, maxx, maxy, updated_at)
  VALUES (@id, @source, @sourceKey, @sourceId, @layerId, @name, @description,
          @color, @geomType, @geometry, @props, @raw, @minx, @miny, @maxx, @maxy, @updatedAt)
  ON CONFLICT(id) DO UPDATE SET
    layer_id = excluded.layer_id, name = excluded.name, description = excluded.description,
    color = excluded.color, geometry = excluded.geometry, props = excluded.props,
    raw = excluded.raw, minx = excluded.minx, miny = excluded.miny,
    maxx = excluded.maxx, maxy = excluded.maxy, updated_at = excluded.updated_at
`);

/**
 * Replaces everything belonging to one source, atomically. Scoping the delete
 * to `source_key` is what lets you re-sync a single My Maps map without
 * touching CalTopo data or hand-imported GPX tracks.
 */
export const replaceSource = db.transaction(
  (sourceKey: string, layers: NormalizedLayer[], features: NormalizedFeature[]) => {
    const updatedAt = new Date().toISOString();
    delFeatures.run(sourceKey);
    delLayers.run(sourceKey);

    for (const l of layers) {
      insLayer.run({ ...l, updatedAt });
    }
    for (const f of features) {
      const [minx, miny, maxx, maxy] = bbox(f.geometry);
      insFeature.run({
        id: f.id,
        source: f.source,
        sourceKey: f.sourceKey,
        sourceId: f.sourceId,
        layerId: f.layerId,
        name: f.name,
        description: f.description,
        color: f.color,
        geomType: f.geometry.type,
        geometry: JSON.stringify(f.geometry),
        props: JSON.stringify(f.props),
        raw: JSON.stringify(f.raw),
        minx,
        miny,
        maxx,
        maxy,
        updatedAt,
      });
    }
  },
);

export interface LayerRow {
  id: string;
  source: SourceType;
  source_key: string;
  /** Display name of the originating service, e.g. "CalTopo". */
  source_label: string;
  /** Display name of the individual map, e.g. "Road Trip - Utah". */
  map_label: string;
  name: string;
  color: string | null;
  sort_order: number;
  updated_at: string;
  feature_count: number;
}

/**
 * The sidebar nests service -> map -> layer, so rows carry both labels.
 *
 * Both are derived on read rather than stored: renaming a map in sources.json
 * should take effect without re-syncing it. `mapLabels` is injectable so tests
 * can supply labels without writing to the real config file; in production it
 * comes from sources.json.
 *
 * A map dropped from sources.json while its data is still in the DB falls back
 * to its config key, so orphaned layers stay identifiable rather than blank.
 */
export function listLayers(mapLabels?: Map<string, string>): LayerRow[] {
  const rows = db
    .prepare(
      `SELECT l.*, (SELECT COUNT(*) FROM features f WHERE f.layer_id = l.id) AS feature_count
       FROM layers l
       ORDER BY l.source, l.source_key, l.sort_order, l.name`,
    )
    .all() as Omit<LayerRow, "source_label" | "map_label">[];

  const labels = mapLabels ?? configuredLabels();

  // Maps appear in the order they are listed in sources.json rather than
  // alphabetically by config key, so the sidebar mirrors the file the user
  // actually edits. Anything no longer in the config sorts last.
  const configOrder = new Map([...labels.keys()].map((key, i) => [key, i]));

  return rows
    .map((r) => ({
      ...r,
      source_label: SOURCE_LABELS[r.source] ?? r.source,
      map_label: labels.get(r.source_key) ?? r.source_key,
    }))
    // Stable sort, so the SQL ORDER BY still decides layer order within a map.
    .sort(
      (a, b) =>
        (configOrder.get(a.source_key) ?? Infinity) -
        (configOrder.get(b.source_key) ?? Infinity),
    );
}

export function featureCollection(layerIds?: string[]): GeoJSON.FeatureCollection {
  const rows = (
    layerIds?.length
      ? db
          .prepare(
            `SELECT * FROM features WHERE layer_id IN (${layerIds.map(() => "?").join(",")})`,
          )
          .all(...layerIds)
      : db.prepare(`SELECT * FROM features`).all()
  ) as Record<string, string>[];

  return {
    type: "FeatureCollection",
    features: rows.map((r) => ({
      type: "Feature" as const,
      id: r.id,
      geometry: JSON.parse(r.geometry!) as GeoJSON.Geometry,
      properties: {
        ...(JSON.parse(r.props!) as Record<string, unknown>),
        id: r.id,
        source: r.source,
        sourceKey: r.source_key,
        layerId: r.layer_id,
        name: r.name,
        description: r.description,
        color: r.color,
      },
    })),
  };
}

/**
 * Map labels for display. A broken config degrades to showing config keys
 * rather than blanking the sidebar: labels are cosmetic, so you can still read
 * already-synced data while fixing sources.json.
 *
 * Deliberately NOT used by findOrphanedSources — see the note there.
 */
function configuredLabels(): Map<string, string> {
  try {
    return new Map(loadSources(true).map((s) => [s.id, s.label]));
  } catch {
    return new Map();
  }
}

export interface StoredSource {
  source_key: string;
  layers: number;
  features: number;
}

/**
 * Every source_key the DB holds, including ones no longer in sources.json.
 * Renaming a source's `id` leaves its old rows behind, since deletes are
 * scoped to source_key — this is how those orphans are found.
 */
export function listStoredSources(): StoredSource[] {
  return db
    .prepare(
      `SELECT k.source_key,
              (SELECT COUNT(*) FROM layers   WHERE source_key = k.source_key) AS layers,
              (SELECT COUNT(*) FROM features WHERE source_key = k.source_key) AS features
       FROM (SELECT source_key FROM layers UNION SELECT source_key FROM features) k
       ORDER BY k.source_key`,
    )
    .all() as StoredSource[];
}

/** Drops one source's rows entirely. Used to clear orphans after a rename. */
export const deleteSource = db.transaction((sourceKey: string) => {
  const features = delFeatures.run(sourceKey).changes;
  const layers = delLayers.run(sourceKey).changes;
  return { sourceKey, layers, features };
});

/**
 * Source keys present in the DB but absent from sources.json. Disabled sources
 * are deliberately not orphans — turning a map off should not delete it.
 */
export function findOrphanedSources(knownKeys?: Set<string>): StoredSource[] {
  // No error swallowing here, unlike configuredLabels. If the config cannot be
  // read, the set of known sources is unknown, and treating an unknown set as
  // empty would mark every source an orphan — arming --prune to wipe the
  // database. A config error must propagate and stop the caller.
  const known = knownKeys ?? new Set(loadSources(true).map((s) => s.id));
  return listStoredSources().filter((s) => !known.has(s.source_key));
}

export function stats() {
  const f = db.prepare(`SELECT COUNT(*) AS n FROM features`).get() as { n: number };
  const l = db.prepare(`SELECT COUNT(*) AS n FROM layers`).get() as { n: number };
  return { features: f.n, layers: l.n };
}
