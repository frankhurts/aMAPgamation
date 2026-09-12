#!/usr/bin/env node
/**
 * Merge many GPX files into one.
 *
 * gmaps2gpx writes one GPX per URL and silently ignores -o when given more
 * than one URL, so combining is a separate step. My Maps counts each imported
 * file as its own layer and caps a map at 10, so folding a batch of routes
 * into a single GPX is what keeps a big route collection importable.
 *
 *   node scripts/merge-gpx.mjs -o combined.gpx routes/*.gpx
 *   node scripts/merge-gpx.mjs -o combined.gpx --name "Montana trip" routes/
 *
 * Track and waypoint names are preserved, so each route stays identifiable
 * inside the single merged layer.
 */
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, basename } from "node:path";

const GPX_NS = "http://www.topografix.com/GPX/1/1";

function parseArgs(argv) {
  const inputs = [];
  let out = "combined.gpx";
  let name = "Combined routes";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-o" || a === "--output") out = argv[++i];
    else if (a === "--name") name = argv[++i];
    else if (a === "-h" || a === "--help") {
      console.log("usage: merge-gpx.mjs [-o out.gpx] [--name TITLE] <file.gpx|dir> ...");
      process.exit(0);
    } else inputs.push(a);
  }
  if (inputs.length === 0) {
    console.error("error: no input .gpx files given");
    process.exit(1);
  }
  return { inputs, out, name };
}

/** Expand directories into the .gpx files they hold, sorted for stable output. */
function expand(inputs) {
  const files = [];
  for (const p of inputs) {
    if (statSync(p).isDirectory()) {
      for (const f of readdirSync(p).sort()) {
        if (extname(f).toLowerCase() === ".gpx") files.push(join(p, f));
      }
    } else files.push(p);
  }
  return files;
}

const { inputs, out, name } = parseArgs(process.argv.slice(2));
const files = expand(inputs);

const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const merged = new DOMParser().parseFromString(
  `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="merge-gpx" xmlns="${GPX_NS}">
  <metadata><name>${name.replace(/[<&]/g, (c) => (c === "&" ? "&amp;" : "&lt;"))}</name><time>${now}</time></metadata>
</gpx>`,
  "text/xml",
);
const root = merged.documentElement;

let trk = 0;
let wpt = 0;
let rte = 0;

// Collect across every file before appending: the GPX 1.1 schema fixes the
// order of the top-level children as wpt*, then rte*, then trk*, so appending
// file by file would interleave the three and produce a document that strict
// validators reject.
const collected = { wpt: [], rte: [], trk: [] };

for (const file of files) {
  const doc = new DOMParser().parseFromString(readFileSync(file, "utf8"), "text/xml");
  for (const tag of ["wpt", "rte", "trk"]) {
    for (const node of Array.from(doc.getElementsByTagName(tag))) {
      // Fall back to the filename when a track has no name of its own, so the
      // route is still identifiable once everything shares one layer.
      if (tag !== "wpt" && node.getElementsByTagName("name").length === 0) {
        const n = merged.createElementNS(GPX_NS, "name");
        n.appendChild(merged.createTextNode(basename(file, extname(file))));
        node.insertBefore(n, node.firstChild);
      }
      collected[tag].push(merged.importNode(node, true));
    }
  }
}

for (const tag of ["wpt", "rte", "trk"]) {
  for (const node of collected[tag]) root.appendChild(node);
}

wpt = collected.wpt.length;
rte = collected.rte.length;
trk = collected.trk.length;

writeFileSync(out, new XMLSerializer().serializeToString(merged) + "\n");
console.log(
  `Merged ${files.length} file(s) -> ${out}\n` +
    `  ${trk} track(s), ${rte} route(s), ${wpt} waypoint(s)`,
);
