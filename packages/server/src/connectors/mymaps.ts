import { DOMParser } from "@xmldom/xmldom";
import * as toGeoJSON from "@tmcw/togeojson";
import { stableId } from "../db.js";
import { applyLayerColors, normalizeColor, paletteColor } from "./palette.js";
import type { NormalizedFeature, NormalizedLayer, SourceConfig } from "../types.js";

/**
 * Google My Maps has no API, but every map exposes a KML export. `forcekml=1`
 * matters: without it Google returns a KMZ wrapper whose <NetworkLink> points
 * at the real document, which is a second fetch and loses folder names.
 */
function kmlUrl(mapId: string): string {
  return `https://www.google.com/maps/d/kml?forcekml=1&mid=${encodeURIComponent(mapId)}`;
}

/** KML colors are aabbggrr (alpha first, reversed RGB). CSS wants #rrggbb. */
function kmlColorToHex(kml: string | undefined | null): string | null {
  if (!kml || !/^[0-9a-fA-F]{8}$/.test(kml)) return null;
  const bb = kml.slice(2, 4);
  const gg = kml.slice(4, 6);
  const rr = kml.slice(6, 8);
  return `#${rr}${gg}${bb}`.toLowerCase();
}

interface FolderNode {
  type: "root" | "folder";
  meta?: { name?: string };
  children: (FolderNode | GeoJSON.Feature)[];
}

function isFolder(n: unknown): n is FolderNode {
  return !!n && typeof n === "object" && "children" in (n as object);
}

/**
 * Pulls a hex color out of whatever togeojson managed to resolve from the
 * KML <Style>/<StyleMap>. My Maps writes several spellings depending on
 * geometry type, so check all of them before falling back to the palette.
 */
function featureColor(props: Record<string, unknown>): string | null {
  const direct = props["stroke"] ?? props["fill"] ?? props["icon-color"] ?? props["marker-color"];
  if (typeof direct === "string" && direct.startsWith("#")) return direct.toLowerCase();

  const raw = props["styleUrl"] ?? props["color"];
  if (typeof raw === "string") {
    const hex = kmlColorToHex(raw.replace(/^#/, ""));
    if (hex) return hex;
  }
  return null;
}

export async function syncMyMaps(
  cfg: SourceConfig,
): Promise<{ layers: NormalizedLayer[]; features: NormalizedFeature[] }> {
  const res = await fetch(kmlUrl(cfg.mapId), {
    redirect: "follow",
    headers: { "user-agent": "map-amalgamator/0.1 (personal trip planning)" },
  });

  if (!res.ok) {
    throw new Error(
      res.status === 404
        ? `My Maps returned 404. Check the mid, and that the map is shared as "anyone with the link can view".`
        : `My Maps returned HTTP ${res.status}.`,
    );
  }

  const text = await res.text();
  if (!text.includes("<kml") && !text.includes("<Document")) {
    throw new Error(
      `My Maps did not return KML (got ${text.length} bytes). The map is probably private.`,
    );
  }

  const doc = new DOMParser().parseFromString(text, "text/xml") as unknown as Document;

  const layers: NormalizedLayer[] = [];
  const features: NormalizedFeature[] = [];

  const pushFeature = (f: GeoJSON.Feature, layerId: string) => {
    if (!f.geometry) return;
    const props = { ...(f.properties ?? {}) } as Record<string, unknown>;
    const name = typeof props["name"] === "string" ? props["name"] : null;
    const description =
      typeof props["description"] === "string" ? props["description"] : null;

    features.push({
      id: stableId(cfg.id, layerId, name, JSON.stringify(f.geometry)),
      source: "mymaps",
      sourceKey: cfg.id,
      sourceId: typeof props["id"] === "string" ? props["id"] : null,
      layerId,
      name,
      description,
      // Left null deliberately: applyLayerColors resolves one color per layer
      // once every feature is known, so a folder cannot render multi-coloured.
      color: null,
      geometry: f.geometry,
      props: { ...props, sourceColor: normalizeColor(featureColor(props)) },
      raw: props,
    });
  };

  // A map can mix foldered and loose placemarks. Loose ones still need a
  // sidebar entry, or they would be filtered out of the map entirely.
  let unfiled: NormalizedLayer | null = null;
  const ensureUnfiled = (): NormalizedLayer => {
    if (!unfiled) {
      unfiled = {
        id: stableId(cfg.id, "folder", "__unfiled__"),
        source: "mymaps",
        sourceKey: cfg.id,
        name: "Unfiled",
        color: paletteColor(layers.length),
        sortOrder: 1000,
      };
      layers.push(unfiled);
    }
    return unfiled;
  };

  // kmlWithFolders keeps the <Folder> tree, which is exactly your My Maps
  // layer list. Older togeojson builds lack it, so fall back to a flat parse.
  const withFolders = (toGeoJSON as Record<string, unknown>)["kmlWithFolders"] as
    | ((d: Document) => FolderNode)
    | undefined;

  if (typeof withFolders === "function") {
    const root = withFolders(doc);
    let order = 0;

    const walk = (node: FolderNode, inherited: NormalizedLayer | null) => {
      for (const child of node.children ?? []) {
        if (isFolder(child)) {
          const name = child.meta?.name?.trim() || `Layer ${order + 1}`;
          const layer: NormalizedLayer = {
            id: stableId(cfg.id, "folder", name, String(order)),
            source: "mymaps",
            sourceKey: cfg.id,
            name,
            color: paletteColor(order),
            sortOrder: order++,
          };
          layers.push(layer);
          walk(child, layer);
        } else {
          pushFeature(child as GeoJSON.Feature, (inherited ?? ensureUnfiled()).id);
        }
      }
    };
    walk(root, null);
  }

  // Fallback for a togeojson build without kmlWithFolders: one flat layer.
  if (features.length === 0) {
    const flat = toGeoJSON.kml(doc) as GeoJSON.FeatureCollection;
    const layer: NormalizedLayer = {
      id: stableId(cfg.id, "folder", cfg.label, "0"),
      source: "mymaps",
      sourceKey: cfg.id,
      name: cfg.label,
      color: paletteColor(0),
      sortOrder: 0,
    };
    layers.push(layer);
    for (const f of flat.features) pushFeature(f, layer.id);
  }

  applyLayerColors(layers, features);
  return { layers, features };
}
