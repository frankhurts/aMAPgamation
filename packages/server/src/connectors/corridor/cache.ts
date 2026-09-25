import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../../config.js";

/**
 * Responses are cached on disk, keyed by the exact query that produced them.
 *
 * Not an optimization. A cross-country corridor is dozens of requests against
 * free, rate-limited, community-run services; re-syncing to pick up a change
 * in one My Maps pin must not replay all of them. The key includes the route
 * geometry, so editing the route does re-fetch, while re-running an unchanged
 * sync costs nothing.
 *
 * Set CORRIDOR_NO_CACHE=1 to bypass; it is read per call so it can be turned
 * on for one sync rather than only at startup.
 */
const CACHE_DIR = join(DATA_DIR, "cache", "corridor");
const TTL_MS = Number(process.env.CORRIDOR_CACHE_TTL_MS ?? 7 * 24 * 60 * 60 * 1000);


export function cacheKey(...parts: unknown[]): string {
  return createHash("sha1").update(parts.map((p) => JSON.stringify(p)).join("|")).digest("hex");
}

export interface CacheStats {
  hits: number;
  misses: number;
}

/**
 * Returns the cached value for `key`, or awaits `make()` and stores it.
 *
 * A write failure is not allowed to fail the sync — a full disk should cost
 * the cache, not the data that was just fetched successfully.
 */
export async function cached<T>(
  provider: string,
  key: string,
  stats: CacheStats,
  make: () => Promise<T>,
): Promise<T> {
  const dir = join(CACHE_DIR, provider);
  const file = join(dir, `${key}.json`);

  if (process.env.CORRIDOR_NO_CACHE !== "1") {
    try {
      if (Date.now() - statSync(file).mtimeMs < TTL_MS) {
        const hit = JSON.parse(readFileSync(file, "utf8")) as T;
        stats.hits++;
        return hit;
      }
    } catch {
      // Missing, stale or unreadable all mean the same thing: fetch it.
    }
  }

  const value = await make();
  stats.misses++;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(value));
  } catch {
    // Cache is best-effort.
  }
  return value;
}
