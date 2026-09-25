import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Point the DB and the response cache at a throwaway dir before anything
// imports config/db, so the test never touches the real trip database and
// always starts with a cold cache.
const tmp = mkdtempSync(join(tmpdir(), "amalgamator-corridor-conn-"));
process.env.DATA_DIR = tmp;
process.env.OVERPASS_DELAY_MS = "0";
process.env.CORRIDOR_RETRY_BASE_MS = "1";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (n: string) => readFileSync(join(here, "fixtures", "corridor", n), "utf8");

const { syncCorridor } = await import("../src/connectors/corridor/index.js");
const { buildQuery } = await import("../src/connectors/corridor/osm.js");
const { resolveBuffers, CATEGORIES } = await import("../src/connectors/corridor/categories.js");
const { parseSources } = await import("../src/config.js");
import type { CorridorSourceConfig, NormalizedFeature } from "../src/types.js";

/** The fixture legs run Moab -> Monticello -> Cortez; Moab is mile 0. */
const ROUTE = "packages/server/test/fixtures/route";

const realFetch = globalThis.fetch;
let calls: string[] = [];

/** Serves fixtures by host, and records every request that actually goes out. */
function stubFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = String(init?.body ?? "");
    calls.push(url);

    if (url.includes("gis.blm.gov")) {
      assert.ok(body.includes("inSR=4326"), "the input SR must be stated or BLM silently returns nothing");
      assert.ok(body.includes("units=esriSRUnit_StatuteMile"), "omitting units silently returns nothing");
      assert.equal(init?.method, "POST", "a GET query string breaks past ~10 KB");
      return new Response(fixture("blm.json"), { status: 200 });
    }
    if (url.includes("/api/interpreter")) {
      assert.ok(body.startsWith("data="), "Overpass takes the query as form-encoded data");
      return new Response(fixture("overpass.json"), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
}

before(stubFetch);
after(() => {
  globalThis.fetch = realFetch;
  rmSync(tmp, { recursive: true, force: true });
});

const config = (over: Partial<CorridorSourceConfig> = {}): CorridorSourceConfig => ({
  type: "corridor",
  id: "test-corridor",
  label: "Test Corridor",
  route: ROUTE,
  providers: ["blm", "osm"],
  ...over,
});

const byCategory = (features: NormalizedFeature[]) => {
  const out = new Map<string, string[]>();
  for (const f of features) {
    const c = f.props["category"] as string;
    out.set(c, [...(out.get(c) ?? []), f.name ?? ""]);
  }
  return out;
};

test("buffers default per category, and can be widened without narrowing the rest", () => {
  const all = resolveBuffers(undefined, undefined);
  assert.equal(all.size, Object.keys(CATEGORIES).length);
  assert.equal(all.get("fuel"), CATEGORIES.fuel.defaultMiles);

  // Naming one buffer must not be read as "fetch only this".
  const widened = resolveBuffers({ fuel: 40 }, undefined);
  assert.equal(widened.get("fuel"), 40);
  assert.equal(widened.size, all.size);

  // Narrowing is what `categories` is for.
  const narrowed = resolveBuffers({ fuel: 40 }, ["fuel", "water"]);
  assert.deepEqual([...narrowed.keys()], ["fuel", "water"]);
});

test("a misspelled category is refused at config load, not silently dropped", () => {
  assert.throws(
    () =>
      parseSources({
        sources: [{ type: "corridor", id: "c", route: "trips/x", buffers: { campsites: 10 } }],
      }),
    /unknown categor/i,
  );
  assert.throws(
    () => parseSources({ sources: [{ type: "corridor", id: "c", route: "trips/x", categories: ["fuel", "nope"] }] }),
    /"nope"/,
  );
  // A corridor with no route cannot be fetched, so it is dropped like any
  // other source missing its addressing field.
  assert.deepEqual(parseSources({ sources: [{ type: "corridor", id: "c" }] }), []);
});

test("one Overpass query carries every category, each at its own radius", () => {
  const ctx = {
    buffers: resolveBuffers({ fuel: 5, camping: 25 }, ["fuel", "camping"]),
    slackM: 0,
  } as Parameters<typeof buildQuery>[1];

  const q = buildQuery([[-109.5, 38.5], [-109.3, 37.8]], ctx)!;
  // Fuel at 5 mi and camping at 25 mi are separate clauses at separate radii;
  // sending one query at the widest radius would drag the whole continent's
  // gas stations back to be thrown away locally.
  assert.match(q, /around:8000,[\d.,-]+\)\["amenity"~"\^\(fuel\)\$"\]/);
  assert.match(q, /around:40200,[\d.,-]+\)\["tourism"~"\^\(camp_site\|caravan_site\)\$"\]/);
  assert.match(q, /^\[out:json\]\[timeout:\d+\];/);
  assert.match(q, /out center tags;$/, "ways and relations need a center to be mappable");

  assert.equal(buildQuery([[-109.5, 38.5]], { ...ctx, buffers: new Map() } as typeof ctx), null);
});

test("fetched sites land in category layers, measured against the real route", async () => {
  calls = [];
  const { layers, features, notes } = await syncCorridor(config());

  const cats = byCategory(features);
  assert.deepEqual(
    [...cats.keys()].sort(),
    ["camping", "dispersed", "fuel", "groceries", "toilets", "water"],
  );

  // BLM runs before OSM, so its record of Wind Whistle wins and the OSM copy
  // 28 m away is dropped rather than double-pinning the same campground.
  assert.ok(cats.get("camping")?.includes("Wind Whistle Campground"));
  assert.ok(!cats.get("camping")?.includes("Wind Whistle (OSM copy)"));

  // OSM maps one campground as an area and a node inside it, so the same
  // provider really does hand back the same place twice — but only where the
  // names agree. The unnamed campsite alongside them is not evidence of that.
  assert.deepEqual(cats.get("camping")?.sort(), [
    "Camping",
    "Dalton Springs",
    "Wind Whistle Campground",
  ]);
  assert.ok(notes.some((n) => /2 duplicate/.test(n)), notes.join(" | "));

  // Two of these are pumps 45 m apart from the *same* provider — two real gas
  // stations at one junction, not one station recorded twice.
  assert.equal(cats.get("fuel")?.length, 3);
  assert.ok(cats.get("fuel")?.includes("Monticello Fuel"));
  assert.ok(cats.get("fuel")?.includes("Second Pump"), "an unnamed pump falls back to its brand");

  // A primitive BLM site and an OSM campsite tagged backcountry are the same
  // question being answered by two vocabularies.
  assert.deepEqual(cats.get("dispersed")?.sort(), [
    "Bridger Jack Mesa Designated Dispersed Camping",
    "Hatch Point Dispersed",
  ]);

  // Off-corridor, untagged and coordinate-less records never become features.
  assert.ok(!features.some((f) => f.name === "Far Off Route Fuel"), "outside the 5 mi fuel buffer");
  assert.ok(!features.some((f) => f.name === "Not A Service"), "amenity=bench is not a category");
  assert.ok(!features.some((f) => f.name === "No Coordinates"));
  assert.ok(!features.some((f) => f.name === "Trailhead Parking"), "BLM parking is not a category");

  // Every layer is a category that actually has something in it.
  assert.equal(layers.length, cats.size);
  for (const l of layers) {
    assert.equal(l.source, "corridor");
    assert.equal(l.sourceKey, "test-corridor");
    assert.ok(features.some((f) => f.layerId === l.id));
  }

  // The two numbers the whole feature exists to answer.
  const moab = features.find((f) => f.name?.startsWith("Bridger Jack"))!;
  assert.equal(moab.props["mileMarker"], 0, "Moab is the start of the route");
  assert.ok((moab.props["offRouteMiles"] as number) < 0.1);
  assert.equal(moab.props["provider"], "blm");
  assert.equal(moab.props["categoryLabel"], "Dispersed camping");

  const marks = features.map((f) => f.props["mileMarker"] as number);
  assert.deepEqual(marks, [...marks].sort((a, b) => a - b), "features come out in travel order");
});

test("a second sync answers from disk instead of re-hitting the APIs", async () => {
  calls = [];
  const again = await syncCorridor(config());
  assert.deepEqual(calls, [], "nothing went out over the network");
  assert.ok(again.features.length > 0, "and the data is all still there");
  assert.ok(again.notes.some((n) => /cache \d+ hit \/ 0 miss/.test(n)), again.notes.join(" | "));
});

test("narrowing categories narrows what is fetched at all", async () => {
  calls = [];
  const { layers, features } = await syncCorridor(config({ categories: ["fuel"] }));
  assert.deepEqual(layers.map((l) => l.name), ["Fuel"]);
  assert.ok(features.every((f) => f.props["category"] === "fuel"));
  // BLM has no fuel, so asking only for fuel must not query it at all.
  assert.ok(!calls.some((c) => c.includes("gis.blm.gov")), calls.join(" | "));
});

test("one provider failing does not throw away the others", async () => {
  calls = [];
  const saved = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/api/interpreter")) return new Response("busy", { status: 504 });
    return saved(input, init);
  }) as typeof fetch;

  try {
    // A different route, so neither provider can answer from the cache that
    // the earlier syncs filled — otherwise nothing goes out and the failure
    // being tested never happens.
    const { features, notes } = await syncCorridor(
      config({ id: "partial-corridor", route: `${ROUTE}/b-moab-to-monticello.gpx` }),
    );
    assert.ok(features.some((f) => f.props["provider"] === "blm"), "BLM results survived");
    assert.ok(!features.some((f) => f.props["provider"] === "osm"));
    assert.ok(notes.some((n) => /OpenStreetMap failed/.test(n)), notes.join(" | "));
  } finally {
    globalThis.fetch = saved;
  }
});

test("an unknown provider or an unusable route is refused with a usable message", async () => {
  await assert.rejects(
    () => syncCorridor(config({ providers: ["blm", "onx"] })),
    /Unknown provider\(s\) "onx".*Available: blm, ridb, osm/s,
  );
  await assert.rejects(
    () => syncCorridor(config({ route: "packages/server/test/fixtures/does-not-exist" })),
    /No such route file or folder/,
  );
});

test("recreation.gov says how to turn itself on rather than failing the sync", async () => {
  const key = process.env.RIDB_API_KEY;
  delete process.env.RIDB_API_KEY;
  try {
    const { notes, features } = await syncCorridor(
      config({ id: "ridb-corridor", providers: ["ridb", "osm"] }),
    );
    assert.ok(notes.some((n) => /Recreation\.gov skipped.*RIDB_API_KEY/s.test(n)), notes.join(" | "));
    assert.ok(features.some((f) => f.props["provider"] === "osm"), "the rest still synced");
  } finally {
    if (key !== undefined) process.env.RIDB_API_KEY = key;
  }
});
