import { DOMParser } from "@xmldom/xmldom";
import * as toGeoJSON from "@tmcw/togeojson";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { stableId } from "../db.js";
import { REPO_ROOT, redactPath } from "../config.js";
import { applyLayerColors, normalizeColor, paletteColor } from "./palette.js";
import type { FileSourceConfig, NormalizedFeature, NormalizedLayer } from "../types.js";

/**
 * GPX import. OnX Backcountry and Offroad have no public API and their terms
 * forbid scraping, so waypoints and tracks come out of the app as GPX — the
 * same format Gaia, AllTrails and Strava export, which this reads too.
 *
 * One layer per file, because the filename is the only grouping GPX offers and
 * it is the part the user controls. Renaming an export renames its layer.
 */
export async function syncGpx(
  cfg: FileSourceConfig,
): Promise<{ layers: NormalizedLayer[]; features: NormalizedFeature[] }> {
  const root = resolve(REPO_ROOT, cfg.path);

  let stat;
  try {
    stat = statSync(root);
  } catch {
    throw new Error(
      `No such path: ${redactPath(cfg.path)}. Point "path" at a .gpx file or a folder of them, ` +
        `relative to the repo root (e.g. "imports/onx").`,
    );
  }

  const files = stat.isDirectory() ? gpxFilesIn(root) : [root];
  if (files.length === 0) {
    throw new Error(`No .gpx files found in ${redactPath(cfg.path)}.`);
  }

  const layers: NormalizedLayer[] = [];
  const features: NormalizedFeature[] = [];

  files.forEach((file, index) => {
    const layer: NormalizedLayer = {
      id: stableId(cfg.id, "file", basename(file)),
      source: "gpx",
      sourceKey: cfg.id,
      // Filename without extension: "Moab dispersed.gpx" -> "Moab dispersed".
      name: basename(file, extname(file)),
      color: paletteColor(index),
      sortOrder: index,
    };

    const parsed = parseGpxFile(file);
    if (parsed.features.length === 0) return;

    layers.push(layer);
    for (const f of parsed.features) {
      if (!f.geometry) continue;
      const props = { ...(f.properties ?? {}) } as Record<string, unknown>;

      features.push({
        id: stableId(cfg.id, layer.id, name(props), JSON.stringify(f.geometry)),
        source: "gpx",
        sourceKey: cfg.id,
        sourceId: null,
        layerId: layer.id,
        name: name(props),
        description: description(props),
        // Resolved per layer once every file is read.
        color: null,
        geometry: f.geometry,
        props: {
          sourceColor: normalizeColor(gpxColor(props)),
          // GPX carries these on tracks; useful later and cheap to keep.
          time: props["time"],
          symbol: props["sym"],
        },
        raw: props,
      });
    }
  });

  if (features.length === 0) {
    throw new Error(
      `Parsed ${files.length} file(s) from ${redactPath(cfg.path)} but found no waypoints, tracks or routes.`,
    );
  }

  applyLayerColors(layers, features);
  return { layers, features };
}

function gpxFilesIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => extname(f).toLowerCase() === ".gpx")
    .sort() // Stable layer order across syncs.
    .map((f) => join(dir, f));
}

function parseGpxFile(file: string): GeoJSON.FeatureCollection {
  const xml = readFileSync(file, "utf8");
  if (!xml.includes("<gpx")) {
    throw new Error(`${basename(file)} is not a GPX file.`);
  }
  const doc = new DOMParser().parseFromString(xml, "text/xml") as unknown as Document;
  return toGeoJSON.gpx(doc) as GeoJSON.FeatureCollection;
}

function name(props: Record<string, unknown>): string | null {
  return typeof props["name"] === "string" && props["name"] ? props["name"] : null;
}

/** GPX splits free text across desc and cmt; either may be the useful one. */
function description(props: Record<string, unknown>): string | null {
  for (const key of ["desc", "cmt", "description"]) {
    const v = props[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

/**
 * Colors are an extension in GPX, not part of the base schema. Garmin and OnX
 * write DisplayColor as a name ("Red"), while togeojson surfaces a resolved
 * hex on `stroke` when the file uses the line extensions.
 */
const NAMED_COLORS: Record<string, string> = {
  black: "#000000", darkred: "#8b0000", darkgreen: "#006400", darkyellow: "#9b870c",
  darkblue: "#00008b", darkmagenta: "#8b008b", darkcyan: "#008b8b", lightgray: "#d3d3d3",
  darkgray: "#a9a9a9", red: "#ff0000", green: "#008000", yellow: "#ffff00",
  blue: "#0000ff", magenta: "#ff00ff", cyan: "#00ffff", white: "#ffffff",
};

function gpxColor(props: Record<string, unknown>): string | null {
  const stroke = props["stroke"];
  if (typeof stroke === "string" && stroke.startsWith("#")) return stroke;

  // togeojson flattens namespaced extensions with an underscore, so Garmin's
  // <gpxx:DisplayColor> arrives as `gpxx_DisplayColor` rather than the bare
  // element name.
  const named =
    props["gpxx_DisplayColor"] ?? props["DisplayColor"] ?? props["displaycolor"];
  if (typeof named === "string") {
    return NAMED_COLORS[named.toLowerCase().replace(/\s+/g, "")] ?? null;
  }
  return null;
}
