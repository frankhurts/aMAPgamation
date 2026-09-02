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
 */
export function loadSources(): SourceConfig[] {
  if (!existsSync(SOURCES_PATH)) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(SOURCES_PATH, "utf8"));
  } catch (err) {
    throw new Error(
      `config/sources.json is not valid JSON: ${(err as Error).message}`,
    );
  }

  const raw = (parsed as { sources?: unknown })?.sources;
  if (!Array.isArray(raw)) {
    throw new Error('config/sources.json must contain a "sources" array.');
  }

  return raw
    .filter((s): s is SourceConfig => {
      const c = s as Partial<SourceConfig>;
      return (
        typeof c?.type === "string" &&
        VALID_TYPES.includes(c.type as SourceType) &&
        typeof c?.id === "string" &&
        typeof c?.mapId === "string" &&
        c.enabled !== false
      );
    })
    .map((s) => ({ ...s, label: s.label ?? s.id }));
}

/** Map ids are share tokens — show enough to identify, not enough to reuse. */
export function redactMapId(mapId: string): string {
  if (mapId.length <= 6) return "***";
  return `${mapId.slice(0, 3)}***${mapId.slice(-2)}`;
}
