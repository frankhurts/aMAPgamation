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

const MYMAPS = { type: "mymaps", id: "trip", label: "Trip", mapId: "fake" } as const;
const CALTOPO = { type: "caltopo", id: "backcountry", label: "Backcountry", mapId: "fake" } as const;

test("My Maps folders become layers", async () => {
  const { syncMyMaps } = await import("../src/connectors/mymaps.js");
  const { layers, features } = await syncMyMaps(MYMAPS);

  assert.deepEqual(
    layers.map((l) => l.name),
    ["Day 3 - Moab", "Day 4 - Canyonlands", "Unfiled"],
  );
  assert.equal(features.length, 5);

  const camp = features.find((f) => f.name === "Camp spot");
  assert.equal(camp?.description, "BLM, free, no services");
  assert.equal(camp?.layerId, layers[0]!.id);

  // A placemark outside every <Folder> still needs a sidebar entry; without
  // one the UI's layer filter would silently drop it from the map.
  const loose = features.find((f) => f.name === "Loose pin");
  assert.equal(loose?.layerId, layers[2]!.id, "loose placemark must land in Unfiled");
});

test("every feature renders in its layer's color", async () => {
  const { syncMyMaps } = await import("../src/connectors/mymaps.js");
  const { layers, features } = await syncMyMaps(MYMAPS);
  const colorOf = new Map(layers.map((l) => [l.id, l.color]));

  for (const f of features) {
    assert.equal(
      f.color,
      colorOf.get(f.layerId!),
      `"${f.name}" does not match its layer swatch`,
    );
  }

  // "Day 3 - Moab" holds two red placemarks and one green. The layer settles
  // on the majority color rather than an arbitrary palette entry, so a folder
  // styled in My Maps keeps looking like itself.
  assert.equal(layers[0]!.color, "#ff0000");

  // The outlier is re-colored to match, but its original is preserved so the
  // styling pass can offer "revert to source colors".
  const odd = features.find((f) => f.name === "Odd one out");
  assert.equal(odd?.color, "#ff0000", "outlier must adopt the layer color");
  assert.equal(odd?.props["sourceColor"], "#00ff00", "original color must survive");

  // A folder with no upstream styling at all falls back to the palette.
  assert.equal(layers[1]!.color, "#3cb44b");
});

test("CalTopo folders become layers and unfiled features get a home", async () => {
  const { syncCalTopo } = await import("../src/connectors/caltopo.js");
  const { layers, features } = await syncCalTopo(CALTOPO);

  assert.deepEqual(
    layers.map((l) => l.name),
    ["Hiking Routes", "Water Sources", "Unfiled"],
  );
  // Folder features carry no geometry and must not become map features.
  assert.equal(features.length, 3);

  const ridge = features.find((f) => f.name === "Ridge Route");
  assert.equal(ridge?.color, "#ff0000", "hex casing must not split a color group");
  assert.equal(ridge?.props["distance"], 4823.5);

  const orphan = features.find((f) => f.name === "Unfiled waypoint");
  assert.equal(orphan?.layerId, layers[2]!.id);

  const colorOf = new Map(layers.map((l) => [l.id, l.color]));
  for (const f of features) assert.equal(f.color, colorOf.get(f.layerId!));
});

test("re-syncing replaces a source without disturbing the others", async () => {
  const { syncSource } = await import("../src/connectors/index.js");
  const { listLayers, stats, featureCollection } = await import("../src/db.js");

  await syncSource(MYMAPS);
  await syncSource(CALTOPO);
  assert.equal(stats().features, 8);

  // Ids are content-derived, so a second sync must be a no-op, not a duplicate.
  await syncSource(MYMAPS);
  assert.equal(stats().features, 8, "re-sync duplicated features");
  assert.equal(listLayers().length, 6);

  // Sidebar headings come from the service, not from the sources.json key
  // ("trip"/"backcountry") or the per-map label ("Trip"/"Backcountry").
  assert.deepEqual(
    [...new Set(listLayers().map((l) => l.source_label))].sort(),
    ["CalTopo", "MyMaps"],
    "layers must be labelled by service, not by config id",
  );

  // The swatch the sidebar draws must be the color the map actually paints.
  const swatch = new Map(listLayers().map((l) => [l.id, l.color]));
  const fc = featureCollection();
  assert.equal(fc.features.length, 8);
  for (const f of fc.features) {
    const p = f.properties!;
    assert.ok(p["layerId"], "every feature needs a layer");
    assert.equal(p["color"], swatch.get(String(p["layerId"])), "swatch must predict the map");
  }
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
