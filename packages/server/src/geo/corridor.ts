/**
 * Route corridor math: how far is a feature from the route, and how far along
 * the route is it?
 *
 * Deliberately dependency-free. Everything here works in a local
 * equirectangular projection centred on the point being measured, which is
 * accurate to well under 1% at corridor distances (a few hundred km) — far
 * tighter than the precision of a hand-dropped pin — and avoids pulling a GIS
 * library in for what is point-to-segment arithmetic.
 */

export type LngLat = [number, number];

const EARTH_RADIUS_M = 6_371_008.8;
const M_PER_DEG = (EARTH_RADIUS_M * Math.PI) / 180;
export const METERS_PER_MILE = 1609.344;

/** Great-circle distance in meters. */
export function haversine(a: LngLat, b: LngLat): number {
  const p1 = (a[1] * Math.PI) / 180;
  const p2 = (b[1] * Math.PI) / 180;
  const dp = p2 - p1;
  const dl = ((b[0] - a[0]) * Math.PI) / 180;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Distance from p to segment a-b, plus how far along the segment (0..1) the
 * nearest point sits. Projected around p so the scale is right where it
 * matters.
 */
function pointToSegment(p: LngLat, a: LngLat, b: LngLat): { dist: number; t: number } {
  const k = Math.cos((p[1] * Math.PI) / 180) * M_PER_DEG;
  const ax = (a[0] - p[0]) * k;
  const ay = (a[1] - p[1]) * M_PER_DEG;
  const bx = (b[0] - p[0]) * k;
  const by = (b[1] - p[1]) * M_PER_DEG;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  const x = ax + t * dx;
  const y = ay + t * dy;
  return { dist: Math.sqrt(x * x + y * y), t };
}

/**
 * Douglas-Peucker, returning the indices to keep. Iterative, because a
 * cross-country leg is tens of thousands of points and recursion that deep
 * is a stack overflow waiting to happen.
 */
export function simplify(coords: LngLat[], toleranceM: number): number[] {
  const n = coords.length;
  if (n <= 2) return coords.map((_, i) => i);

  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];

  while (stack.length) {
    const [first, last] = stack.pop()!;
    let maxDist = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const { dist } = pointToSegment(coords[i]!, coords[first]!, coords[last]!);
      if (dist > maxDist) {
        maxDist = dist;
        index = i;
      }
    }
    if (index !== -1 && maxDist > toleranceM) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }

  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

/**
 * Puts route legs in travel order by matching each leg's end to the next
 * one's start.
 *
 * File order cannot be trusted: merge-gpx and directory listings both sort
 * alphabetically, so "Abbotsford -> Port Angeles" is followed by "Big Sur ->
 * Three Rivers". Endpoints are what actually encode the itinerary.
 *
 * Returns runs of connected legs. A clean itinerary is one run. Alternates
 * (two legs leaving the same town) or a gap in the route produce extra runs,
 * which callers surface rather than silently papering over.
 */
export function chainLegs(legs: LngLat[][], toleranceM = 5000): LngLat[][][] {
  const usable = legs.filter((l) => l.length >= 2);
  const start = (l: LngLat[]) => l[0]!;
  const end = (l: LngLat[]) => l[l.length - 1]!;

  const successors = usable.map((leg) =>
    usable
      .map((other, j) => ({ j, d: haversine(end(leg), start(other)) }))
      .filter(({ j, d }) => usable[j] !== leg && d <= toleranceM)
      .sort((x, y) => x.d - y.d)
      .map(({ j }) => j),
  );
  const hasPredecessor = new Set(successors.flat());

  const used = new Set<number>();
  const runs: LngLat[][][] = [];

  // Legs nobody leads into are where a trip starts. If every leg has a
  // predecessor the route is a loop, so just start anywhere unused.
  const nextHead = () => {
    const heads = usable.map((_, i) => i).filter((i) => !used.has(i));
    return heads.find((i) => !hasPredecessor.has(i)) ?? heads[0];
  };

  for (let head = nextHead(); head !== undefined; head = nextHead()) {
    const run: LngLat[][] = [];
    let current: number | undefined = head;
    while (current !== undefined && !used.has(current)) {
      used.add(current);
      run.push(usable[current]!);
      current = successors[current]!.find((j) => !used.has(j));
    }
    runs.push(run);
  }
  return runs;
}

/**
 * The same leg often arrives twice — a directory holding both per-leg GPX
 * files and the merged export, or My Maps holding an original and a copy.
 * Legs sharing both endpoints (to ~100 m) are treated as one, keeping the
 * most detailed copy.
 */
export function dedupeLegs(legs: LngLat[][]): LngLat[][] {
  const key = (p: LngLat) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`;
  const best = new Map<string, LngLat[]>();
  for (const leg of legs) {
    if (leg.length < 2) continue;
    const k = `${key(leg[0]!)}>${key(leg[leg.length - 1]!)}`;
    const prev = best.get(k);
    if (!prev || leg.length > prev.length) best.set(k, leg);
  }
  return [...best.values()];
}

/** One connected stretch of route, simplified, with true along-route distance. */
export interface RoutePiece {
  coords: LngLat[];
  /** Meters from the start of the whole route to each vertex. */
  along: number[];
}

export interface Route {
  pieces: RoutePiece[];
  lengthM: number;
  legs: number;
}

/**
 * Chains, measures and simplifies raw legs into a Route.
 *
 * Length is measured on the full-resolution geometry *before* simplifying,
 * then carried onto the kept vertices, so mile markers stay true even though
 * the geometry used for distance checks is a fraction of the size.
 */
export function buildRoute(legs: LngLat[][], toleranceM = 15): Route {
  const unique = dedupeLegs(legs);
  const runs = chainLegs(unique);
  const pieces: RoutePiece[] = [];
  let total = 0;

  for (const run of runs) {
    const full: LngLat[] = [];
    for (const leg of run) {
      // Consecutive legs share an endpoint; skip the duplicate.
      full.push(...(full.length ? leg.slice(1) : leg).map((c) => [c[0], c[1]] as LngLat));
    }
    if (full.length < 2) continue;

    const cumulative = new Float64Array(full.length);
    cumulative[0] = total;
    for (let i = 1; i < full.length; i++) {
      cumulative[i] = cumulative[i - 1]! + haversine(full[i - 1]!, full[i]!);
    }
    total = cumulative[full.length - 1]!;

    const kept = simplify(full, toleranceM);
    pieces.push({
      coords: kept.map((i) => full[i]!),
      along: kept.map((i) => cumulative[i]!),
    });
  }

  return { pieces, lengthM: total, legs: unique.length };
}

export interface Location {
  /** Meters from the nearest point on the route. */
  offRouteM: number;
  /** Meters along the route to that nearest point. */
  alongM: number;
  /** The feature vertex that was closest, for zooming to lines and polygons. */
  at: LngLat;
}

/**
 * A route plus a buffer radius, indexed for repeated lookups.
 *
 * Segments are bucketed into a grid whose cells are at least one radius wide
 * in both directions, so any segment within reach of a point is guaranteed to
 * sit in that point's cell or one of its eight neighbours. That turns
 * "check every segment of a 5,000 mile route" into a few dozen checks.
 */
export class Corridor {
  readonly bbox: [number, number, number, number];
  private readonly cellLat: number;
  private readonly cellLng: number;
  private readonly grid = new Map<number, number[]>();
  /** Flat segment table: [pieceIndex, vertexIndex] pairs. */
  private readonly segments: [number, number][] = [];
  /**
   * Per-segment stamp of the last lookup that measured it. A segment spanning
   * several cells is met more than once per lookup; a stamp skips repeats
   * without allocating a Set for each of the thousands of vertices measured.
   */
  private seen = new Uint32Array(0);
  private stamp = 0;

  constructor(
    readonly route: Route,
    readonly radiusM: number,
  ) {
    let minx = Infinity;
    let miny = Infinity;
    let maxx = -Infinity;
    let maxy = -Infinity;
    for (const piece of route.pieces) {
      for (const [x, y] of piece.coords) {
        if (x < minx) minx = x;
        if (y < miny) miny = y;
        if (x > maxx) maxx = x;
        if (y > maxy) maxy = y;
      }
    }

    this.cellLat = Math.max(radiusM / M_PER_DEG, 0.005);
    // A degree of longitude shrinks toward the poles, so size cells for the
    // highest latitude the corridor reaches; everywhere else they are wider
    // than needed, which only costs a few extra checks.
    const maxAbsLat = Math.min(89, Math.max(Math.abs(miny), Math.abs(maxy)) + this.cellLat);
    this.cellLng = this.cellLat / Math.cos((maxAbsLat * Math.PI) / 180);

    const padLng = this.cellLng;
    const padLat = this.cellLat;
    this.bbox = Number.isFinite(minx)
      ? [minx - padLng, miny - padLat, maxx + padLng, maxy + padLat]
      : [0, 0, 0, 0];

    route.pieces.forEach((piece, p) => {
      for (let i = 0; i < piece.coords.length - 1; i++) {
        const a = piece.coords[i]!;
        const b = piece.coords[i + 1]!;
        const s = this.segments.push([p, i]) - 1;
        const [x0, x1] = [this.cx(Math.min(a[0], b[0])), this.cx(Math.max(a[0], b[0]))];
        const [y0, y1] = [this.cy(Math.min(a[1], b[1])), this.cy(Math.max(a[1], b[1]))];
        for (let x = x0; x <= x1; x++) {
          for (let y = y0; y <= y1; y++) {
            const k = cellKey(x, y);
            const bucket = this.grid.get(k);
            if (bucket) bucket.push(s);
            else this.grid.set(k, [s]);
          }
        }
      }
    });
    this.seen = new Uint32Array(this.segments.length);
  }

  private cx(lng: number) {
    return Math.floor(lng / this.cellLng);
  }

  private cy(lat: number) {
    return Math.floor(lat / this.cellLat);
  }

  /** Nearest point on the route to p, or null if p is outside the corridor. */
  locate(p: LngLat): Location | null {
    const x = this.cx(p[0]);
    const y = this.cy(p[1]);
    let best: Location | null = null;
    if (++this.stamp === 0xffffffff) {
      this.seen.fill(0);
      this.stamp = 1;
    }

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = this.grid.get(cellKey(x + dx, y + dy));
        if (!bucket) continue;
        for (const s of bucket) {
          if (this.seen[s] === this.stamp) continue;
          this.seen[s] = this.stamp;
          const [pi, i] = this.segments[s]!;
          const piece = this.route.pieces[pi]!;
          const { dist, t } = pointToSegment(p, piece.coords[i]!, piece.coords[i + 1]!);
          if (dist <= this.radiusM && (!best || dist < best.offRouteM)) {
            const a = piece.along[i]!;
            best = { offRouteM: dist, alongM: a + t * (piece.along[i + 1]! - a), at: p };
          }
        }
      }
    }
    return best;
  }

  /**
   * Nearest approach of any geometry. Lines and polygons are judged by their
   * closest vertex, so a trail that dips into the corridor counts, and its
   * mile marker is where it comes nearest.
   *
   * Dense lines are thinned to one vertex per VERTEX_SPACING_M first: a
   * recorded track can carry a point every few meters, and measuring each one
   * costs far more than the ~100 m of precision it buys.
   */
  locateGeometry(geom: GeoJSON.Geometry): Location | null {
    let best: Location | null = null;
    let last: LngLat | null = null;
    for (const p of vertices(geom)) {
      if (last && haversine(last, p) < VERTEX_SPACING_M) continue;
      last = p;
      const hit = this.locate(p);
      if (hit && (!best || hit.offRouteM < best.offRouteM)) best = hit;
    }
    return best;
  }
}

const VERTEX_SPACING_M = 200;

/** Cell coordinates packed into one number; string keys dominate lookups otherwise. */
function cellKey(x: number, y: number): number {
  return (x + 1_000_000) * 2_000_000 + (y + 1_000_000);
}

/**
 * Every [lng, lat] in a geometry. Positions are sliced to two ordinates: KML
 * carries altitude and CalTopo adds a fourth value.
 */
export function vertices(geom: GeoJSON.Geometry): LngLat[] {
  const out: LngLat[] = [];
  const walk = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") {
      out.push([c[0], c[1]]);
      return;
    }
    for (const child of c) walk(child);
  };
  if (geom.type === "GeometryCollection") {
    geom.geometries.forEach((g) => out.push(...vertices(g)));
  } else {
    walk(geom.coordinates);
  }
  return out;
}

/** Every line in a geometry, as separate legs. Points are not routes. */
export function lines(geom: GeoJSON.Geometry): LngLat[][] {
  switch (geom.type) {
    case "LineString":
      return [geom.coordinates.map((c) => [c[0]!, c[1]!] as LngLat)];
    case "MultiLineString":
      return geom.coordinates.map((l) => l.map((c) => [c[0]!, c[1]!] as LngLat));
    case "GeometryCollection":
      return geom.geometries.flatMap(lines);
    default:
      return [];
  }
}

/**
 * The route as polylines small enough to hand to a remote API.
 *
 * Two constraints fight here. Providers buffer whatever polyline you send, so
 * the line has to stay faithful to the route; but a 5,000 mile trip is
 * hundreds of thousands of points and every one of them costs request bytes.
 *
 * Douglas-Peucker resolves it, because its tolerance is exactly the guarantee
 * needed: no point of the true route ends up more than `toleranceM` from the
 * line sent. Callers add that much slack to the radius they ask for, over-
 * fetch slightly, and let the local Corridor decide what is really in range.
 *
 * Chunks share their boundary vertex, so the buffers around consecutive chunks
 * cover the route with no seam between them.
 *
 * `maxLengthM` exists because point count is the wrong thing to limit for some
 * providers. Overpass charges by the *area* it has to search, so a thousand
 * miles of route asked for in one go times out however few vertices describe
 * it — and it reports that timeout as an empty result, not an error.
 */
export function queryChunks(
  route: Route,
  toleranceM: number,
  maxPoints: number,
  maxLengthM = Infinity,
): LngLat[][] {
  const chunks: LngLat[][] = [];

  for (const piece of route.pieces) {
    const thinned = simplify(piece.coords, toleranceM).map((i) => piece.coords[i]!);
    if (thinned.length < 2) continue;

    let chunk: LngLat[] = [thinned[0]!];
    let length = 0;

    for (let i = 1; i < thinned.length; i++) {
      length += haversine(thinned[i - 1]!, thinned[i]!);
      chunk.push(thinned[i]!);

      // Split on whichever limit is reached first, and start the next chunk
      // at this same vertex so the two buffers meet with no gap between them.
      if (chunk.length >= maxPoints || length >= maxLengthM) {
        chunks.push(chunk);
        chunk = [thinned[i]!];
        length = 0;
      }
    }
    if (chunk.length >= 2) chunks.push(chunk);
  }

  return chunks;
}

/** Bounding box of a coordinate list, as [minx, miny, maxx, maxy]. */
export function boundsOf(coords: LngLat[]): [number, number, number, number] {
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  for (const [x, y] of coords) {
    if (x < minx) minx = x;
    if (y < miny) miny = y;
    if (x > maxx) maxx = x;
    if (y > maxy) maxy = y;
  }
  return Number.isFinite(minx) ? [minx, miny, maxx, maxy] : [0, 0, 0, 0];
}

/**
 * Points every `spacingM` along a polyline, including both ends.
 *
 * For providers that only answer "what is near this point" — a route has to be
 * covered by a chain of overlapping circles, and the spacing is what decides
 * how many requests that takes.
 */
export function sampleAlong(coords: LngLat[], spacingM: number): LngLat[] {
  if (coords.length === 0) return [];
  const out: LngLat[] = [coords[0]!];
  let carried = 0;

  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1]!;
    const b = coords[i]!;
    const segment = haversine(a, b);
    if (segment === 0) continue;

    // Walk this segment, emitting a point each time the running distance
    // since the last sample passes the spacing.
    let travelled = spacingM - carried;
    while (travelled <= segment) {
      const t = travelled / segment;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      travelled += spacingM;
    }
    carried = segment - (travelled - spacingM);
  }

  const last = coords[coords.length - 1]!;
  if (haversine(out[out.length - 1]!, last) > spacingM / 2) out.push(last);
  return out;
}
