import { syncMyMaps } from "./mymaps.js";
import { syncCalTopo } from "./caltopo.js";
import { syncGpx } from "./gpx.js";
import { replaceSource } from "../db.js";
import { describeSource } from "../config.js";
import type { SourceConfig, SyncResult } from "../types.js";

/**
 * takeout (Google saved places) is the remaining connector; it slots in here
 * the same way, without touching anything else.
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
      case "gpx":
        result = await syncGpx(cfg);
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
      error: `${(err as Error).message} [${describeSource(cfg)}]`,
      durationMs: Date.now() - started,
    };
  }
}

export async function syncAll(sources: SourceConfig[]): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  for (const cfg of sources) results.push(await syncSource(cfg));
  return results;
}
