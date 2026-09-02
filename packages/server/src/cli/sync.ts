import { loadSources, redactMapId } from "../config.js";
import { syncAll } from "../connectors/index.js";
import { deleteSource, findOrphanedSources, stats } from "../db.js";

const prune = process.argv.includes("--prune");

const sources = loadSources();
if (sources.length === 0) {
  console.error("No sources configured.");
  console.error("Copy config/sources.example.json to config/sources.json and add your map ids.");
  process.exit(1);
}

console.log(`Syncing ${sources.length} source(s)...\n`);
for (const s of sources) {
  console.log(`  ${s.type.padEnd(8)} ${s.label}  (map ${redactMapId(s.mapId)})`);
}
console.log("");

const results = await syncAll(sources);
let failed = 0;

for (const r of results) {
  if (r.ok) {
    console.log(`  OK    ${r.label}: ${r.layers} layers, ${r.features} features (${r.durationMs}ms)`);
  } else {
    failed++;
    console.error(`  FAIL  ${r.label}: ${r.error}`);
  }
}

// Renaming a source's `id` strands its old rows, which would otherwise show up
// in the sidebar as a duplicate under the old key.
const orphans = findOrphanedSources();
if (orphans.length > 0) {
  console.log("");
  if (prune) {
    for (const o of orphans) {
      const gone = deleteSource(o.source_key);
      console.log(`  PRUNED "${gone.sourceKey}": ${gone.layers} layers, ${gone.features} features`);
    }
  } else {
    console.log(`  ${orphans.length} source(s) in the database are no longer in sources.json:`);
    for (const o of orphans) {
      console.log(`    "${o.source_key}" — ${o.layers} layers, ${o.features} features`);
    }
    console.log(`  This is expected right after renaming a source id.`);
    console.log(`  Remove them with:  npm run sync -- --prune`);
  }
}

const s = stats();
console.log(`\nDatabase now holds ${s.features} features across ${s.layers} layers.`);
process.exit(failed > 0 ? 1 : 0);
