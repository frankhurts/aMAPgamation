import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Layer, type SyncResult } from "./api";
import { BASEMAPS, type BasemapKey } from "./basemaps";
import { MapView } from "./MapView";

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

export default function App() {
  const [layers, setLayers] = useState<Layer[]>([]);
  const [data, setData] = useState<GeoJSON.FeatureCollection>(EMPTY);
  const [visible, setVisible] = useState<Set<string>>(new Set());
  const [basemap, setBasemap] = useState<BasemapKey>("topo");
  const [syncing, setSyncing] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [fitKey, setFitKey] = useState(0);

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
      setStatus(
        failures.length === 0
          ? `Synced ${results.length} source(s).`
          : failures.map((f) => `${f.label}: ${f.error}`).join("  |  "),
      );
    } catch (err) {
      setStatus((err as Error).message);
    } finally {
      setSyncing(false);
    }
  };

  // Grouped by service, not by config key, so two CalTopo maps land under one
  // "CalTopo" heading instead of two headings named after sources.json keys.
  const grouped = useMemo(() => {
    const by = new Map<string, { label: string; layers: Layer[] }>();
    for (const l of layers) {
      const group = by.get(l.source) ?? { label: l.source_label, layers: [] };
      group.layers.push(l);
      by.set(l.source, group);
    }
    return [...by.entries()];
  }, [layers]);

  const toggle = (id: string) =>
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const setAll = (on: boolean) =>
    setVisible(on ? new Set(layers.map((l) => l.id)) : new Set());

  const shownCount = data.features.filter((f) =>
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

        {layers.length === 0 ? (
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
              </span>
              <div>
                <button onClick={() => setAll(true)}>All</button>
                <button onClick={() => setAll(false)}>None</button>
                <button onClick={() => setFitKey((k) => k + 1)}>Fit</button>
              </div>
            </div>

            <div className="layer-list">
              {grouped.map(([source, group]) => (
                <section key={source}>
                  <h2>{group.label}</h2>
                  {group.layers.map((l) => (
                    <label key={l.id} className="layer">
                      <input
                        type="checkbox"
                        checked={visible.has(l.id)}
                        onChange={() => toggle(l.id)}
                      />
                      <span className="swatch" style={{ background: l.color ?? "#888" }} />
                      <span className="layer-name">{l.name}</span>
                      <span className="count">{l.feature_count}</span>
                    </label>
                  ))}
                </section>
              ))}
            </div>
          </>
        )}
      </aside>

      <MapView data={data} visibleLayerIds={visible} basemap={basemap} fitKey={fitKey} />
    </div>
  );
}
