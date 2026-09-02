import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import type { SourceConfig, SourceType } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../../..");

dotenv.config({ path: resolve(REPO_ROOT, ".env"), quiet: true });

export const PORT = Number(process.env.PORT ?? 8787);
export const DATA_DIR = resolve(REPO_ROOT, process.env.DATA_DIR ?? "./data");
export const DB_PATH = resolve(DATA_DIR, "amalgamator.db");

const SOURCES_PATH = resolve(REPO_ROOT, "config/sources.json");
const VALID_TYPES: SourceType[] = ["mymaps", "caltopo", "gpx", "takeout"];

/**
 * Reads config/sources.json. Missing file is not an error — a fresh clone has
 * no map ids, and the server should still boot so the UI can say so.
 *
 * `includeDisabled` matters for pruning: a source turned off with
 * `"enabled": false` is still a known source, and must not be mistaken for an
 * orphan and deleted.
 */
export function loadSources(includeDisabled = false): SourceConfig[] {
  if (!existsSync(SOURCES_PATH)) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(SOURCES_PATH, "utf8"));
  } catch (err) {
    throw new Error(
      `config/sources.json is not valid JSON: ${(err as Error).message}`,
    );
  }

  return parseSources(parsed, includeDisabled);
}

/**
 * Validates the parsed sources.json. Split from file reading so the rules can
 * be tested without touching the real config.
 */
export function parseSources(parsed: unknown, includeDisabled = false): SourceConfig[] {
  const raw = (parsed as { sources?: unknown })?.sources;
  if (!Array.isArray(raw)) {
    throw new Error('config/sources.json must contain a "sources" array.');
  }

  const sources = raw
    .filter((s): s is SourceConfig => {
      const c = s as Partial<SourceConfig>;
      return (
        typeof c?.type === "string" &&
        VALID_TYPES.includes(c.type as SourceType) &&
        typeof c?.id === "string" &&
        typeof c?.mapId === "string" &&
        (includeDisabled || c.enabled !== false)
      );
    })
    .map((s) => ({ ...s, label: s.label ?? s.id }));

  // `id` is the database key: rows are stored against it and deletes are
  // scoped to it. Two sources sharing an id silently overwrite each other on
  // every sync, so this is refused rather than tolerated.
  const seen = new Set<string>();
  for (const s of sources) {
    if (seen.has(s.id)) {
      throw new Error(
        `Duplicate source id "${s.id}" in config/sources.json. ` +
          `Each source needs a unique "id" — it is the database key, so two ` +
          `sources sharing one overwrite each other's data on every sync. ` +
          `Note that "label" is the display name and may repeat freely.`,
      );
    }
    seen.add(s.id);
  }

  return sources;
}

/** Map ids are share tokens — show enough to identify, not enough to reuse. */
export function redactMapId(mapId: string): string {
  if (mapId.length <= 6) return "***";
  return `${mapId.slice(0, 3)}***${mapId.slice(-2)}`;
}
