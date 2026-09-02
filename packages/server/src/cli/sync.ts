import { loadSources, redactMapId } from "../config.js";
import { syncAll } from "../connectors/index.js";
import { stats } from "../db.js";

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

const s = stats();
console.log(`\nDatabase now holds ${s.features} features across ${s.layers} layers.`);
process.exit(failed > 0 ? 1 : 0);
