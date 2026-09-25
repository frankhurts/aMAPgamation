import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the DB at a throwaway dir before anything imports config/db, so the
// test never touches the real trip database.
const tmp = mkdtempSync(join(tmpdir(), "amalgamator-corridor-"));
process.env.DATA_DIR = tmp;
after(() => rmSync(tmp, { recursive: true, force: true }));

const {
  Corridor,
  METERS_PER_MILE,
  buildRoute,
  chainLegs,
  dedupeLegs,
  haversine,
  queryChunks,
  sampleAlong,
  simplify,
} = await import("../src/geo/corridor.js");
type LngLat = [number, number];

const ROUTE_DIR = "packages/server/test/fixtures/route";

/** A straight line east along a parallel, `n` points. */
const east = (lat: number, fromLng: number, toLng: number, n = 50): LngLat[] =>
  Array.from({ length: n }, (_, i) => [fromLng + ((toLng - fromLng) * i) / (n - 1), lat]);

test("haversine agrees with a degree of latitude", () => {
  const d = haversine([-110, 40], [-110, 41]);
  assert.ok(Math.abs(d - 111_195) < 50, `got ${d}`);
});

test("legs are chained by endpoints, not by the order they arrive in", () => {
  const a: LngLat[] = [[0, 0], [1, 0]];
  const b: LngLat[] = [[1, 0], [2, 0]];
  const c: LngLat[] = [[2, 0], [3, 0]];

  // Alphabetical file order is what merge-gpx and readdir hand over.
  const runs = chainLegs([c, a, b]);
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0], [a, b, c]);

  // An alternate leg out of the same town cannot be on one line of travel,
  // so it becomes its own piece instead of being spliced in.
  const alternate: LngLat[] = [[1, 0], [1, 1]];
  assert.equal(chainLegs([a, b, c, alternate]).length, 2);
});

test("a leg seen twice is kept once, at its most detailed", () => {
  const coarse: LngLat[] = [[0, 0], [1, 0]];
  const detailed: LngLat[] = [[0, 0], [0.5, 0.0001], [1, 0]];
  assert.deepEqual(dedupeLegs([coarse, detailed, coarse]), [detailed]);
});

test("simplifying keeps the shape and the true length", () => {
  const wiggly: LngLat[] = Array.from({ length: 1000 }, (_, i) => [
    -110 + i * 0.001,
    40 + (i % 2) * 0.00001, // ~1 m zigzag, well under tolerance
  ]);
  const kept = simplify(wiggly, 15);
  assert.equal(kept[0], 0);
  assert.equal(kept.at(-1), 999);
  assert.ok(kept.length < 10, `kept ${kept.length} of 1000`);

  // Length comes from the full-resolution line, so mile markers do not
  // shrink when the geometry does.
  const route = buildRoute([wiggly]);
  let full = 0;
  for (let i = 1; i < wiggly.length; i++) full += haversine(wiggly[i - 1]!, wiggly[i]!);
  assert.ok(Math.abs(route.lengthM - full) < 1e-6);
  assert.equal(route.pieces[0]!.along.at(-1), route.lengthM);
});

test("corridor lookups match a brute-force search", () => {
  // Deliberately awkward: a high-latitude stretch where longitude degrees are
  // short, and one long diagonal segment spanning many grid cells.
  const legs: LngLat[][] = [
    east(60, -150, -140, 200),
    [[-140, 60], [-120, 45]],
    east(45, -120, -110, 120),
  ];
  const route = buildRoute(legs, 0);
  const radiusM = 40_000;
  const corridor = new Corridor(route, radiusM);

  const brute = (p: LngLat) => {
    let best: number | null = null;
    for (const piece of route.pieces) {
      for (let i = 0; i < piece.coords.length - 1; i++) {
        // Densely sample each segment; plenty for a 1% tolerance at 40 km.
        const [a, b] = [piece.coords[i]!, piece.coords[i + 1]!];
        const steps = Math.max(1, Math.ceil(haversine(a, b) / 200));
        for (let s = 0; s <= steps; s++) {
          const q: LngLat = [a[0] + ((b[0] - a[0]) * s) / steps, a[1] + ((b[1] - a[1]) * s) / steps];
          const d = haversine(p, q);
          if (best === null || d < best) best = d;
        }
      }
    }
    return best!;
  };

  // Seeded so a failure is reproducible.
  let seed = 42;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

  // Scatter points around random route vertices, so plenty land inside, near
  // the edge and just outside rather than mostly in empty ocean.
  const all = route.pieces.flatMap((piece) => piece.coords);
  let inside = 0;
  for (let n = 0; n < 400; n++) {
    const [lng, lat] = all[Math.floor(rand() * all.length)]!;
    const p: LngLat = [lng + (rand() - 0.5) * 1.6, lat + (rand() - 0.5) * 1.0];
    const expected = brute(p);
    const hit = corridor.locate(p);
    if (expected <= radiusM * 0.99) {
      inside++;
      assert.ok(hit, `missed a point ${Math.round(expected)} m from the route at ${p}`);
      assert.ok(
        Math.abs(hit.offRouteM - expected) < Math.max(250, expected * 0.01),
        `at ${p}: corridor says ${Math.round(hit.offRouteM)} m, brute force ${Math.round(expected)} m`,
      );
    } else if (expected > radiusM * 1.01) {
      assert.equal(hit, null, `${p} is ${Math.round(expected)} m away but matched`);
    }
  }
  assert.ok(inside > 100 && inside < 380, `${inside} of 400 random points landed in the corridor`);
});

test("mile markers measure along the route", () => {
  const route = buildRoute([east(40, -110, -109, 100)]);
  const corridor = new Corridor(route, 10 * METERS_PER_MILE);

  // 5 km north of the midpoint.
  const hit = corridor.locate([-109.5, 40 + 5000 / 111_195])!;
  assert.ok(Math.abs(hit.offRouteM - 5000) < 30);
  assert.ok(Math.abs(hit.alongM - route.lengthM / 2) < 100);

  // A line judged by its nearest vertex.
  const trail: GeoJSON.LineString = {
    type: "LineString",
    coordinates: [[-109.2, 40.5], [-109.2, 40.05], [-109.2, 39.5]],
  };
  const t = corridor.locateGeometry(trail)!;
  assert.ok(t.offRouteM < 6000, `trail crosses the corridor, got ${t.offRouteM}`);
  assert.deepEqual(t.at, [-109.2, 40.05]);
});

test("GPX legs are pulled out regardless of attribute order and quoting", async () => {
  const { gpxLines } = await import("../src/geo/routes.js");
  const legs = gpxLines(`
    <gpx><wpt lat="1" lon="1"/>
      <trk><trkseg><trkpt lon='-110' lat='40'/><trkpt lat="40.1" lon="-110.1"></trkpt></trkseg>
           <trkseg><trkpt lat="41" lon="-111"/><trkpt lat="41.1" lon="-111.1"/></trkseg></trk>
      <rte><rtept lat="42" lon="-112"/><rtept lat="42.1" lon="-112.1"/></rte>
    </gpx>`);
  assert.deepEqual(legs, [
    [[-110, 40], [-110.1, 40.1]],
    [[-111, 41], [-111.1, 41.1]],
    [[-112, 42], [-112.1, 42.1]],
  ]);
});

test("a folder of GPX legs loads as one route in travel order", async () => {
  const { loadRoute } = await import("../src/geo/routes.js");
  const { route, label } = loadRoute(ROUTE_DIR);

  assert.equal(label, "route");
  assert.equal(route.legs, 2);
  assert.equal(route.pieces.length, 1, "the two legs share Monticello and must chain");

  // Starts in Moab even though the Moab leg sorts second.
  const coords = route.pieces[0]!.coords;
  assert.deepEqual(coords[0], [-109.5498, 38.5733]);
  assert.deepEqual(coords.at(-1), [-108.5859, 37.3486]);
});

test("route refs report missing, empty and out-of-repo paths clearly", async () => {
  const { loadRoute, RouteError } = await import("../src/geo/routes.js");
  const fails = (ref: string, status: number, message: RegExp) =>
    assert.throws(
      () => loadRoute(ref),
      (err: unknown) => err instanceof RouteError && err.status === status && message.test(err.message),
    );

  fails("trips/does-not-exist", 404, /No such route/);
  fails("../../etc", 400, /inside the repo/);
  fails("packages/server/test/fixtures/gpx/onx-waypoints.gpx", 400, /only waypoints/);
  fails("layer:nope", 404, /No synced layer/);
});

test("nearRoute finds synced features in travel order", async () => {
  const { replaceSource, stableId } = await import("../src/db.js");
  const { nearRoute, loadRoute } = await import("../src/geo/routes.js");

  const layerId = stableId("pins", "layer");
  const pin = (name: string, lng: number, lat: number) => ({
    id: stableId("pins", name),
    source: "mymaps" as const,
    sourceKey: "pins",
    sourceId: null,
    layerId,
    name,
    description: null,
    color: null,
    geometry: { type: "Point", coordinates: [lng, lat, 0] } as GeoJSON.Point,
    props: {},
    raw: {},
  });

  replaceSource(
    "pins",
    [{ id: layerId, source: "mymaps", sourceKey: "pins", name: "Pins", color: null, sortOrder: 0 }],
    [
      // 1.86 mi east of the second leg, so its mile marker is past Monticello.
      pin("Near Cortez leg", -108.84, 37.52),
      // 1.06 mi west of the first leg.
      pin("Near Moab leg", -109.42, 38.1),
      // Denver: nowhere near.
      pin("Denver", -104.99, 39.74),
    ],
  );

  const firstLegMiles =
    haversine([-109.5498, 38.5733], [-109.48, 38.35]) +
    haversine([-109.48, 38.35], [-109.4, 38.1]) +
    haversine([-109.4, 38.1], [-109.3424, 37.8714]);

  const { matches, route } = nearRoute(ROUTE_DIR, 5);
  assert.deepEqual(matches.map((m) => m.name), ["Near Moab leg", "Near Cortez leg"]);
  assert.ok(matches[1]!.mileMarker > firstLegMiles / METERS_PER_MILE);
  assert.ok(matches.every((m) => m.offRouteMiles < 2));
  assert.equal(route.pieces, 1);
  assert.equal(route.lengthMiles, Math.round(loadRoute(ROUTE_DIR).route.lengthM / METERS_PER_MILE));

  // Shrinking the buffer drops what falls outside it.
  assert.deepEqual(nearRoute(ROUTE_DIR, 1.3).matches.map((m) => m.name), ["Near Moab leg"]);

  assert.throws(() => nearRoute(ROUTE_DIR, 0), /miles must be/);
  assert.throws(() => nearRoute(ROUTE_DIR, 500), /miles must be/);
});

test("a synced layer can be the route, and does not match itself", async () => {
  const { deleteSource, replaceSource, stableId } = await import("../src/db.js");
  const { nearRoute, listRouteCandidates } = await import("../src/geo/routes.js");
  deleteSource("pins");

  const routeLayer = stableId("mm", "route");
  const campLayer = stableId("mm", "camps");
  const base = { source: "mymaps" as const, sourceKey: "mm", sourceId: null, description: null, color: null, props: {}, raw: {} };

  replaceSource(
    "mm",
    [
      { id: routeLayer, source: "mymaps", sourceKey: "mm", name: "Route", color: null, sortOrder: 0 },
      { id: campLayer, source: "mymaps", sourceKey: "mm", name: "Camps", color: null, sortOrder: 1 },
    ],
    [
      {
        ...base,
        id: stableId("mm", "line"),
        layerId: routeLayer,
        name: "Hwy 191",
        geometry: { type: "LineString", coordinates: [[-109.55, 38.57, 0], [-109.34, 37.87, 0]] },
      },
      {
        ...base,
        id: stableId("mm", "camp"),
        layerId: campLayer,
        name: "Wind Whistle",
        geometry: { type: "Point", coordinates: [-109.40, 38.18] },
      },
    ],
  );

  const ref = `layer:${routeLayer}`;
  assert.ok(listRouteCandidates().some((c) => c.ref === ref), "line layers are offered as routes");
  assert.ok(
    !listRouteCandidates().some((c) => c.ref === `layer:${campLayer}`),
    "a layer of points is not a route",
  );

  const { matches, route } = nearRoute(ref, 10);
  assert.equal(route.label, "Route");
  assert.deepEqual(matches.map((m) => m.name), ["Wind Whistle"]);
});

test("query chunks stay within tolerance of the route and overlap at the seams", () => {
  // A long arc, so decimation actually has something to remove.
  const arc: LngLat[] = Array.from({ length: 2000 }, (_, i) => [
    -110 + i * 0.002,
    40 + Math.sin(i / 90) * 0.4,
  ]);
  const route = buildRoute([arc]);
  const chunks = queryChunks(route, 200, 20);

  assert.ok(chunks.length > 1, "a long route is split into several chunks");
  for (const c of chunks) assert.ok(c.length <= 20 && c.length >= 2, `chunk of ${c.length}`);

  // Consecutive chunks share their boundary vertex, or the buffers around them
  // would leave an unsearched gap between one chunk and the next.
  for (let i = 1; i < chunks.length; i++) {
    assert.deepEqual(chunks[i]![0], chunks[i - 1]![chunks[i - 1]!.length - 1]);
  }

  // The guarantee the query radius relies on: no point of the real route is
  // further than the tolerance from the line actually sent.
  const sent = new Corridor(buildRoute([chunks.flat()]), 200);
  for (const p of arc) assert.ok(sent.locate(p), `${p} drifted outside the tolerance`);
});

test("sampling walks the route at a fixed spacing", () => {
  const leg: LngLat[] = [[-110, 40], [-110, 41]]; // ~111 km due north
  const points = sampleAlong(leg, 10_000);

  assert.deepEqual(points[0], leg[0], "starts at the beginning");
  assert.ok(haversine(points[points.length - 1]!, leg[1]!) < 10_000, "reaches the end");
  for (let i = 1; i < points.length - 1; i++) {
    const gap = haversine(points[i - 1]!, points[i]!);
    assert.ok(Math.abs(gap - 10_000) < 50, `gap ${gap.toFixed(0)}m`);
  }

  // A degenerate leg must not spin forever looking for the next sample.
  assert.deepEqual(sampleAlong([[-110, 40], [-110, 40]], 1000), [[-110, 40]]);
  assert.deepEqual(sampleAlong([], 1000), []);
});
