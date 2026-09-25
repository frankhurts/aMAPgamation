import { METERS_PER_MILE } from "../../geo/corridor.js";
import { cached, cacheKey } from "./cache.js";
import type { Category } from "./categories.js";
import {
  ProviderError,
  TIMEOUT_MS,
  request,
  sleep,
  text,
  type Provider,
  type ProviderContext,
  type RawSite,
} from "./provider.js";

/**
 * OpenStreetMap, via Overpass.
 *
 * The only source here that knows about fuel, groceries and water taps —
 * agencies map their own land, nobody maps the gas station in the town you
 * pass through. Crowdsourced, so it runs last and loses dedupe to the
 * agencies, but for services it is usually the only thing that has an answer.
 */

/** Which OSM tag means which category. Order matters: first match wins. */
const TAGS: { key: string; values: string[]; category: Category }[] = [
  { key: "amenity", values: ["fuel"], category: "fuel" },
  { key: "amenity", values: ["drinking_water"], category: "water" },
  { key: "amenity", values: ["sanitary_dump_station"], category: "dump" },
  { key: "amenity", values: ["toilets"], category: "toilets" },
  { key: "amenity", values: ["shower"], category: "showers" },
  { key: "shop", values: ["supermarket", "convenience"], category: "groceries" },
  { key: "tourism", values: ["camp_site", "caravan_site"], category: "camping" },
];

const ENDPOINTS = [
  process.env.OVERPASS_URL ?? "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

/**
 * Overpass repeats the whole polyline for every clause, so the query grows
 * with the point count times the number of clauses. 300 keeps a chunk's body
 * comfortably inside what the public instances accept.
 */
const MAX_POINTS = 300;

/**
 * How much route one query may cover.
 *
 * This is the limit that actually bites. Overpass is charged by the ground it
 * has to search, not by how many vertices describe the line, so a whole
 * cross-country route asked for in one go times out no matter how few points
 * it decimates to.
 *
 * Measured against a 20-mile camping buffer: 80 miles answers in ~24s with
 * ~1,100 elements, while 150 miles is refused outright. A cross-country route
 * is therefore dozens of queries and the better part of half an hour — but
 * each chunk is cached the moment it lands, so it is paid once and a rerun
 * resumes where it stopped.
 */
const MAX_CHUNK_MILES = Number(process.env.OVERPASS_CHUNK_MILES ?? 80);

/**
 * Overpass hands out a handful of query slots, and the real limit is not the
 * documented quota but an IP-level block that lasts tens of minutes if you
 * query too often. One request at a time, well spaced — a whole route is only
 * a few chunks, so this costs seconds and buys not being banned.
 */
const POLITE_MS = Number(process.env.OVERPASS_DELAY_MS ?? 5000);

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/**
 * How many times a stretch may halve itself before giving up.
 *
 * Whatever the default stretch length, some of them cross a city and cost far
 * more than the same mileage of desert. Rather than tune for the worst case
 * and make every other query needlessly small, a stretch that is refused is
 * cut in half and each half asked for separately. Four splits takes 80 miles
 * down to 5 before admitting defeat.
 */
const MAX_SPLITS = Number(process.env.OVERPASS_MAX_SPLITS ?? 4);

export const osm: Provider = {
  id: "osm",
  label: "OpenStreetMap",

  usable: () => ({ ok: true }),

  async fetch(ctx: ProviderContext): Promise<RawSite[]> {
    const chunks = ctx.chunks(MAX_POINTS, MAX_CHUNK_MILES * METERS_PER_MILE);
    const sites: RawSite[] = [];
    let first = true;
    let failed = 0;
    let split = 0;

    const fetchStretch = async (
      stretch: [number, number][],
      depth: number,
    ): Promise<OverpassElement[]> => {
      const query = buildQuery(stretch, ctx);
      if (!query) return [];

      try {
        return await cached("osm", cacheKey("overpass", ctx.routeKey, query), ctx.stats, async () => {
          // Only pause before a request that is actually going out; a fully
          // cached re-sync should not sit through a delay per stretch.
          if (!first) await sleep(POLITE_MS);
          first = false;

          const body = await overpass(query);
          // Overpass reports a query it could not finish as HTTP 200 with an
          // empty `elements` and the reason in `remark` — so the one failure
          // mode that must not pass silently looks exactly like "nothing out
          // here". Throwing means it is split, retried, and never cached.
          if (body.remark) throw new ProviderError(`Overpass could not answer: ${body.remark}`);
          return body.elements ?? [];
        });
      } catch (err) {
        // Only worth halving if the query asked for too much. A refused
        // connection or a broken query fails the same way however small the
        // stretch, and splitting would just multiply the damage.
        const tooBig = /timed out|could not answer|504/i.test((err as Error).message);
        if (!tooBig || depth >= MAX_SPLITS || stretch.length < 4) throw err;

        // The halves share their middle vertex, so their buffers still meet.
        const mid = Math.floor(stretch.length / 2);
        split++;
        return [
          ...(await fetchStretch(stretch.slice(0, mid + 1), depth + 1)),
          ...(await fetchStretch(stretch.slice(mid), depth + 1)),
        ];
      }
    };

    for (const chunk of chunks) {
      let elements: OverpassElement[];
      try {
        elements = await fetchStretch(chunk, 0);
      } catch (err) {
        // One stretch out of dozens failing must not discard the rest. Half an
        // hour of querying should not be lost to a single timeout, and the
        // stretches that did land stay cached, so a rerun retries only the
        // gaps.
        failed++;
        ctx.warn(`OpenStreetMap: a stretch failed — ${(err as Error).message}`);
        if (failed >= chunks.length) throw err;
        continue;
      }

      for (const el of elements) {
        const site = toSite(el);
        if (site) sites.push(site);
      }
    }

    if (split > 0) {
      ctx.warn(`OpenStreetMap: ${split} stretch(es) were split to fit Overpass's limits.`);
    }
    if (failed > 0) {
      ctx.warn(
        `OpenStreetMap covered ${chunks.length - failed} of ${chunks.length} stretches ` +
          `of the route; re-run the sync to fill the ${failed} that failed.`,
      );
    }
    return sites;
  },
};

/**
 * One query covering every category, with each tag filter carrying its own
 * radius.
 *
 * Clauses are grouped by radius and then by tag key, and the values collapse
 * into a regex, because the polyline has to be repeated verbatim in every
 * clause — so the number of clauses, not the number of categories, is what
 * decides how big the request gets.
 */
export function buildQuery(chunk: [number, number][], ctx: ProviderContext): string | null {
  const poly = chunk.map(([lng, lat]) => `${lat.toFixed(5)},${lng.toFixed(5)}`).join(",");

  // radius (m, rounded so near-identical buffers share a clause) -> key -> values
  const byRadius = new Map<number, Map<string, Set<string>>>();
  for (const { key, values, category } of TAGS) {
    const miles = ctx.buffers.get(category);
    if (miles === undefined) continue;
    const radius = Math.round((miles * METERS_PER_MILE + ctx.slackM) / 100) * 100;

    const keys = byRadius.get(radius) ?? new Map<string, Set<string>>();
    byRadius.set(radius, keys);
    const set = keys.get(key) ?? new Set<string>();
    keys.set(key, set);
    for (const v of values) set.add(v);
  }
  if (byRadius.size === 0) return null;

  const clauses: string[] = [];
  for (const [radius, keys] of byRadius) {
    for (const [key, values] of keys) {
      clauses.push(`nwr(around:${radius},${poly})["${key}"~"^(${[...values].join("|")})$"];`);
    }
  }

  // Overpass is told to give up before the client does, so a query that is
  // simply too big comes back as a readable error rather than an abort.
  const serverTimeout = Math.max(30, Math.floor(TIMEOUT_MS / 1000) - 30);
  // `out center` gives ways and relations a single point, so a campground
  // mapped as an area is usable without carrying its outline.
  return `[out:json][timeout:${serverTimeout}];(${clauses.join("")});out center tags;`;
}

/**
 * Tries the mirrors in turn: the main instance is the one that gets busy, and
 * the fallback is a good deal slower rather than a second fast option — which
 * is why the client timeout is generous enough to cover it.
 */
async function overpass(
  query: string,
): Promise<{ elements?: OverpassElement[]; remark?: string }> {
  let lastError: Error | null = null;

  for (const url of ENDPOINTS) {
    try {
      const res = await request(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ data: query }).toString(),
      });
      return (await res.json()) as { elements?: OverpassElement[]; remark?: string };
    } catch (err) {
      lastError = err as Error;
    }
  }

  throw lastError ?? new Error("no Overpass endpoint configured");
}

function toSite(el: OverpassElement): RawSite | null {
  // Nodes carry coordinates directly; ways and relations only have the center
  // that `out center` computed for them.
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (typeof lat !== "number" || typeof lon !== "number") return null;

  const tags = el.tags ?? {};
  const match = TAGS.find(({ key, values }) => values.includes(tags[key] ?? ""));
  if (!match) return null;

  return {
    sourceId: `${el.type}/${el.id}`,
    category: categoryFor(match.category, tags),
    // An unnamed gas station is still a gas station; brand and operator are
    // what is actually tagged on a lot of rural ones.
    name: text(tags["name"]) ?? text(tags["brand"]) ?? text(tags["operator"]),
    description: describe(tags),
    lng: lon,
    lat,
    detail: {
      openingHours: text(tags["opening_hours"]),
      fee: text(tags["fee"]),
      access: text(tags["access"]),
      osmType: el.type,
    },
    raw: tags,
  };
}

/**
 * OSM has no tag for dispersed camping, but the combination that describes it
 * is conventional: a campsite that is backcountry, or has no facilities and
 * costs nothing.
 */
function categoryFor(base: Category, tags: Record<string, string>): Category {
  if (base !== "camping") return base;
  const backcountry = tags["backcountry"] === "yes";
  const informal = tags["informal"] === "yes";
  return backcountry || informal ? "dispersed" : base;
}

/** The handful of tags that answer "is this any use to me tonight?". */
function describe(tags: Record<string, string>): string | null {
  const parts: string[] = [];
  if (tags["fee"] === "no") parts.push("Free");
  if (tags["fee"] === "yes") parts.push("Fee");
  if (tags["drinking_water"] === "yes") parts.push("Drinking water");
  if (tags["toilets"] === "yes") parts.push("Toilets");
  if (tags["shower"] === "yes") parts.push("Showers");
  if (tags["fuel:diesel"] === "yes") parts.push("Diesel");
  if (tags["opening_hours"]) parts.push(tags["opening_hours"]);
  return parts.length ? parts.join(" · ") : null;
}
