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
