import Fastify from "fastify";
import cors from "@fastify/cors";
import { PORT, loadSources, redactMapId } from "./config.js";
import { featureCollection, listLayers, stats } from "./db.js";
import { syncAll, syncSource } from "./connectors/index.js";

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
await app.register(cors, { origin: true });

app.get("/api/health", async () => ({ ok: true, ...stats() }));

/** Map ids are redacted so a screenshot of the UI leaks nothing reusable. */
app.get("/api/sources", async () => ({
  sources: loadSources().map((s) => ({
    id: s.id,
    type: s.type,
    label: s.label,
    mapId: redactMapId(s.mapId),
  })),
}));

app.get("/api/layers", async () => ({ layers: listLayers() }));

app.get<{ Querystring: { layers?: string } }>("/api/features", async (req) => {
  const ids = req.query.layers?.split(",").filter(Boolean);
  return featureCollection(ids);
});

app.post<{ Querystring: { source?: string } }>("/api/sync", async (req, reply) => {
  const sources = loadSources();
  if (sources.length === 0) {
    return reply.code(400).send({
      error: "No sources configured. Copy config/sources.example.json to config/sources.json.",
    });
  }

  const only = req.query.source;
  if (only) {
    const cfg = sources.find((s) => s.id === only);
    if (!cfg) return reply.code(404).send({ error: `Unknown source "${only}".` });
    return { results: [await syncSource(cfg)], ...stats() };
  }

  return { results: await syncAll(sources), ...stats() };
});

await app.listen({ port: PORT, host: "127.0.0.1" });
