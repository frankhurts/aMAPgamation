import { METERS_PER_MILE, sampleAlong } from "../../geo/corridor.js";
import { cached, cacheKey } from "./cache.js";
import type { Category } from "./categories.js";
import { request, sleep, text, type Provider, type ProviderContext, type RawSite } from "./provider.js";

/**
 * RIDB — recreation.gov's API, covering NPS, USFS, BLM, USACE and more.
 *
 * The best-curated campground data of the three, and the only one that knows
 * whether a site is reservable. Opt-in, because it is the only provider that
 * needs an API key: get a free one at https://ridb.recreation.gov/profile and
 * put it in .env as RIDB_API_KEY.
 *
 * It answers "what is near this point", not "what is near this line", so the
 * route is covered by a chain of overlapping circles — which makes it by far
 * the most request-hungry provider here, and another reason it is opt-in.
 */

const BASE = process.env.RIDB_URL ?? "https://ridb.recreation.gov/api/v1";

/**
 * The API caps `radius` at 25 miles and `limit` at 50 rows, which is what
 * makes this provider expensive: a 5,000 mile trip is a few hundred circles.
 * They overlap at 0.75 of the radius so nothing falls between them.
 */
const RADIUS_MILES = Math.min(Number(process.env.RIDB_RADIUS_MILES ?? 25), 25);
const PAGE = 50;
const POLITE_MS = Number(process.env.RIDB_DELAY_MS ?? 250);

/**
 * RIDB's facility vocabulary is only eight values — Activity Pass, Campground,
 * Facility, Kiosk, Permit, Ticket Facility, Timed Entry, Venue Reservations —
 * and just one of them is a place to sleep. The rest are booking constructs,
 * not destinations.
 */
const FACILITY_CATEGORY: Record<string, Category> = {
  campground: "camping",
};

interface Facility {
  /** A string in the API, despite looking numeric. Never coerce it. */
  FacilityID?: string;
  FacilityName?: string;
  FacilityTypeDescription?: string;
  FacilityDescription?: string;
  FacilityLatitude?: number;
  FacilityLongitude?: number;
  FacilityPhone?: string;
  FacilityUseFeeDescription?: string;
  Reservable?: boolean;
  /** Retired facilities are still returned by search. */
  Enabled?: boolean;
}

export const ridb: Provider = {
  id: "ridb",
  label: "Recreation.gov",

  usable: () =>
    process.env.RIDB_API_KEY
      ? { ok: true }
      : {
          ok: false,
          why:
            "no RIDB_API_KEY in .env. Get a free key at " +
            "https://ridb.recreation.gov/profile and add RIDB_API_KEY=… to .env",
        },

  async fetch(ctx: ProviderContext): Promise<RawSite[]> {
    // Only camping categories come from here; there is no point walking the
    // whole route in circles if camping was not asked for.
    const wanted = [...ctx.buffers.keys()].filter((c) => c === "camping" || c === "dispersed");
    if (wanted.length === 0) return [];

    const spacingM = RADIUS_MILES * METERS_PER_MILE * 0.75;
    const points = ctx.chunks(Number.MAX_SAFE_INTEGER).flatMap((chunk) =>
      sampleAlong(chunk, spacingM),
    );

    const sites: RawSite[] = [];
    const seen = new Set<string>();
    let first = true;

    for (const [lng, lat] of points) {
      const key = cacheKey("ridb", lng.toFixed(3), lat.toFixed(3), RADIUS_MILES);
      const facilities = await cached("ridb", key, ctx.stats, async () => {
        if (!first) await sleep(POLITE_MS);
        first = false;
        return fetchAll(lng, lat);
      });

      for (const f of facilities) {
        // Overlapping circles return the same campground repeatedly; this is
        // exact-id dedupe, distinct from the cross-provider proximity pass.
        const id = f.FacilityID ? String(f.FacilityID) : null;
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);

        const site = toSite(f);
        if (site) sites.push(site);
      }
    }

    return sites;
  },
};

/** Pages through one point's results; a busy area easily exceeds one page. */
async function fetchAll(lng: number, lat: number): Promise<Facility[]> {
  const out: Facility[] = [];

  for (let offset = 0; ; offset += PAGE) {
    const url = `${BASE}/facilities?${new URLSearchParams({
      latitude: String(lat),
      longitude: String(lng),
      radius: String(RADIUS_MILES),
      limit: String(PAGE),
      offset: String(offset),
      activity: "CAMPING",
    })}`;

    const res = await request(url, {
      headers: { apikey: process.env.RIDB_API_KEY ?? "" },
      // A missing key and a wrong key are the same 401 with the same body, so
      // there is nothing to be gained from retrying either.
      attempts: 1,
    });
    const body = (await res.json()) as {
      RECDATA?: Facility[];
      METADATA?: { RESULTS?: { TOTAL_COUNT?: number } };
    };

    const page = body.RECDATA ?? [];
    out.push(...page);

    const total = body.METADATA?.RESULTS?.TOTAL_COUNT ?? out.length;
    if (page.length < PAGE || out.length >= total) break;
  }

  return out;
}

function toSite(f: Facility): RawSite | null {
  const lat = Number(f.FacilityLatitude);
  const lng = Number(f.FacilityLongitude);
  // RIDB carries records with no coordinates — a permit office with a mailing
  // address but no location. Nothing useful to put on a map.
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return null;

  // A closed campground is worse than no campground: it sends you somewhere.
  if (f.Enabled === false) return null;

  const type = (f.FacilityTypeDescription ?? "").toLowerCase();
  const category = FACILITY_CATEGORY[type];
  if (!category) return null;

  const detail = [
    f.Reservable ? "Reservable" : "First-come",
    text(f.FacilityUseFeeDescription),
    text(f.FacilityPhone),
  ].filter(Boolean);

  return {
    sourceId: f.FacilityID ? String(f.FacilityID) : null,
    category,
    name: text(f.FacilityName),
    // Descriptions arrive as HTML often enough that it has to be stripped.
    description: [detail.join(" · "), stripHtml(f.FacilityDescription)]
      .filter(Boolean)
      .join(" — ") || null,
    lng,
    lat,
    detail: { reservable: f.Reservable ?? null, phone: text(f.FacilityPhone) },
    raw: f as unknown as Record<string, unknown>,
  };
}

function stripHtml(s: string | undefined): string | null {
  const plain = text(s)?.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return plain ? plain.slice(0, 500) : null;
}
