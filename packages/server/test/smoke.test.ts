import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (n: string) => readFileSync(join(here, "fixtures", n), "utf8");

// Point the DB at a throwaway dir before anything imports config/db, so the
// test never touches the real trip database.
const tmp = mkdtempSync(join(tmpdir(), "amalgamator-test-"));
process.env.DATA_DIR = tmp;

const realFetch = globalThis.fetch;

/** Serves fixtures based on the requested host, so connectors stay untouched. */
function stubFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("google.com/maps/d/kml")) {
      assert.ok(url.includes("forcekml=1"), "must request forcekml to get folder names");
      return new Response(fixture("mymaps.kml"), { status: 200 });
    }
    if (url.includes("caltopo.com/api/v1/map/")) {
      assert.ok(url.includes("/since/0"), "must request full map state");
      return new Response(fixture("caltopo.json"), {
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

test("My Maps folders become layers, styles become colors", async () => {
  const { syncMyMaps } = await import("../src/connectors/mymaps.js");
  const { layers, features } = await syncMyMaps({
    type: "mymaps",
    id: "trip",
    label: "Trip",
    mapId: "fake",
  });

  assert.deepEqual(
    layers.map((l) => l.name),
    ["Day 3 - Moab", "Day 4 - Canyonlands"],
  );
  assert.equal(features.length, 3);

  const trail = features.find((f) => f.name === "Shafer Trail");
  assert.ok(trail);
  assert.equal(trail.geometry.type, "LineString");
  // KML aabbggrr ff0000ff is red; a bad byte-order conversion yields #0000ff.
  assert.equal(trail.color, "#ff0000");
  assert.equal(trail.layerId, layers[0]!.id);

  const camp = features.find((f) => f.name === "Camp spot");
  assert.equal(camp?.description, "BLM, free, no services");
  // Unstyled features inherit their layer's palette color.
  assert.equal(camp?.color, layers[0]!.color);
});

test("CalTopo folders become layers and unfiled features get a home", async () => {
  const { syncCalTopo } = await import("../src/connectors/caltopo.js");
  const { layers, features } = await syncCalTopo({
    type: "caltopo",
    id: "backcountry",
    label: "Backcountry",
    mapId: "fake",
  });

  assert.deepEqual(
    layers.map((l) => l.name),
    ["Hiking Routes", "Water Sources", "Backcountry — unfiled"],
  );
  // Folder features carry no geometry and must not become map features.
  assert.equal(features.length, 3);

  const ridge = features.find((f) => f.name === "Ridge Route");
  assert.equal(ridge?.color, "#FF0000");
  assert.equal(ridge?.props["distance"], 4823.5);

  const orphan = features.find((f) => f.name === "Unfiled waypoint");
  assert.equal(orphan?.layerId, layers[2]!.id);
});

test("re-syncing replaces a source without disturbing the others", async () => {
  const { syncSource } = await import("../src/connectors/index.js");
  const { listLayers, stats, featureCollection } = await import("../src/db.js");

  const mymaps = { type: "mymaps", id: "trip", label: "Trip", mapId: "fake" } as const;
  const caltopo = { type: "caltopo", id: "backcountry", label: "Backcountry", mapId: "fake" } as const;

  await syncSource(mymaps);
  await syncSource(caltopo);
  assert.equal(stats().features, 6);

  // Ids are content-derived, so a second sync must be a no-op, not a duplicate.
  await syncSource(mymaps);
  assert.equal(stats().features, 6, "re-sync duplicated features");
  assert.equal(listLayers().length, 5);

  const fc = featureCollection();
  assert.equal(fc.features.length, 6);
  assert.ok(fc.features.every((f) => f.properties?.["layerId"]), "every feature needs a layer");
  assert.ok(fc.features.every((f) => f.properties?.["color"]), "every feature needs a color");
});

test("a failing source reports the error without leaking the map id", async () => {
  const { syncSource } = await import("../src/connectors/index.js");
  globalThis.fetch = (async () => new Response("nope", { status: 404 })) as typeof fetch;

  const result = await syncSource({
    type: "mymaps",
    id: "broken",
    label: "Broken",
    mapId: "SUPERSECRETMAPID12345",
  });

  stubFetch();
  assert.equal(result.ok, false);
  assert.match(result.error!, /anyone with the link/);
  assert.doesNotMatch(result.error!, /SUPERSECRETMAPID12345/, "map id leaked into error");
});
