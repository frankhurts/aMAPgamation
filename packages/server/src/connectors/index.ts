import { syncMyMaps } from "./mymaps.js";
import { syncCalTopo } from "./caltopo.js";
import { replaceSource } from "../db.js";
import { redactMapId } from "../config.js";
import type { SourceConfig, SyncResult } from "../types.js";

/**
 * Phase 1 ships mymaps + caltopo. gpx (OnX exports) and takeout (Google saved
 * places) land in Phase 2 and slot in here without touching anything else.
 */
export async function syncSource(cfg: SourceConfig): Promise<SyncResult> {
  const started = Date.now();
  const base = { sourceKey: cfg.id, type: cfg.type, label: cfg.label };

  try {
    let result: Awaited<ReturnType<typeof syncMyMaps>>;
    switch (cfg.type) {
      case "mymaps":
        result = await syncMyMaps(cfg);
        break;
      case "caltopo":
        result = await syncCalTopo(cfg);
        break;
      default:
        throw new Error(`Connector "${cfg.type}" is not implemented yet (Phase 2).`);
    }

    replaceSource(cfg.id, result.layers, result.features);
    return {
      ...base,
      ok: true,
      layers: result.layers.length,
      features: result.features.length,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    return {
      ...base,
      ok: false,
      layers: 0,
      features: 0,
      error: `${(err as Error).message} [map ${redactMapId(cfg.mapId)}]`,
      durationMs: Date.now() - started,
    };
  }
}

export async function syncAll(sources: SourceConfig[]): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  for (const cfg of sources) results.push(await syncSource(cfg));
  return results;
}
