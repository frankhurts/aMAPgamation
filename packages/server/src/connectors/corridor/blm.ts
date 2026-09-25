import { METERS_PER_MILE } from "../../geo/corridor.js";
import { cached, cacheKey } from "./cache.js";
import type { Category } from "./categories.js";
import { request, text, type Provider, type ProviderContext, type RawSite } from "./provider.js";

/**
 * BLM's national recreation site points.
 *
 * The only provider that buffers server-side: it takes the route polyline and
 * a distance directly, so there is no local GIS work to do and no bounding-box
 * over-fetch to throw away.
 *
 * What it is NOT is a dispersed-camping map. This layer is an inventory of
 * *designated* sites — see the note on `dispersed` below.
 */

const LAYER =
  process.env.BLM_RECS_URL ??
  "https://gis.blm.gov/arcgis/rest/services/recreation/BLM_Natl_Recs_pts/MapServer/23/query";

/** The server caps a page at 2000 however much is asked for. */
const PAGE = 2000;

/**
 * A POST body carries thousands of vertices comfortably (a GET query string
 * breaks around 10 KB, and returns HTML rather than JSON when it does), but a
 * smaller polyline still means a faster query.
 */
const MAX_POINTS = 500;

/**
 * FET_SUBTYPE is free text with 52 values nationally, and the vocabulary is
 * dirty — "Horse Corral" and "Horse Corrals" both exist, as does a literal
 * "UNK". Matching by prefix rather than by exact string is what keeps the four
 * `Campsite - Developed - <Reservable> - <Fee>` permutations from having to be
 * spelled out, and survives new ones being added upstream.
 */
const SUBTYPES: { prefix: string; category: Category }[] = [
  { prefix: "Campground", category: "camping" },
  { prefix: "Campsite - Developed", category: "camping" },
  // Primitive and undeveloped sites are the closest this data comes to
  // dispersed camping, and the gap is worth knowing about: they are still
  // *designated* spots, many of them boat-in river camps that happen to sit
  // near a road. Real dispersed camping is defined by land-status polygons and
  // travel-management rules, which are Phase 3, not points.
  { prefix: "Campsite - Primitive", category: "dispersed" },
  { prefix: "Campsite - Undeveloped", category: "dispersed" },
  { prefix: "Potable Water", category: "water" },
  { prefix: "Toilet", category: "toilets" },
  { prefix: "RV Dump Station", category: "dump" },
  { prefix: "BLM Ranger Station", category: "ranger" },
  { prefix: "Visitor Center", category: "ranger" },
];

interface EsriFeature {
  attributes?: Record<string, unknown>;
  geometry?: { x?: number; y?: number };
}

export const blm: Provider = {
  id: "blm",
  label: "BLM",

  usable: () => ({ ok: true }),

  async fetch(ctx: ProviderContext): Promise<RawSite[]> {
    const chunks = ctx.chunks(MAX_POINTS);
    const sites: RawSite[] = [];
    // One point can come back from two overlapping chunks, and OBJECTID is the
    // cheapest way to notice before the cross-provider pass ever sees it.
    const seen = new Set<string>();

    for (const chunk of chunks) {
      for (const [miles, prefixes] of groupByDistance(ctx)) {
        const attrs = await queryAll(ctx, chunk, miles, prefixes);
        for (const f of attrs) {
          const site = toSite(f);
          if (!site) continue;
          const key = site.sourceId ?? `${site.lng},${site.lat}`;
          if (seen.has(key)) continue;
          seen.add(key);
          sites.push(site);
        }
      }
    }

    return sites;
  },
};

/**
 * Subtypes grouped by the distance they were asked for, so water at 5 miles
 * is not dragged along in the 25-mile camping query and then thrown away.
 */
function groupByDistance(ctx: ProviderContext): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const { prefix, category } of SUBTYPES) {
    const miles = ctx.buffers.get(category);
    if (miles === undefined) continue;
    out.set(miles, [...(out.get(miles) ?? []), prefix]);
  }
  return out;
}

/** Pages through one polyline + distance query until the server stops. */
async function queryAll(
  ctx: ProviderContext,
  chunk: [number, number][],
  miles: number,
  prefixes: string[],
): Promise<EsriFeature[]> {
  // The polyline is decimated, so the query has to reach a little further than
  // asked; the exact distance is measured locally afterwards.
  const distance = miles + ctx.slackM / METERS_PER_MILE;
  const where = prefixes.map((p) => `FET_SUBTYPE LIKE '${p}%'`).join(" OR ");
  const geometry = JSON.stringify({
    paths: [chunk.map(([lng, lat]) => [lng, lat])],
    // Omitting the spatial reference is not an error — it is a silent zero
    // results, because the server reads the coordinates as Web Mercator
    // meters. Same for `units`. Both are sent belt-and-braces.
    spatialReference: { wkid: 4326 },
  });

  const out: EsriFeature[] = [];

  for (let offset = 0; ; offset += PAGE) {
    const body = new URLSearchParams({
      geometry,
      geometryType: "esriGeometryPolyline",
      spatialRel: "esriSpatialRelIntersects",
      distance: String(distance),
      units: "esriSRUnit_StatuteMile",
      inSR: "4326",
      outSR: "4326",
      where,
      outFields: "*",
      returnGeometry: "true",
      resultOffset: String(offset),
      resultRecordCount: String(PAGE),
      f: "json",
    }).toString();

    const key = cacheKey("blm", ctx.routeKey, body);
    const page = await cached("blm", key, ctx.stats, async () => {
      const res = await request(LAYER, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      const json = (await res.json()) as {
        features?: EsriFeature[];
        exceededTransferLimit?: boolean;
        error?: { message?: string };
      };
      // ArcGIS reports query errors inside a 200 response.
      if (json.error) throw new Error(`BLM query rejected: ${json.error.message ?? "unknown"}`);
      return json;
    });

    out.push(...(page.features ?? []));
    // The flag is omitted entirely on the last page rather than set to false.
    if (page.exceededTransferLimit !== true) break;
  }

  return out;
}

function toSite(f: EsriFeature): RawSite | null {
  const a = f.attributes ?? {};
  // LAT/LONG attributes exist but are a stale reprojection round-trip; the
  // geometry is authoritative.
  const lng = Number(f.geometry?.x);
  const lat = Number(f.geometry?.y);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;

  const subtype = text(a["FET_SUBTYPE"]);
  const match = SUBTYPES.find((s) => subtype?.startsWith(s.prefix));
  if (!match) return null;

  return {
    // OBJECTID is reassigned when BLM reloads the data; the GlobalID is not.
    sourceId: text(a["Original_GlobalID"]) ?? text(a["OBJECTID"]),
    category: match.category,
    name: text(a["FET_NAME"]),
    // The subtype carries the fee/reservable detail the description usually
    // lacks ("Campsite - Primitive - Non Reservable - No Fee").
    description: [subtype, text(a["DESCRIPTION"])].filter(Boolean).join(" — ") || null,
    lng,
    lat,
    detail: {
      subtype,
      state: text(a["ADMIN_ST"]),
      unit: text(a["UNIT_NAME"]),
      link: text(a["WEB_LINK"]),
    },
    raw: a,
  };
}
