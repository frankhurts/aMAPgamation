import Fastify from "fastify";
import cors from "@fastify/cors";
import { PORT, loadSources, redactMapId } from "./config.js";
import {
  deleteSource,
  featureCollection,
  findOrphanedSources,
  listLayers,
  stats,
} from "./db.js";
import { syncAll, syncSource } from "./connectors/index.js";

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
await app.register(cors, { origin: true });

app.get("/api/health", async () => ({ ok: true, ...stats() }));

/** Map ids are redacted so a screenshot of the UI leaks nothing reusable. */
app.get("/api/sources", async (_req, reply) => {
  try {
    return {
      sources: loadSources().map((s) => ({
        id: s.id,
        type: s.type,
        label: s.label,
        mapId: redactMapId(s.mapId),
      })),
    };
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
});

app.get("/api/layers", async () => ({ layers: listLayers() }));

/**
 * Sources still in the database but gone from sources.json — normally the
 * leftovers of a renamed source id. Surfaced so the UI can offer to clear them
 * rather than silently showing a stale duplicate.
 */
app.get("/api/orphans", async () => ({ orphans: findOrphanedSources() }));

app.delete<{ Params: { key: string } }>("/api/orphans/:key", async (req, reply) => {
  const orphan = findOrphanedSources().find((o) => o.source_key === req.params.key);
  if (!orphan) {
    return reply
      .code(404)
      .send({ error: `"${req.params.key}" is not an orphaned source.` });
  }
  return deleteSource(orphan.source_key);
});

app.get<{ Querystring: { layers?: string } }>("/api/features", async (req) => {
  const ids = req.query.layers?.split(",").filter(Boolean);
  return featureCollection(ids);
});

app.post<{ Querystring: { source?: string } }>("/api/sync", async (req, reply) => {
  // A malformed or duplicate-id config is a user-fixable problem, so return
  // the explanation rather than a 500.
  let sources;
  try {
    sources = loadSources();
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
  if (sources.length === 0) {
    return reply.code(400).send({
      error: "No sources configured. Copy config/sources.example.json to config/sources.json.",
    });
  }

  const only = req.query.source;
  if (only) {
    const cfg = sources.find((s) => s.id === only);
    if (!cfg) return reply.code(404).send({ error: `Unknown source "${only}".` });
    return { results: [await syncSource(cfg)], orphans: findOrphanedSources(), ...stats() };
  }

  return { results: await syncAll(sources), orphans: findOrphanedSources(), ...stats() };
});

await app.listen({ port: PORT, host: "127.0.0.1" });
