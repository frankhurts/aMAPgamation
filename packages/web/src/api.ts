export interface Layer {
  id: string;
  source: string;
  source_key: string;
  /** Display name of the originating service, e.g. "CalTopo". */
  source_label: string;
  /** Display name of the individual map, e.g. "Road Trip - Utah". */
  map_label: string;
  name: string;
  color: string | null;
  sort_order: number;
  feature_count: number;
}

export interface SyncResult {
  sourceKey: string;
  label: string;
  ok: boolean;
  layers: number;
  features: number;
  error?: string;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed: HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  layers: () => fetch("/api/layers").then(json<{ layers: Layer[] }>),
  features: () => fetch("/api/features").then(json<GeoJSON.FeatureCollection>),
  sync: () =>
    fetch("/api/sync", { method: "POST" }).then(json<{ results: SyncResult[] }>),
};

export interface RouteCandidate {
  ref: string;
  label: string;
  kind: "file" | "layer";
}

export interface RouteSummary {
  ref: string;
  label: string;
  lengthMiles: number;
  legs: number;
  /** Connected stretches; more than one means alternates or a gap. */
  pieces: number;
}

export interface CorridorMatch {
  id: string;
  layerId: string | null;
  name: string | null;
  offRouteMiles: number;
  mileMarker: number;
  lng: number;
  lat: number;
}

/** The route as drawn: one line per connected piece. */
export type RouteLine = GeoJSON.FeatureCollection<GeoJSON.LineString>;

const q = (params: Record<string, string | number>) =>
  new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();

export const corridorApi = {
  routes: () => fetch("/api/routes").then(json<{ routes: RouteCandidate[] }>),
  route: (ref: string) =>
    fetch(`/api/route?${q({ ref })}`).then(json<{ route: RouteSummary; line: RouteLine }>),
  near: (ref: string, miles: number, signal?: AbortSignal) =>
    fetch(`/api/near?${q({ route: ref, miles })}`, { signal }).then(
      json<{ route: RouteSummary; miles: number; matches: CorridorMatch[] }>,
    ),
};
