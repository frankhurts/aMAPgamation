import { useEffect, useMemo, useState } from "react";
import {
  corridorApi,
  type CorridorMatch,
  type Layer,
  type RouteCandidate,
  type RouteLine,
  type RouteSummary,
} from "./api";

const MAX_MILES = 200;
const SLIDER_MAX = 100;

/**
 * Remembered per browser, so reopening the app keeps the route you were
 * planning against. Storage can be unavailable (private windows, blocked
 * site data), and the corridor must still work without it.
 */
function stored<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

function store(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not persisting is fine; the choice still holds for this session.
  }
}

export interface CorridorState {
  candidates: RouteCandidate[];
  routeRef: string | null;
  setRouteRef: (ref: string | null) => void;
  miles: number;
  setMiles: (miles: number) => void;
  onlyInside: boolean;
  setOnlyInside: (on: boolean) => void;
  summary: RouteSummary | null;
  line: RouteLine | null;
  /** Null until a route is picked and its first query returns. */
  matches: CorridorMatch[] | null;
  loading: boolean;
  error: string | null;
}

/**
 * Route picker, buffer and results. `reloadKey` changes after a sync, since
 * new features may now fall inside the corridor and layer ids may be new.
 */
export function useCorridor(reloadKey: number): CorridorState {
  const [candidates, setCandidates] = useState<RouteCandidate[]>([]);
  const [routeRef, setRouteRefState] = useState<string | null>(() => stored("corridor.ref", null));
  const [miles, setMilesState] = useState<number>(() => stored("corridor.miles", 25));
  const [onlyInside, setOnlyInsideState] = useState<boolean>(() => stored("corridor.onlyInside", true));
  const [summary, setSummary] = useState<RouteSummary | null>(null);
  const [line, setLine] = useState<RouteLine | null>(null);
  const [matches, setMatches] = useState<CorridorMatch[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setRouteRef = (ref: string | null) => {
    setRouteRefState(ref);
    store("corridor.ref", ref);
  };
  const setMiles = (m: number) => {
    setMilesState(m);
    store("corridor.miles", m);
  };
  const setOnlyInside = (on: boolean) => {
    setOnlyInsideState(on);
    store("corridor.onlyInside", on);
  };

  useEffect(() => {
    corridorApi
      .routes()
      .then(({ routes }) => setCandidates(routes))
      .catch((err: Error) => setError(err.message));
  }, [reloadKey]);

  // Only a different route invalidates what is shown. A reload refetches in
  // place, so a sync does not flash every feature back onto the map.
  useEffect(() => {
    setLine(null);
    setSummary(null);
    setMatches(null);
    setError(null);
  }, [routeRef]);

  useEffect(() => {
    if (!routeRef) return;
    let live = true;
    corridorApi
      .route(routeRef)
      .then((r) => {
        if (!live) return;
        setLine(r.line);
        setSummary(r.route);
      })
      .catch((err: Error) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [routeRef, reloadKey]);

  // Debounced, and superseded requests are aborted, so dragging the slider
  // does not queue a query per pixel.
  useEffect(() => {
    if (!routeRef || !(miles > 0 && miles <= MAX_MILES)) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      corridorApi
        .near(routeRef, miles, ctrl.signal)
        .then((r) => {
          setMatches(r.matches);
          setError(null);
        })
        .catch((err: Error) => {
          if (err.name !== "AbortError") setError(err.message);
        })
        .finally(() => !ctrl.signal.aborted && setLoading(false));
    }, 200);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [routeRef, miles, reloadKey]);

  return {
    candidates,
    routeRef,
    setRouteRef,
    miles,
    setMiles,
    onlyInside,
    setOnlyInside,
    summary,
    line,
    matches,
    loading,
    error,
  };
}

const fmt = (n: number, digits = 0) =>
  n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });

export function CorridorPanel({
  state,
  layers,
  visible,
  onFocus,
}: {
  state: CorridorState;
  layers: Layer[];
  visible: Set<string>;
  onFocus: (m: CorridorMatch) => void;
}) {
  const { candidates, routeRef, summary, matches, miles } = state;
  const layerById = useMemo(() => new Map(layers.map((l) => [l.id, l])), [layers]);

  // The list honours the layer toggles, so hiding a noisy layer (say, the
  // route's own lines synced from My Maps) clears it from here too.
  const shown = (matches ?? []).filter((m) => m.layerId && visible.has(m.layerId));
  const hidden = (matches?.length ?? 0) - shown.length;

  const synced = candidates.filter((c) => c.kind === "layer");
  const files = candidates.filter((c) => c.kind === "file");
  // A remembered ref that is no longer offered (a re-synced layer gets a new
  // id) still needs an option, or the select would silently show "none".
  const orphanRef = routeRef && !candidates.some((c) => c.ref === routeRef) ? routeRef : null;

  return (
    <div className="corridor">
      <div className="corridor-controls">
        <label className="field">
          <span>Route</span>
          <select
            value={routeRef ?? ""}
            onChange={(e) => state.setRouteRef(e.target.value || null)}
          >
            <option value="">None — show everything</option>
            {orphanRef && <option value={orphanRef}>{orphanRef}</option>}
            {synced.length > 0 && (
              <optgroup label="Synced layers">
                {synced.map((c) => (
                  <option key={c.ref} value={c.ref}>
                    {c.label}
                  </option>
                ))}
              </optgroup>
            )}
            {files.length > 0 && (
              <optgroup label="GPX in the repo">
                {files.map((c) => (
                  <option key={c.ref} value={c.ref}>
                    {c.label}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>

        <label className="field">
          <span>Within</span>
          <div className="miles">
            <input
              type="range"
              min={1}
              max={SLIDER_MAX}
              value={Math.min(miles, SLIDER_MAX)}
              onChange={(e) => state.setMiles(Number(e.target.value))}
              disabled={!routeRef}
            />
            <input
              type="number"
              min={0.5}
              max={MAX_MILES}
              step={0.5}
              value={miles}
              onChange={(e) => state.setMiles(Number(e.target.value))}
              disabled={!routeRef}
            />
            <span className="unit">mi</span>
          </div>
        </label>

        <label className="check">
          <input
            type="checkbox"
            checked={state.onlyInside}
            onChange={(e) => state.setOnlyInside(e.target.checked)}
            disabled={!routeRef}
          />
          Only show features inside the corridor
        </label>
      </div>

      {state.error && <div className="status status-error">{state.error}</div>}

      {summary && (
        <div className="corridor-summary">
          <strong>{summary.label}</strong> · {fmt(summary.lengthMiles)} mi · {summary.legs}{" "}
          {summary.legs === 1 ? "leg" : "legs"}
          {summary.pieces > 1 && (
            <div className="warn">
              {summary.pieces} disconnected pieces — alternate legs or a gap. Mile markers after a
              break continue from the previous piece, so treat them as approximate.
            </div>
          )}
        </div>
      )}

      {!routeRef ? (
        <div className="empty">
          <p>Pick a route to find everything within a distance of it.</p>
          <p>
            Each match gets a <strong>mile marker</strong> along the route and how far off-route it
            is, so the list reads in travel order.
          </p>
        </div>
      ) : (
        matches && (
          <>
            <div className="layer-actions">
              <span>
                {state.loading ? "Searching…" : `${shown.length} within ${fmt(miles, miles % 1 ? 1 : 0)} mi`}
                {hidden > 0 && ` · ${hidden} in hidden layers`}
              </span>
            </div>
            <ol className="match-list">
              {shown.map((m) => {
                const layer = m.layerId ? layerById.get(m.layerId) : undefined;
                return (
                  <li key={m.id}>
                    <button className="match" onClick={() => onFocus(m)} title={layer?.name}>
                      <span className="mile">{fmt(m.mileMarker)}</span>
                      <span className="swatch" style={{ background: layer?.color ?? "#888" }} />
                      <span className="match-name">{m.name || "(untitled)"}</span>
                      <span className="count">{m.offRouteMiles < 0.1 ? "on route" : `${fmt(m.offRouteMiles, 1)} off`}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </>
        )
      )}
    </div>
  );
}
