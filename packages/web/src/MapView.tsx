import { useEffect, useMemo, useRef } from "react";
import maplibregl, { type Map as MLMap } from "maplibre-gl";
import { BASEMAPS, type BasemapKey } from "./basemaps";

const SRC = "amalgamated";

interface Props {
  data: GeoJSON.FeatureCollection;
  visibleLayerIds: Set<string>;
  basemap: BasemapKey;
  fitKey: number;
}

/**
 * Feature-level styling is driven entirely by each feature's own `color`
 * property, which the server resolves (feature style -> layer color ->
 * palette). That keeps the paint spec static and means a layer toggle is
 * just a setData call rather than a style rebuild.
 */
function addDataLayers(map: MLMap, data: GeoJSON.FeatureCollection) {
  if (map.getSource(SRC)) return;

  map.addSource(SRC, { type: "geojson", data });

  map.addLayer({
    id: `${SRC}-fill`,
    type: "fill",
    source: SRC,
    filter: ["match", ["geometry-type"], ["Polygon", "MultiPolygon"], true, false],
    paint: {
      "fill-color": ["coalesce", ["get", "color"], "#4363d8"],
      "fill-opacity": 0.25,
    },
  });

  map.addLayer({
    id: `${SRC}-line`,
    type: "line",
    source: SRC,
    filter: [
      "match",
      ["geometry-type"],
      ["LineString", "MultiLineString", "Polygon", "MultiPolygon"],
      true,
      false,
    ],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ["coalesce", ["get", "color"], "#4363d8"],
      "line-width": ["interpolate", ["linear"], ["zoom"], 6, 1.5, 12, 3.5, 16, 5],
    },
  });

  map.addLayer({
    id: `${SRC}-point`,
    type: "circle",
    source: SRC,
    filter: ["match", ["geometry-type"], ["Point", "MultiPoint"], true, false],
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 3.5, 12, 6, 16, 9],
      "circle-color": ["coalesce", ["get", "color"], "#e6194b"],
      "circle-stroke-width": 1.5,
      "circle-stroke-color": "#ffffff",
    },
  });
}

function bounds(fc: GeoJSON.FeatureCollection): maplibregl.LngLatBounds | null {
  const b = new maplibregl.LngLatBounds();
  let any = false;
  const walk = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") {
      // Slice to [lng, lat]. KML positions carry altitude and CalTopo adds a
      // fourth ordinate; passing the whole array to extend() makes MapLibre
      // misread it and collapse the east edge to longitude 0, which fits the
      // map to everything between here and the prime meridian.
      b.extend([c[0], c[1]] as [number, number]);
      any = true;
      return;
    }
    for (const child of c) walk(child);
  };
  for (const f of fc.features) {
    if (f.geometry && "coordinates" in f.geometry) walk(f.geometry.coordinates);
  }
  return any ? b : null;
}

export function MapView({ data, visibleLayerIds, basemap, fitKey }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);

  /**
   * Which map instance already has the current basemap applied. The
   * constructor sets a style, so re-applying it immediately would abort the
   * in-flight load ("Style is not done loading") and leave the map blank.
   * Keying on the instance rather than a boolean also survives StrictMode's
   * mount/unmount/remount, which builds a second map.
   */
  const styledFor = useRef<MLMap | null>(null);

  const filtered = useMemo<GeoJSON.FeatureCollection>(
    () => ({
      type: "FeatureCollection",
      features: data.features.filter((f) =>
        visibleLayerIds.has(String(f.properties?.["layerId"] ?? "")),
      ),
    }),
    [data, visibleLayerIds],
  );

  // Latest data, readable from map event listeners without making them a
  // dependency — listeners registered at mount would otherwise close over the
  // first render's empty FeatureCollection.
  const dataRef = useRef(filtered);
  dataRef.current = filtered;

  useEffect(() => {
    if (!container.current || map.current) return;

    const m = new maplibregl.Map({
      container: container.current,
      style: BASEMAPS[basemap].style,
      center: [-111.9, 40.5],
      zoom: 5,
      attributionControl: { compact: true },
    });
    map.current = m;

    m.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
    m.addControl(new maplibregl.ScaleControl({ unit: "imperial" }), "bottom-left");
    m.addControl(
      new maplibregl.GeolocateControl({ trackUserLocation: true, showAccuracyCircle: true }),
      "top-right",
    );

    m.on("load", () => addDataLayers(m, dataRef.current));

    for (const id of [`${SRC}-fill`, `${SRC}-line`, `${SRC}-point`]) {
      m.on("mouseenter", id, () => (m.getCanvas().style.cursor = "pointer"));
      m.on("mouseleave", id, () => (m.getCanvas().style.cursor = ""));
      m.on("click", id, (e) => {
        const f = e.features?.[0];
        if (!f) return;
        const p = f.properties as Record<string, string>;
        const html = `
          <div class="popup">
            <strong>${p["name"] || "(untitled)"}</strong>
            <div class="popup-src">${p["source"]}</div>
            ${p["description"] ? `<div class="popup-desc">${p["description"]}</div>` : ""}
          </div>`;
        new maplibregl.Popup({ maxWidth: "320px" })
          .setLngLat(e.lngLat)
          .setHTML(html)
          .addTo(m);
      });
    }

    return () => {
      m.remove();
      map.current = null;
    };
    // Deliberately mount-only: basemap and data changes are handled below so
    // that swapping a basemap does not tear down the map instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Basemap swap. setStyle drops all custom sources, so re-add on styledata.
  useEffect(() => {
    const m = map.current;
    if (!m) return;

    // A freshly built map already carries this style from the constructor.
    if (styledFor.current !== m) {
      styledFor.current = m;
      return;
    }

    m.setStyle(BASEMAPS[basemap].style);
    const onStyle = () => addDataLayers(m, dataRef.current);
    m.once("styledata", onStyle);
    return () => void m.off("styledata", onStyle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basemap]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const apply = () => {
      const src = m.getSource(SRC) as maplibregl.GeoJSONSource | undefined;
      if (src) src.setData(filtered);
      else addDataLayers(m, filtered);
    };
    if (m.isStyleLoaded()) apply();
    else m.once("load", apply);
  }, [filtered]);

  useEffect(() => {
    const m = map.current;
    if (!m || fitKey === 0) return;
    const b = bounds(filtered);
    if (b) m.fitBounds(b, { padding: 60, maxZoom: 14, duration: 800 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);

  return <div ref={container} className="map" />;
}
