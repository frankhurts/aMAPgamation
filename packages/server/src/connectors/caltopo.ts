import { stableId } from "../db.js";
import { applyLayerColors, normalizeColor, paletteColor } from "./palette.js";
import type { NormalizedFeature, NormalizedLayer, SourceConfig } from "../types.js";

/**
 * CalTopo's map export. `since/0` means "all state from the beginning", which
 * is the whole map. This is the same endpoint the web client uses; it works
 * for maps shared publicly or by link, and 401s for private ones.
 */
function apiUrl(mapId: string): string {
  return `https://caltopo.com/api/v1/map/${encodeURIComponent(mapId)}/since/0`;
}

interface CalTopoFeature {
  id?: string;
  geometry?: GeoJSON.Geometry | null;
  properties?: Record<string, unknown>;
}

/** The payload has been wrapped differently across CalTopo versions. */
function extractFeatures(payload: unknown): CalTopoFeature[] {
  const p = payload as Record<string, any>;
  const candidates = [
    p?.result?.state?.features,
    p?.result?.features,
    p?.state?.features,
    p?.features,
  ];
  for (const c of candidates) if (Array.isArray(c)) return c as CalTopoFeature[];
  return [];
}

export async function syncCalTopo(
  cfg: SourceConfig,
): Promise<{ layers: NormalizedLayer[]; features: NormalizedFeature[] }> {
  const res = await fetch(apiUrl(cfg.mapId), {
    headers: {
      accept: "application/json",
      "user-agent": "map-amalgamator/0.1 (personal trip planning)",
    },
  });

  if (!res.ok) {
    throw new Error(
      res.status === 401 || res.status === 403
        ? `CalTopo returned ${res.status}. The map must be shared publicly or via link.`
        : `CalTopo returned HTTP ${res.status}.`,
    );
  }

  const payload = (await res.json()) as unknown;
  const all = extractFeatures(payload);
  if (all.length === 0) {
    throw new Error("CalTopo returned no features. Check the map id.");
  }

  // CalTopo models folders as features with class "Folder" and no geometry.
  const folders = all.filter((f) => f.properties?.["class"] === "Folder");
  const layers: NormalizedLayer[] = folders.map((f, i) => ({
    id: stableId(cfg.id, "folder", String(f.id ?? i)),
    source: "caltopo",
    sourceKey: cfg.id,
    name: (f.properties?.["title"] as string) || `Folder ${i + 1}`,
    color: paletteColor(i),
    sortOrder: i,
  }));

  const layerByFolderId = new Map<string, NormalizedLayer>();
  folders.forEach((f, i) => {
    if (f.id) layerByFolderId.set(String(f.id), layers[i]!);
  });

  // Anything not filed under a folder still needs somewhere to live.
  let unfiled: NormalizedLayer | null = null;
  const ensureUnfiled = (): NormalizedLayer => {
    if (!unfiled) {
      unfiled = {
        id: stableId(cfg.id, "folder", "__unfiled__"),
        source: "caltopo",
        sourceKey: cfg.id,
        // Sits under the "CalTopo" heading already, so repeating the service
        // or the map name here would just be noise.
        name: "Unfiled",
        color: paletteColor(layers.length),
        sortOrder: layers.length + 1000,
      };
      layers.push(unfiled);
    }
    return unfiled;
  };

  const features: NormalizedFeature[] = [];
  for (const f of all) {
    const props = f.properties ?? {};
    if (props["class"] === "Folder" || !f.geometry) continue;

    const folderId = props["folderId"];
    const layer =
      (typeof folderId === "string" ? layerByFolderId.get(folderId) : undefined) ??
      ensureUnfiled();

    const stroke = props["stroke"];
    const fill = props["fill"];
    const sourceColor = normalizeColor(
      (typeof stroke === "string" && stroke) || (typeof fill === "string" && fill) || null,
    );

    features.push({
      id: stableId(cfg.id, String(f.id ?? ""), JSON.stringify(f.geometry)),
      source: "caltopo",
      sourceKey: cfg.id,
      sourceId: f.id ? String(f.id) : null,
      layerId: layer.id,
      name: (props["title"] as string) ?? null,
      description: (props["description"] as string) ?? (props["comments"] as string) ?? null,
      // Resolved per layer by applyLayerColors once all features are known.
      color: null,
      geometry: f.geometry,
      props: {
        sourceColor,
        class: props["class"],
        markerSymbol: props["marker-symbol"],
        // Kept because CalTopo route/track distances are already computed
        // upstream and are annoying to recompute from geometry.
        distance: props["distance"],
      },
      raw: props,
    });
  }

  applyLayerColors(layers, features);
  return { layers, features };
}
