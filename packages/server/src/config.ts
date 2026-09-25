import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, basename, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { isCorridorSource, isFileSource } from "./types.js";
import { CATEGORY_KEYS, unknownCategories } from "./connectors/corridor/categories.js";
import type { SourceConfig, SourceType } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../../..");

dotenv.config({ path: resolve(REPO_ROOT, ".env"), quiet: true });

export const PORT = Number(process.env.PORT ?? 8787);
export const DATA_DIR = resolve(REPO_ROOT, process.env.DATA_DIR ?? "./data");
export const DB_PATH = resolve(DATA_DIR, "amalgamator.db");

const SOURCES_PATH = resolve(REPO_ROOT, "config/sources.json");
const VALID_TYPES: SourceType[] = ["mymaps", "caltopo", "gpx", "takeout", "corridor"];

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
      const c = s as Partial<SourceConfig> & { mapId?: unknown; path?: unknown; route?: unknown };
      if (typeof c?.type !== "string" || !VALID_TYPES.includes(c.type as SourceType)) return false;
      if (typeof c?.id !== "string") return false;
      if (!includeDisabled && c.enabled === false) return false;

      // Each kind of source is addressed by a different field: remote ones by
      // map id, file ones by path, a corridor by the route it follows. A
      // source missing its addressing field cannot be fetched, so it is
      // dropped here rather than failing later with a confusing connector
      // error.
      if (c.type === "gpx" || c.type === "takeout") {
        return typeof c.path === "string" && c.path.length > 0;
      }
      if (c.type === "corridor") {
        return typeof c.route === "string" && c.route.length > 0;
      }
      return typeof c.mapId === "string" && c.mapId.length > 0;
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

  // A misspelled category would otherwise fetch nothing and say nothing —
  // the source would sync "successfully" with a category quietly missing.
  for (const s of sources) {
    if (!isCorridorSource(s)) continue;
    const unknown = unknownCategories(s);
    if (unknown.length > 0) {
      throw new Error(
        `Source "${s.id}" names unknown categor${unknown.length === 1 ? "y" : "ies"} ` +
          `${unknown.map((u) => `"${u}"`).join(", ")}. ` +
          `Valid categories: ${CATEGORY_KEYS.join(", ")}.`,
      );
    }
  }

  return sources;
}

/** Map ids are share tokens — show enough to identify, not enough to reuse. */
export function redactMapId(mapId: string): string {
  if (mapId.length <= 6) return "***";
  return `${mapId.slice(0, 3)}***${mapId.slice(-2)}`;
}

/**
 * A safe one-line identifier for logs and error messages. Map ids are
 * redacted, and file sources show only a basename so a home directory path
 * never ends up in a pasted stack trace.
 */
export function describeSource(cfg: SourceConfig): string {
  if (isFileSource(cfg)) return `path ${redactPath(cfg.path)}`;
  // A route ref is either a repo-relative path or a layer id, neither of which
  // is a secret the way a share token is.
  if (isCorridorSource(cfg)) return `route ${redactPath(cfg.route)}`;
  return `map ${redactMapId(cfg.mapId)}`;
}

/**
 * Paths reach users through error messages. A repo-relative path is safe and
 * useful to echo back ("imports/onx"), but an absolute one carries a home
 * directory and username, so only its leaf is shown.
 */
export function redactPath(p: string): string {
  return isAbsolute(p) ? basename(p) : p;
}
