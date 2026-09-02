import type { StyleSpecification } from "maplibre-gl";

/**
 * All key-free. OpenTopoMap and Esri imagery are raster tiles under usage
 * policies that permit personal use — do not bulk-download or rehost them.
 * Phase 3 swaps these for local PMTiles, which is what makes offline work.
 */
function raster(
  tiles: string[],
  attribution: string,
  maxzoom = 17,
): StyleSpecification {
  return {
    version: 8,
    sources: {
      base: { type: "raster", tiles, tileSize: 256, maxzoom, attribution },
    },
    layers: [{ id: "base", type: "raster", source: "base" }],
  };
}

export const BASEMAPS = {
  topo: {
    label: "Topo",
    style: raster(
      ["https://a.tile.opentopomap.org/{z}/{x}/{y}.png"],
      '&copy; OpenStreetMap contributors, SRTM | &copy; OpenTopoMap (CC-BY-SA)',
      17,
    ),
  },
  satellite: {
    label: "Satellite",
    style: raster(
      [
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      ],
      "Imagery &copy; Esri, Maxar, Earthstar Geographics",
      19,
    ),
  },
  streets: {
    label: "Streets",
    style: "https://tiles.openfreemap.org/styles/liberty" as unknown as StyleSpecification,
  },
} as const;

export type BasemapKey = keyof typeof BASEMAPS;
