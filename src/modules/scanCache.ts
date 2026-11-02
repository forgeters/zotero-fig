import { config } from "../../package.json";
import type { FigureScanResult } from "./figureTypes";

/**
 * Bump this whenever caption detection or bbox matching changes, so stale
 * results are discarded instead of being shown again.
 */
const CACHE_VERSION = 1;
const CACHE_DIR_NAME = "scan-cache";
const MAX_CACHE_FILES = 100;
/**
 * Results produced without the PyMuPDF helper (no Python, helper crashed) are
 * cached too, but only briefly, so fixing the environment takes effect quickly
 * instead of requiring the refresh button.
 */
const RETRY_WINDOW_MS = 5 * 60 * 1000;

export interface ScanCacheEntry {
  key: string;
  filePath: string;
}

interface CachedPayload {
  version: number;
  key: string;
  savedAt: number;
  result: FigureScanResult;
}

export async function getScanCacheEntry(
  item: Zotero.Item,
): Promise<ScanCacheEntry | undefined> {
  try {
    const pdfPath = await item.getFilePathAsync();
    if (!pdfPath) {
      return undefined;
    }

    const stat = await IOUtils.stat(pdfPath);
    const key = [
      CACHE_VERSION,
      item.libraryID,
      item.key,
      pdfPath,
      stat.lastModified ?? 0,
      stat.size ?? 0,
    ].join("|");

    return {
      key,
      filePath: PathUtils.join(
        getCacheDir(),
        `${item.key}-${hashString(key)}.json`,
      ),
    };
  } catch (error) {
    ztoolkit.log("Failed to build scan cache key", {
      itemID: item.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

export async function readScanCache(
  entry: ScanCacheEntry,
): Promise<FigureScanResult | undefined> {
  try {
    if (!(await IOUtils.exists(entry.filePath))) {
      return undefined;
    }

    const raw = await Zotero.File.getContentsAsync(entry.filePath);
    if (typeof raw !== "string" || !raw.trim()) {
      return undefined;
    }

    const payload = JSON.parse(raw) as CachedPayload;
    if (
      payload?.version !== CACHE_VERSION ||
      payload.key !== entry.key ||
      !isValidScanResult(payload.result) ||
      !isReusable(payload)
    ) {
      return undefined;
    }

    return payload.result;
  } catch (error) {
    // A corrupt or missing cache file must never break the panel.
    ztoolkit.log("Ignoring unreadable scan cache", {
      filePath: entry.filePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

export async function writeScanCache(
  entry: ScanCacheEntry,
  result: FigureScanResult,
) {
  try {
    await Zotero.File.createDirectoryIfMissingAsync(getCacheDir());
    const payload: CachedPayload = {
      version: CACHE_VERSION,
      key: entry.key,
      savedAt: Date.now(),
      result,
    };
    await Zotero.File.putContentsAsync(entry.filePath, JSON.stringify(payload));
    await pruneCacheDir();
  } catch (error) {
    ztoolkit.log("Failed to write scan cache", {
      filePath: entry.filePath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function isReusable(payload: CachedPayload) {
  const status = payload.result.helperDiagnostics?.status;
  if (!status || status === "succeeded") {
    return true;
  }

  return Date.now() - (payload.savedAt || 0) < RETRY_WINDOW_MS;
}

function isValidScanResult(value: unknown): value is FigureScanResult {
  if (!value || typeof value !== "object") {
    return false;
  }

  const result = value as FigureScanResult;
  return (
    Array.isArray(result.entries) &&
    Array.isArray(result.warnings) &&
    result.entries.every((entry) => {
      return (
        Boolean(entry) &&
        typeof entry.id === "string" &&
        typeof entry.label === "string" &&
        typeof entry.pageIndex === "number" &&
        (entry.type === "figure" || entry.type === "table")
      );
    })
  );
}

function getCacheDir() {
  return PathUtils.join(PathUtils.profileDir, config.addonRef, CACHE_DIR_NAME);
}

async function pruneCacheDir() {
  const paths = await IOUtils.getChildren(getCacheDir());
  if (paths.length <= MAX_CACHE_FILES) {
    return;
  }

  const files: Array<{ path: string; lastModified: number }> = [];
  for (const path of paths) {
    try {
      const stat = await IOUtils.stat(path);
      files.push({ path, lastModified: stat.lastModified ?? 0 });
    } catch {
      // Ignore entries that disappeared or are unreadable.
    }
  }

  files.sort((left, right) => left.lastModified - right.lastModified);
  for (const file of files.slice(0, files.length - MAX_CACHE_FILES)) {
    await IOUtils.remove(file.path, { ignoreAbsent: true });
  }
}

function hashString(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
}
