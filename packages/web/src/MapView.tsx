import { useEffect, useMemo, useRef } from "react";
import maplibregl, { type Map as MLMap } from "maplibre-gl";
import type { RouteLine } from "./api";
import { BASEMAPS, type BasemapKey } from "./basemaps";

const SRC = "amalgamated";
const CORRIDOR = "corridor";
const CORRIDOR_BUFFER = "corridor-buffer";
const CORRIDOR_COLOR = "#4c8dff";

export interface CorridorOverlay {
  line: RouteLine;
  /** Built from `line` for the chosen distance; see corridorBuffer. */
  buffer: GeoJSON.FeatureCollection<GeoJSON.Polygon>;
}

interface Props {
  data: GeoJSON.FeatureCollection;
  visibleLayerIds: Set<string>;
  basemap: BasemapKey;
  fitKey: number;
  corridor: CorridorOverlay | null;
  /** Fly here whenever `key` changes. */
  focus: { lng: number; lat: number; key: number } | null;
}

/**
 * The corridor sits beneath the data layers, so pins stay clickable on top
 * of it.
 *
 * The band is a flat fill-extrusion rather than a fill. Its capsules overlap
 * at every bend, and a fill layer blends each overlap again, striping the
 * band with dark wedges. Extrusions render offscreen and are composited once
 * at the layer's opacity, so the band stays uniform however much it overlaps.
 */
function addCorridorLayers(map: MLMap, overlay: CorridorOverlay | null) {
  if (!overlay || map.getSource(CORRIDOR)) return;
  const before = map.getLayer(`${SRC}-fill`) ? `${SRC}-fill` : undefined;

  map.addSource(CORRIDOR_BUFFER, { type: "geojson", data: overlay.buffer });
  map.addSource(CORRIDOR, { type: "geojson", data: overlay.line });
  map.addLayer(
    {
      id: `${CORRIDOR}-band`,
      type: "fill-extrusion",
      source: CORRIDOR_BUFFER,
      paint: {
        "fill-extrusion-color": CORRIDOR_COLOR,
        "fill-extrusion-opacity": 0.2,
        "fill-extrusion-height": 0,
      },
    },
    before,
  );
  map.addLayer(
    {
      id: `${CORRIDOR}-line`,
      type: "line",
      source: CORRIDOR,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": CORRIDOR_COLOR, "line-width": 2.5 },
    },
    before,
  );
}

function removeCorridorLayers(map: MLMap) {
  for (const id of [`${CORRIDOR}-band`, `${CORRIDOR}-line`]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  for (const id of [CORRIDOR, CORRIDOR_BUFFER]) {
    if (map.getSource(id)) map.removeSource(id);
  }
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

/**
 * Runs `fn` now if the map can take source updates, otherwise once it can.
 * Returns a cleanup that cancels a pending run, so a newer update replaces a
 * stale one instead of both landing.
 *
 * Not `once("load")`: isStyleLoaded() is also false while tiles or a GeoJSON
 * update are in flight, long after "load" has fired for the last time, so an
 * update that arrived mid-pan would wait forever. "idle" always follows.
 */
function whenStyleReady(m: MLMap, fn: () => void): () => void {
  if (m.isStyleLoaded()) {
    fn();
    return () => {};
  }
  m.once("idle", fn);
  return () => void m.off("idle", fn);
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

/**
 * Popups are built as HTML strings, and corridor features carry text written
 * by strangers on the internet — an OSM `name` tag or a recreation.gov
 * description is not markup and must not be able to become markup.
 */
function esc(v: unknown): string {
  return String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

export function MapView({ data, visibleLayerIds, basemap, fitKey, corridor, focus }: Props) {
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
  const corridorRef = useRef(corridor);
  corridorRef.current = corridor;

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

    m.on("load", () => {
      addCorridorLayers(m, corridorRef.current);
      addDataLayers(m, dataRef.current);
    });

    for (const id of [`${SRC}-fill`, `${SRC}-line`, `${SRC}-point`]) {
      m.on("mouseenter", id, () => (m.getCanvas().style.cursor = "pointer"));
      m.on("mouseleave", id, () => (m.getCanvas().style.cursor = ""));
      m.on("click", id, (e) => {
        const f = e.features?.[0];
        if (!f) return;
        const p = f.properties as Record<string, string>;
        // Corridor features name the service they came from and what kind of
        // thing they are; imported ones only know which app they came out of.
        const origin = [p["providerLabel"], p["categoryLabel"]].filter(Boolean).join(" · ");
        const html = `
          <div class="popup">
            <strong>${esc(p["name"]) || "(untitled)"}</strong>
            <div class="popup-src">${esc(origin || p["source"])}</div>
            ${
              p["mileMarker"] !== undefined
                ? `<div class="popup-mile">Mile ${Number(p["mileMarker"]).toLocaleString()} · ${esc(p["offRouteMiles"])} mi off route</div>`
                : ""
            }
            ${p["description"] ? `<div class="popup-desc">${esc(p["description"])}</div>` : ""}
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
    const onStyle = () => {
      addCorridorLayers(m, corridorRef.current);
      addDataLayers(m, dataRef.current);
    };
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
    return whenStyleReady(m, apply);
  }, [filtered]);

  // Updates swap data in place; layers are only added or removed when the
  // overlay appears or goes away.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const apply = () => {
      if (!corridor) return removeCorridorLayers(m);
      if (!m.getSource(CORRIDOR)) return addCorridorLayers(m, corridor);
      (m.getSource(CORRIDOR) as maplibregl.GeoJSONSource).setData(corridor.line);
      (m.getSource(CORRIDOR_BUFFER) as maplibregl.GeoJSONSource).setData(corridor.buffer);
    };
    return whenStyleReady(m, apply);
  }, [corridor]);

  // Frame a newly picked route, but not every time its buffer is nudged.
  const line = corridor?.line;
  useEffect(() => {
    const m = map.current;
    if (!m || !line) return;
    const b = bounds(line);
    if (b) m.fitBounds(b, { padding: 60, maxZoom: 12, duration: 800 });
  }, [line]);

  useEffect(() => {
    const m = map.current;
    if (!m || !focus) return;
    m.flyTo({ center: [focus.lng, focus.lat], zoom: Math.max(m.getZoom(), 11), duration: 900 });
    // Keyed so re-selecting the same feature flies back to it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.key]);

  useEffect(() => {
    const m = map.current;
    if (!m || fitKey === 0) return;
    const b = bounds(filtered);
    if (b) m.fitBounds(b, { padding: 60, maxZoom: 14, duration: 800 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);

  return <div ref={container} className="map" />;
}
