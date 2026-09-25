import type { LngLat } from "../../geo/corridor.js";
import type { CacheStats } from "./cache.js";
import type { Category } from "./categories.js";

/**
 * One thing a provider found, before it is measured against the route.
 *
 * Providers do not compute mile markers or off-route distance: they return
 * what they found and where it is, and the orchestrator measures it against
 * the real (un-decimated) route. That keeps every provider honest about the
 * same geometry, and means a provider's coarse query buffer never leaks into
 * the numbers shown to the user.
 */
export interface RawSite {
  /** Stable upstream id, when the provider has one. Used for dedupe. */
  sourceId: string | null;
  category: Category;
  name: string | null;
  description: string | null;
  lng: number;
  lat: number;
  /** Normalized extras worth showing in a popup (hours, fee, water…). */
  detail: Record<string, unknown>;
  /** Upstream record, verbatim, same contract as NormalizedFeature.raw. */
  raw: Record<string, unknown>;
}

export interface ProviderContext {
  /**
   * The route as decimated polylines of at most `maxPoints` each.
   *
   * The cap is the provider's to choose, because the limit it is working
   * around differs: Overpass has a practical query length, ArcGIS a POST body
   * size. Every chunk comes from the same decimation, so `slackM` holds
   * whatever cap is picked.
   */
  chunks(maxPoints: number, maxLengthM?: number): LngLat[][];
  /** Identifies this route (and its current contents) for cache keys. */
  routeKey: string;
  /** Miles off-route wanted, per category. Only categories asked for appear. */
  buffers: Map<Category, number>;
  /**
   * Meters to add to any query radius, covering the error introduced by
   * decimating the route. Over-fetching is free; under-fetching silently
   * loses sites near the edge of the corridor.
   */
  slackM: number;
  stats: CacheStats;
  /** Surfaced to the user at the end of the sync. */
  warn: (message: string) => void;
}

export interface Provider {
  id: string;
  label: string;
  /** False when the provider needs a key that is not configured. */
  usable(): { ok: true } | { ok: false; why: string };
  fetch(ctx: ProviderContext): Promise<RawSite[]>;
}

/**
 * Overpass answers 406 to an empty or `curl/*` User-Agent, and the rest of
 * these are volunteer-run services that are entitled to know who is calling.
 */
export const USER_AGENT =
  process.env.CORRIDOR_USER_AGENT ??
  "Map-Amalgamator/0.1 (personal trip-planning tool; contact via repo)";

/**
 * Generous, because a wide corridor query is real work for the server. It must
 * stay *longer* than any timeout asked of a provider (see Overpass's own
 * `[timeout:]`), or a slow-but-working query gets aborted and retried instead
 * of answered — which costs the server the work three times over.
 */
export const TIMEOUT_MS = Number(process.env.CORRIDOR_TIMEOUT_MS ?? 120_000);
/** First backoff step; each retry doubles it, up to 15s. */
const RETRY_BASE_MS = Number(process.env.CORRIDOR_RETRY_BASE_MS ?? 2000);

export class ProviderError extends Error {}

/**
 * One HTTP request, with the politeness these APIs require: an identifying
 * User-Agent, a timeout, and a bounded retry on the failures that are worth
 * retrying.
 *
 * 429 and 504 are the two that matter. Overpass hands out a small number of
 * query slots and returns 429 when they are all busy; a rate limit is a "wait
 * and it will work", not an error to report. 4xx other than 429 is a broken
 * query and retrying only wastes someone else's capacity.
 */
export async function request(
  url: string,
  init: RequestInit & { attempts?: number } = {},
): Promise<Response> {
  const { attempts = 3, ...rest } = init;
  let lastError = "";

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        ...rest,
        signal: controller.signal,
        headers: { "user-agent": USER_AGENT, ...(rest.headers ?? {}) },
      });

      if (res.ok) return res;

      const retryable = res.status === 429 || res.status >= 500;
      lastError = `HTTP ${res.status} ${res.statusText}`;
      if (!retryable || attempt === attempts) {
        const body = await res.text().catch(() => "");
        throw new ProviderError(`${lastError}${body ? ` — ${body.slice(0, 300)}` : ""}`);
      }
    } catch (err) {
      if (err instanceof ProviderError) throw err;

      // A refused connection or an unresolvable host is not a transient blip:
      // Overpass bans a busy IP at the TCP level for tens of minutes, and no
      // amount of backing off inside one sync will outlast that. Give up on
      // this endpoint immediately so the caller can try a mirror.
      const code = (err as { cause?: { code?: string } }).cause?.code;
      if (code === "ECONNREFUSED" || code === "ENOTFOUND") {
        throw new ProviderError(
          `${code} — the endpoint refused the connection. Public Overpass ` +
            `instances block an IP that queries too often, for tens of minutes.`,
        );
      }

      // A query the client had to abort is a query that asked for too much.
      // Retrying it unchanged costs the same wait again and ends the same way,
      // so it fails now and the caller decides what to do about the size.
      if ((err as Error).name === "AbortError") {
        throw new ProviderError(
          `timed out after ${TIMEOUT_MS / 1000}s — the query covers too much ground`,
        );
      }

      lastError = (err as Error).message;
      if (attempt === attempts) throw new ProviderError(lastError);
    } finally {
      clearTimeout(timer);
    }

    // Backoff, because the common retryable case is "you are asking too fast".
    await sleep(Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), 15_000));
  }

  throw new ProviderError(lastError);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A short, non-null string, or null. Upstream text fields are unreliable. */
export function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
