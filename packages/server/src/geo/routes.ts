import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { REPO_ROOT, redactPath } from "../config.js";
import { gpxFilesIn } from "../connectors/gpx.js";
import { featuresInBbox, layerGeometries, lineLayers } from "../db.js";
import { SOURCE_LABELS } from "../types.js";
import {
  Corridor,
  METERS_PER_MILE,
  buildRoute,
  lines,
  simplify,
  type LngLat,
  type Route,
} from "./corridor.js";

/**
 * A route can come from two places, and a ref string names which:
 *
 *   "trips/C-balanced"            a .gpx file or a folder of them, repo-relative
 *   "layer:397607133637c4e2"      the lines in a synced layer (e.g. My Maps)
 *
 * GPX on disk is precise and works offline; a synced layer follows edits made
 * upstream. Neither is privileged — the ref decides.
 */
export type RouteRef = { kind: "file"; path: string } | { kind: "layer"; layerId: string };

/** Carries an HTTP status so the API can tell "not found" from "not usable". */
export class RouteError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404,
  ) {
    super(message);
  }
}

export const MAX_CORRIDOR_MILES = 200;

export function parseRouteRef(ref: string): RouteRef {
  const trimmed = ref.trim();
  if (!trimmed) throw new RouteError("A route is required.", 400);
  if (trimmed.startsWith("layer:")) {
    return { kind: "layer", layerId: trimmed.slice("layer:".length) };
  }
  return { kind: "file", path: trimmed };
}

/**
 * Refs arrive over HTTP, so a path is confined to the repo. The server only
 * listens on localhost, but reading arbitrary files is not something a route
 * picker should be able to do.
 */
function resolveInRepo(path: string): string {
  const abs = resolve(REPO_ROOT, path);
  if (abs !== REPO_ROOT && !abs.startsWith(REPO_ROOT + sep)) {
    throw new RouteError(`Route paths must be inside the repo: ${redactPath(path)}`, 400);
  }
  return abs;
}

interface LoadedRoute {
  ref: string;
  label: string;
  route: Route;
  /** Excluded from corridor matches, so a route does not find itself. */
  layerId?: string;
}

/**
 * Track segments and routes from GPX, as legs.
 *
 * Not the DOM parser the GPX connector uses: building a DOM for a trip's
 * 350,000 trackpoints takes ~5.5 s, and a route needs nothing but the
 * coordinates, which this pulls out in ~100 ms. Each <trkseg> and each <rte>
 * is one leg; waypoints are ignored. Attribute order and quoting are not
 * assumed, since exporters differ.
 */
export function gpxLines(xml: string): LngLat[][] {
  const legs: LngLat[][] = [];
  const block = /<(?:\w+:)?(trkseg|rte)\b[^>]*>([\s\S]*?)<\/(?:\w+:)?\1>/g;
  const point = /<(?:\w+:)?(?:trkpt|rtept)\b([^>]*)>/g;
  const latAttr = /\blat\s*=\s*["']([^"']+)["']/;
  const lonAttr = /\blon\s*=\s*["']([^"']+)["']/;

  for (const [, , body] of xml.matchAll(block)) {
    const leg: LngLat[] = [];
    for (const [, attrs] of body!.matchAll(point)) {
      const lat = Number(latAttr.exec(attrs!)?.[1]);
      const lon = Number(lonAttr.exec(attrs!)?.[1]);
      if (Number.isFinite(lat) && Number.isFinite(lon)) leg.push([lon, lat]);
    }
    if (leg.length >= 2) legs.push(leg);
  }
  return legs;
}

/** What identifies one version of a route's inputs, for cache invalidation. */
function readRef(ref: RouteRef): { version: string; load: () => Omit<LoadedRoute, "ref"> } {
  if (ref.kind === "layer") {
    const found = layerGeometries(ref.layerId);
    if (!found) {
      throw new RouteError(
        `No synced layer "${ref.layerId}" with lines in it. It may have been re-synced ` +
          `under a new id, or hold only points.`,
        404,
      );
    }
    return {
      version: found.layer.updated_at,
      load: () => ({
        label: found.layer.name,
        route: buildRoute(found.geometries.flatMap(lines)),
        layerId: found.layer.id,
      }),
    };
  }

  const abs = resolveInRepo(ref.path);
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    throw new RouteError(`No such route file or folder: ${redactPath(ref.path)}`, 404);
  }
  const files = stat.isDirectory() ? gpxFilesIn(abs) : [abs];
  if (files.length === 0) {
    throw new RouteError(`No .gpx files in ${redactPath(ref.path)}.`, 400);
  }

  return {
    version: files.map((f) => `${basename(f)}@${statSync(f).mtimeMs}`).join("|"),
    load: () => ({
      label: basename(abs, extname(abs)),
      route: buildRoute(files.flatMap((f) => gpxLines(readFileSync(f, "utf8")))),
    }),
  };
}

/**
 * Parsing and chaining a 5,000 mile trip takes a moment and the result only
 * changes when its files or layer do, while a buffer slider asks for it
 * repeatedly. Kept small: a handful of routes is plenty for one session.
 */
const routeCache = new Map<string, LoadedRoute>();
const corridorCache = new Map<string, Corridor>();
const CACHE_LIMIT = 6;

function remember<T>(cache: Map<string, T>, key: string, make: () => T): T {
  const hit = cache.get(key);
  if (hit) {
    // Re-insert so eviction drops the least recently used entry.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const value = make();
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return value;
}

export function loadRoute(ref: string): LoadedRoute {
  const { version, load } = readRef(parseRouteRef(ref));
  const loaded = remember(routeCache, `${ref}#${version}`, () => ({ ref, ...load() }));
  if (loaded.route.pieces.length === 0) {
    throw new RouteError(
      `${loaded.label} has no lines to follow — it holds only waypoints.`,
      400,
    );
  }
  return loaded;
}

export interface RouteSummary {
  ref: string;
  label: string;
  lengthMiles: number;
  legs: number;
  /**
   * Connected stretches. 1 for a clean itinerary; more means alternate legs
   * or a gap, and mile markers after the first break are approximate.
   */
  pieces: number;
}

function summarize(r: LoadedRoute): RouteSummary {
  return {
    ref: r.ref,
    label: r.label,
    lengthMiles: Math.round(r.route.lengthM / METERS_PER_MILE),
    legs: r.route.legs,
    pieces: r.route.pieces.length,
  };
}

export interface CorridorMatch {
  id: string;
  layerId: string | null;
  name: string | null;
  offRouteMiles: number;
  mileMarker: number;
  /** Nearest vertex, so lines and polygons zoom to where they meet the route. */
  lng: number;
  lat: number;
}

/** Every synced feature within `miles` of the route, in travel order. */
export function nearRoute(
  ref: string,
  miles: number,
): { route: RouteSummary; miles: number; matches: CorridorMatch[] } {
  if (!Number.isFinite(miles) || miles <= 0 || miles > MAX_CORRIDOR_MILES) {
    throw new RouteError(`miles must be between 0 and ${MAX_CORRIDOR_MILES}.`, 400);
  }

  const loaded = loadRoute(ref);
  const corridor = remember(
    corridorCache,
    `${loaded.ref}#${loaded.route.lengthM}#${miles}`,
    () => new Corridor(loaded.route, miles * METERS_PER_MILE),
  );

  const matches: CorridorMatch[] = [];
  for (const row of featuresInBbox(corridor.bbox, loaded.layerId)) {
    const hit = corridor.locateGeometry(JSON.parse(row.geometry) as GeoJSON.Geometry);
    if (!hit) continue;
    matches.push({
      id: row.id,
      layerId: row.layer_id,
      name: row.name,
      offRouteMiles: Math.round((hit.offRouteM / METERS_PER_MILE) * 100) / 100,
      mileMarker: Math.round((hit.alongM / METERS_PER_MILE) * 10) / 10,
      lng: hit.at[0],
      lat: hit.at[1],
    });
  }
  matches.sort((a, b) => a.mileMarker - b.mileMarker || a.offRouteMiles - b.offRouteMiles);

  return { route: summarize(loaded), miles, matches };
}

/**
 * The route as display geometry, one line per connected piece, simplified
 * harder than the distance math needs. The UI builds the buffer band from
 * this itself, so dragging the distance slider never waits on the server.
 */
export function routeGeometry(ref: string): {
  route: RouteSummary;
  line: GeoJSON.FeatureCollection<GeoJSON.LineString>;
} {
  const loaded = loadRoute(ref);
  const features = loaded.route.pieces.map(
    (piece): GeoJSON.Feature<GeoJSON.LineString> => ({
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: simplify(piece.coords, 100).map((i) => piece.coords[i]!),
      },
      properties: {},
    }),
  );
  return { route: summarize(loaded), line: { type: "FeatureCollection", features } };
}

export interface RouteCandidate {
  ref: string;
  label: string;
  kind: "file" | "layer";
}

/** Folders never worth offering: dependencies, build output, the DB, docs. */
const SKIP_DIRS = new Set(["node_modules", "packages", "data", "documentation", "dist"]);

/**
 * Routes offered in the picker: synced layers containing lines, then GPX
 * found in the repo — each folder of GPX as a whole route, plus loose files
 * one level down (the merged exports). Individual leg files inside a folder
 * are not listed, though a ref naming one still works.
 */
export function listRouteCandidates(): RouteCandidate[] {
  const out: RouteCandidate[] = lineLayers().map((l) => ({
    ref: `layer:${l.id}`,
    label: `${SOURCE_LABELS[l.source] ?? l.source} · ${l.source_key} › ${l.name} (${l.lines} lines)`,
    kind: "layer",
  }));

  const visit = (dir: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const rel = relative(REPO_ROOT, dir);
    const gpx = entries.filter((e) => e.isFile() && extname(e.name).toLowerCase() === ".gpx");

    if (depth > 0 && gpx.length > 1) {
      out.push({ ref: rel, label: `${rel}/ (${gpx.length} files)`, kind: "file" });
    }
    if (depth <= 1) {
      for (const f of gpx) {
        const ref = join(rel, f.name);
        out.push({ ref, label: ref, kind: "file" });
      }
    }
    if (depth < 2) {
      for (const e of entries) {
        if (e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name)) {
          visit(join(dir, e.name), depth + 1);
        }
      }
    }
  };
  visit(REPO_ROOT, 0);

  return out;
}
