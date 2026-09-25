import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type CorridorMatch, type Layer, type SyncResult } from "./api";
import { BASEMAPS, type BasemapKey } from "./basemaps";
import { CorridorPanel, useCorridor } from "./Corridor";
import { corridorBuffer } from "./corridorBuffer";
import { MapView } from "./MapView";

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

interface MapGroup {
  key: string;
  label: string;
  layers: Layer[];
}

interface ServiceGroup {
  source: string;
  label: string;
  maps: MapGroup[];
}

/**
 * Toggles every layer of one map at once. Rendered half-checked when only
 * some of its layers are on, so the map row always reports the truth about
 * what is drawn beneath it.
 */
function MapToggle({
  map,
  visible,
  onToggle,
}: {
  map: MapGroup;
  visible: Set<string>;
  onToggle: (layers: Layer[], on: boolean) => void;
}) {
  const on = map.layers.filter((l) => visible.has(l.id)).length;
  const all = on === map.layers.length;
  const features = map.layers.reduce((n, l) => n + l.feature_count, 0);

  return (
    <label className="map-head">
      <input
        type="checkbox"
        checked={all}
        ref={(el) => {
          if (el) el.indeterminate = on > 0 && !all;
        }}
        onChange={() => onToggle(map.layers, !all)}
      />
      <span className="map-name" title={map.label}>
        {map.label}
      </span>
      <span className="count">{features}</span>
    </label>
  );
}

export default function App() {
  const [layers, setLayers] = useState<Layer[]>([]);
  const [data, setData] = useState<GeoJSON.FeatureCollection>(EMPTY);
  const [visible, setVisible] = useState<Set<string>>(new Set());
  const [basemap, setBasemap] = useState<BasemapKey>("topo");
  const [syncing, setSyncing] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [fitKey, setFitKey] = useState(0);
  const [tab, setTab] = useState<"layers" | "corridor">("layers");
  const [loadCount, setLoadCount] = useState(0);
  const [focus, setFocus] = useState<{ lng: number; lat: number; key: number } | null>(null);
  const corridor = useCorridor(loadCount);

  const load = useCallback(async (fit = false) => {
    try {
      const [{ layers: ls }, fc] = await Promise.all([api.layers(), api.features()]);
      setLayers(ls);
      setData(fc);
      // New layers default to visible; existing toggles are preserved so a
      // re-sync does not undo what you turned off.
      setVisible((prev) =>
        prev.size === 0 ? new Set(ls.map((l) => l.id)) : new Set([...prev].filter((id) => ls.some((l) => l.id === id))),
      );
      if (fit) setFitKey((k) => k + 1);
      setLoadCount((n) => n + 1);
      setStatus(null);
    } catch (err) {
      setStatus((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load(true);
  }, [load]);

  const sync = async () => {
    setSyncing(true);
    setStatus("Syncing...");
    try {
      const { results } = await api.sync();
      const failures = results.filter((r: SyncResult) => !r.ok);
      await load(true);
      // A corridor source can succeed with a provider missing; saying only
      // "Synced 5 sources" would present a half-empty result as the whole
      // answer.
      const notes = results.flatMap((r: SyncResult) =>
        (r.notes ?? []).map((n) => `${r.label}: ${n}`),
      );
      setStatus(
        [
          ...failures.map((f) => `${f.label}: ${f.error}`),
          ...(failures.length === 0 ? [`Synced ${results.length} source(s).`] : []),
          ...notes,
        ].join("  |  "),
      );
    } catch (err) {
      setStatus((err as Error).message);
    } finally {
      setSyncing(false);
    }
  };

  // service -> map -> layers. Insertion order follows the query's ORDER BY,
  // so groups stay in a stable order across syncs.
  const grouped = useMemo<ServiceGroup[]>(() => {
    const services = new Map<string, { label: string; maps: Map<string, MapGroup> }>();

    for (const l of layers) {
      let service = services.get(l.source);
      if (!service) {
        service = { label: l.source_label, maps: new Map() };
        services.set(l.source, service);
      }

      let map = service.maps.get(l.source_key);
      if (!map) {
        map = { key: l.source_key, label: l.map_label, layers: [] };
        service.maps.set(l.source_key, map);
      }
      map.layers.push(l);
    }

    return [...services.entries()].map(([source, s]) => ({
      source,
      label: s.label,
      maps: [...s.maps.values()],
    }));
  }, [layers]);

  const toggle = (id: string) =>
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleMap = (ls: Layer[], on: boolean) =>
    setVisible((prev) => {
      const next = new Set(prev);
      for (const l of ls) {
        if (on) next.add(l.id);
        else next.delete(l.id);
      }
      return next;
    });

  const setAll = (on: boolean) =>
    setVisible(on ? new Set(layers.map((l) => l.id)) : new Set());

  /**
   * With a route picked, features carry their mile marker into popups, and
   * anything outside the corridor drops out unless you ask to keep it.
   */
  const { matches, onlyInside } = corridor;
  const mapData = useMemo<GeoJSON.FeatureCollection>(() => {
    if (!matches) return data;
    const byId = new Map(matches.map((m) => [m.id, m]));
    const features: GeoJSON.Feature[] = [];
    for (const f of data.features) {
      const m = byId.get(String(f.id ?? f.properties?.["id"]));
      if (!m) {
        if (!onlyInside) features.push(f);
        continue;
      }
      features.push({
        ...f,
        properties: { ...f.properties, mileMarker: m.mileMarker, offRouteMiles: m.offRouteMiles },
      });
    }
    return { type: "FeatureCollection", features };
  }, [data, matches, onlyInside]);

  const corridorOverlay = useMemo(
    () =>
      corridor.line && corridor.miles > 0
        ? { line: corridor.line, buffer: corridorBuffer(corridor.line, corridor.miles) }
        : null,
    [corridor.line, corridor.miles],
  );

  const focusOn = (m: CorridorMatch) =>
    setFocus((prev) => ({ lng: m.lng, lat: m.lat, key: (prev?.key ?? 0) + 1 }));

  const shownCount = mapData.features.filter((f) =>
    visible.has(String(f.properties?.["layerId"] ?? "")),
  ).length;

  return (
    <div className="app">
      <aside className="panel">
        <header className="panel-head">
          <h1>Map Amalgamator</h1>
          <button onClick={sync} disabled={syncing} className="btn-primary">
            {syncing ? "Syncing..." : "Sync sources"}
          </button>
        </header>

        <div className="basemap-row">
          {(Object.keys(BASEMAPS) as BasemapKey[]).map((k) => (
            <button
              key={k}
              onClick={() => setBasemap(k)}
              className={`chip ${basemap === k ? "chip-on" : ""}`}
            >
              {BASEMAPS[k].label}
            </button>
          ))}
        </div>

        {status && <div className="status">{status}</div>}

        <div className="tabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === "layers"}
            className={tab === "layers" ? "tab-on" : ""}
            onClick={() => setTab("layers")}
          >
            Layers
          </button>
          <button
            role="tab"
            aria-selected={tab === "corridor"}
            className={tab === "corridor" ? "tab-on" : ""}
            onClick={() => setTab("corridor")}
          >
            Along route
            {corridor.routeRef && <span className="tab-dot" title="A route corridor is active" />}
          </button>
        </div>

        {tab === "corridor" ? (
          <CorridorPanel state={corridor} layers={layers} visible={visible} onFocus={focusOn} />
        ) : layers.length === 0 ? (
          <div className="empty">
            <p>No layers yet.</p>
            <p>
              Copy <code>config/sources.example.json</code> to{" "}
              <code>config/sources.json</code>, add your My Maps and CalTopo map
              ids, then hit <strong>Sync sources</strong>.
            </p>
          </div>
        ) : (
          <>
            <div className="layer-actions">
              <span>
                {shownCount} of {data.features.length} features
                {matches && onlyInside && " · in corridor"}
              </span>
              <div>
                <button onClick={() => setAll(true)}>All</button>
                <button onClick={() => setAll(false)}>None</button>
                <button onClick={() => setFitKey((k) => k + 1)}>Fit</button>
              </div>
            </div>

            <div className="layer-list">
              {grouped.map((service) => (
                <section key={service.source}>
                  <h2>{service.label}</h2>
                  {service.maps.map((map) => (
                    <div key={map.key} className="map-group">
                      <MapToggle map={map} visible={visible} onToggle={toggleMap} />
                      {map.layers.map((l) => (
                        <label key={l.id} className="layer">
                          <input
                            type="checkbox"
                            checked={visible.has(l.id)}
                            onChange={() => toggle(l.id)}
                          />
                          <span className="swatch" style={{ background: l.color ?? "#888" }} />
                          <span className="layer-name" title={l.name}>
                            {l.name}
                          </span>
                          <span className="count">{l.feature_count}</span>
                        </label>
                      ))}
                    </div>
                  ))}
                </section>
              ))}
            </div>
          </>
        )}
      </aside>

      <MapView
        data={mapData}
        visibleLayerIds={visible}
        basemap={basemap}
        fitKey={fitKey}
        corridor={corridorOverlay}
        focus={focus}
      />
    </div>
  );
}
