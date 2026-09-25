import type { RouteLine } from "./api";

const M_PER_DEG = (6_371_008.8 * Math.PI) / 180;
const METERS_PER_MILE = 1609.344;
/** Points per semicircle. At 8 the rounded ends stray under 2% of the radius. */
const ARC_STEPS = 8;

/**
 * The corridor as polygons for display: one capsule (a segment with rounded
 * ends) per route segment. Their union is exactly the set of points within
 * `miles` of the route — the same test the server applies.
 *
 * The capsules are left overlapping rather than unioned. A true union of a
 * cross-country route takes seconds, and the band is drawn as a
 * fill-extrusion, which MapLibre composites as one layer so overlaps do not
 * darken. Each end is scaled by its own latitude, so the band stays true from
 * Washington to Arizona.
 */
export function corridorBuffer(line: RouteLine, miles: number): GeoJSON.FeatureCollection<GeoJSON.Polygon> {
  const r = miles * METERS_PER_MILE;
  const features: GeoJSON.Feature<GeoJSON.Polygon>[] = [];

  for (const f of line.features) {
    const coords = f.geometry.coordinates;
    for (let i = 0; i < coords.length - 1; i++) {
      const a = coords[i]!;
      const b = coords[i + 1]!;
      const k = Math.cos((a[1]! * Math.PI) / 180);
      const heading = Math.atan2(b[1]! - a[1]!, (b[0]! - a[0]!) * k);

      const ring: number[][] = [];
      const arc = (c: number[], from: number) => {
        const kc = Math.cos((c[1]! * Math.PI) / 180);
        for (let j = 0; j <= ARC_STEPS; j++) {
          const t = from + (Math.PI * j) / ARC_STEPS;
          ring.push([c[0]! + (Math.cos(t) * r) / (M_PER_DEG * kc), c[1]! + (Math.sin(t) * r) / M_PER_DEG]);
        }
      };
      arc(b, heading - Math.PI / 2);
      arc(a, heading + Math.PI / 2);
      ring.push(ring[0]!);

      features.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: {} });
    }
  }
  return { type: "FeatureCollection", features };
}
