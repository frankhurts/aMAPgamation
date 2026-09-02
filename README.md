# Map Amalgamator

One map that merges the geo data scattered across Google My Maps, CalTopo, OnX,
and Google Maps saved places.

**Phase 1 (this repo):** Google My Maps + CalTopo sync into a local SQLite
store, rendered on a MapLibre viewer with per-layer toggles.

## Why it's an importer, not an API client

Only one of these services has a usable read API, so the architecture is an ETL
pipeline rather than a live aggregator:

| Source | How data gets in | Status |
| --- | --- | --- |
| Google My Maps | KML export endpoint (`/maps/d/kml?forcekml=1&mid=…`), folders preserved as layers | Phase 1 |
| CalTopo | `api/v1/map/<id>/since/0` GeoJSON, folders preserved as layers | Phase 1 |
| OnX Backcountry / Offroad | GPX/KML export from the app. No API, and their ToS forbids scraping | Phase 2 |
| Google Maps saved places | Google Takeout, hydrated via the Places API | Phase 2 |
| BLM / USFS / PAD-US public land | Direct from the agencies' ArcGIS services — the data OnX resells is public domain | Phase 3 |

Because everything is downloaded rather than proxied, offline is a packaging
decision (Phase 4) rather than an architectural one.

## Setup

```bash
npm install
cp config/sources.example.json config/sources.json   # then add your map ids
npm run dev                                          # API :8787, UI :5173
```

Open <http://localhost:5173> and press **Sync sources**. Or sync from the CLI:

```bash
npm run sync
```

### Finding your map ids

- **My Maps** — the `mid=` parameter in the map's URL. The map must be shared as
  *anyone with the link can view*; a private map returns 404.
- **CalTopo** — the short code in `https://caltopo.com/m/<mapId>`. The map must
  be shared publicly or by link.

## Keeping your data out of git

Map ids are effectively share tokens: anyone holding one can read that map. The
`.gitignore` is written to keep every piece of that out of version control.

| Committed | Ignored |
| --- | --- |
| `config/sources.example.json` | `config/sources.json` — your real map ids |
| `.env.example` | `.env` — API keys |
| `packages/server/test/fixtures/` | `data/` — the SQLite DB with your trip |
| | `imports/`, `*.gpx`, `*.kml`, `*.kmz` |

Sync errors redact map ids (`1Ab***yz`) so a pasted stack trace or a screenshot
of the UI leaks nothing reusable.

Verify before your first push:

```bash
git status --ignored --short   # confirm config/sources.json and data/ are ignored
```

## How it fits together

```
config/sources.json ─→ connectors/ ─→ NormalizedFeature ─→ SQLite ─→ /api/features ─→ MapLibre
                       mymaps.ts                            (data/)
                       caltopo.ts
```

Every connector normalizes to one canonical feature shape that keeps a verbatim
`raw` copy of the upstream properties — re-syncing is cheap, but re-deriving
data a connector threw away is not.

Feature ids are content-derived hashes, so re-syncing a map updates rows in
place instead of duplicating them. Deletes are scoped to `source_key`, which is
what lets you re-sync one My Maps map without touching your CalTopo layers or
hand-imported GPX tracks.

Color is resolved once per layer, not per feature, so everything under one
sidebar item renders identically and the swatch predicts what is on the map. A
layer adopts whichever color most of its features carried upstream — a My Maps
folder styled green stays green — and falls back to the palette when a folder
has no styling. Per-feature colors are preserved on `props.sourceColor` for the
styling/templating pass, so nothing is lost.

Because color lives on the feature, the map's paint spec stays static and
toggling a layer is just a `setData` call.

## Commands

| Command | Does |
| --- | --- |
| `npm run dev` | API + UI together |
| `npm run sync` | Sync all sources from the CLI |
| `npm test` | Fixture-backed connector tests (no network, no real map ids) |
| `npm run typecheck` | `tsc --noEmit` across both workspaces |

## Basemaps

Topo (OpenTopoMap), Satellite (Esri World Imagery), and Streets (OpenFreeMap) —
all key-free, all under usage policies that allow personal use. Don't bulk-
download or rehost their tiles. Phase 3 replaces them with local PMTiles, which
is what makes the whole thing work with no signal.

## Roadmap

- **Phase 2** — GPX import (OnX exports), Google Takeout + Places hydration
- **Phase 3** — PAD-US / BLM / USFS MVUM clipped to route, built into PMTiles
- **Phase 4** — Trip → Day → Stop model, offline PWA packaging

- [] adding multiple MyMaps maps (e.g.: road trip - Utah, road trip - Montana, etc)
- [] adding multiple maps for all services (CalTopo mostly)
- [] adding functionality for AllTrails, Strava, iOverland, hipcamp, campspot, campendium
