import { config } from "../../package.json";
import type {
  FigureEntry,
  FigureScanResult,
  HelperDiagnostics,
} from "./figureTypes";

type PythonCommand = {
  command: string;
  args: string[];
};

interface HelperNavigationPayload {
  strategy?: "bbox" | "caption";
  anchor?: "top" | "center" | "bottom";
  target_bbox_normalized?: number[];
  source?: string;
  reason?: string;
  confidence?: number;
  low_confidence?: boolean;
}

interface HelperEntryPayload {
  id?: string;
  type?: "figure" | "table";
  label?: string;
  caption?: string;
  page_index?: number;
  navigation?: HelperNavigationPayload;
}

interface HelperReportPayload {
  schema_version?: string;
  figures?: HelperEntryPayload[];
  tables?: HelperEntryPayload[];
  warnings?: string[];
}

interface HelperScanOptions {
  forceRefresh?: boolean;
}

const HELPER_SCHEMA_VERSION = "zotero-fig-helper/v1";
const HELPER_ASSET_URL = `chrome://${config.addonRef}/content/helper/pdf_probe.py`;

let helperScriptPathPromise: Promise<string> | undefined;
let pythonCommandPromise: Promise<PythonCommand | null> | undefined;
const helperResultCache = new Map<string, Promise<FigureScanResult>>();

export async function scanPDFWithHelper(
  item: Zotero.Item,
  options: HelperScanOptions = {},
): Promise<FigureScanResult> {
  if (!item.isPDFAttachment()) {
    return createEmptyHelperResult("not_pdf", "Current item is not a PDF.");
  }

  const pdfPath = await item.getFilePathAsync();
  if (!pdfPath) {
    return createEmptyHelperResult(
      "no_pdf_path",
      "Could not resolve PDF file path.",
    );
  }

  const cacheKey = await getHelperCacheKey(item, pdfPath);
  if (cacheKey && options.forceRefresh) {
    helperResultCache.delete(cacheKey);
  }

  if (cacheKey && !options.forceRefresh) {
    const cachedResult = helperResultCache.get(cacheKey);
    if (cachedResult) {
      return cloneFigureScanResult(await cachedResult);
    }
  }

  const scanPromise = runHelperScan(item, pdfPath);
  if (cacheKey) {
    helperResultCache.set(
      cacheKey,
      scanPromise.catch((error) => {
        helperResultCache.delete(cacheKey);
        throw error;
      }),
    );
  }

  return cloneFigureScanResult(await scanPromise);
}

async function runHelperScan(
  item: Zotero.Item,
  pdfPath: string,
): Promise<FigureScanResult> {
  const pythonCommands = await getPythonCommands();
  if (pythonCommands.length === 0) {
    return createEmptyHelperResult(
      "no_python",
      "No usable Python interpreter found.",
    );
  }

  const helperScriptPath = await ensureHelperScriptPath();
  for (const pythonCommand of pythonCommands) {
    try {
      const result = await runHelperWithCommand(
        pythonCommand,
        helperScriptPath,
        pdfPath,
        item,
      );
      pythonCommandPromise = Promise.resolve(pythonCommand);
      const matchedFigureCount = result.entries.filter(
        (entry) =>
          entry.type === "figure" && entry.navigation?.strategy === "bbox",
      ).length;
      const helperFigureCount = result.entries.filter(
        (entry) => entry.type === "figure",
      ).length;
      result.helperDiagnostics = {
        status: "succeeded",
        message: `Helper succeeded: ${matchedFigureCount}/${helperFigureCount} figures matched to bbox.`,
        matchedFigureCount,
        helperFigureCount,
        selectedCommand: formatCommand(pythonCommand),
      };
      return result;
    } catch (error) {
      const detail = getErrorMessage(error);
      ztoolkit.log("PyMuPDF helper candidate failed", {
        command: pythonCommand.command,
        args: pythonCommand.args,
        detail,
      });
    }
  }

  return {
    entries: [],
    warnings: [],
    helperDiagnostics: {
      status: "failed",
      message: "Helper failed for all discovered Python interpreters.",
    },
  };
}

async function ensureHelperScriptPath() {
  helperScriptPathPromise ??= (async () => {
    const addonDir = PathUtils.join(PathUtils.profileDir, config.addonRef);
    const helperDir = PathUtils.join(addonDir, "helper");
    await Zotero.File.createDirectoryIfMissingAsync(addonDir);
    await Zotero.File.createDirectoryIfMissingAsync(helperDir);

    const helperScriptPath = PathUtils.join(helperDir, "pdf_probe.py");
    const helperScript =
      await Zotero.File.getContentsFromURLAsync(HELPER_ASSET_URL);
    if (typeof helperScript !== "string" || !helperScript.trim()) {
      throw new Error("Failed to load bundled PDF helper script.");
    }

    await Zotero.File.putContentsAsync(helperScriptPath, helperScript);
    return helperScriptPath;
  })();

  return helperScriptPathPromise;
}

async function runHelperWithCommand(
  pythonCommand: PythonCommand,
  helperScriptPath: string,
  pdfPath: string,
  item: Zotero.Item,
): Promise<FigureScanResult> {
  const outputPath = await createHelperOutputPath(item);
  try {
    const args = [
      ...pythonCommand.args,
      helperScriptPath,
      pdfPath,
      "--out",
      outputPath,
      "--attachment-key",
      item.key,
      "--document-id",
      String(item.id),
    ];
    const process = (Components.classes as _ZoteroTypes.anyObj)[
      "@mozilla.org/process/util;1"
    ].createInstance(Components.interfaces.nsIProcess) as nsIProcess;
    process.init(Zotero.File.pathToFile(pythonCommand.command));
    process.startHidden = true;
    process.noShell = true;
    await runProcessAsync(process, args);

    if (process.exitValue !== 0) {
      throw new Error(
        `PDF helper exited with code ${process.exitValue}: ${pythonCommand.command}`,
      );
    }

    ztoolkit.log("PyMuPDF helper finished", {
      command: pythonCommand.command,
      args,
      outputPath,
    });

    const raw = await Zotero.File.getContentsAsync(outputPath);
    if (typeof raw !== "string" || !raw.trim()) {
      throw new Error("PDF helper produced no JSON output.");
    }

    const report = JSON.parse(raw) as HelperReportPayload;
    if (report.schema_version !== HELPER_SCHEMA_VERSION) {
      throw new Error(`Unexpected helper schema: ${report.schema_version}`);
    }

    return mapHelperReport(report);
  } finally {
    await Zotero.File.removeIfExists(outputPath);
  }
}

async function getPythonCommands() {
  pythonCommandPromise ??= findPythonCommand();
  const preferred = await pythonCommandPromise;
  const discovered = await findPythonCommands();
  const ordered = preferred ? [preferred, ...discovered] : discovered;
  return dedupePythonCommands(ordered);
}

async function findPythonCommand(): Promise<PythonCommand | null> {
  const commands = await findPythonCommands();
  return commands[0] ?? null;
}

async function findPythonCommands(): Promise<PythonCommand[]> {
  const foundCommands: PythonCommand[] = [];
  const envCandidates = [
    Services.env.get("ZOTEROFIG_PYTHON"),
    Services.env.get("PYTHON"),
    Services.env.get("PYTHON3"),
  ]
    .map((value) => value?.trim())
    .filter(Boolean) as string[];

  for (const candidate of envCandidates) {
    const command = await resolvePythonCommand(candidate);
    if (command) {
      foundCommands.push(command);
    }
  }

  const isWindows = Services.appinfo.OS === "WINNT";
  const commandNames = isWindows
    ? [
        { executable: "python.exe", args: [] },
        { executable: "python3.exe", args: [] },
        { executable: "py.exe", args: ["-3"] },
      ]
    : [
        { executable: "python3", args: [] },
        { executable: "python", args: [] },
      ];

  const searchPaths = getExecutableSearchPaths();
  for (const searchPath of searchPaths) {
    for (const candidate of commandNames) {
      const absolutePath = PathUtils.join(searchPath, candidate.executable);
      if (await IOUtils.exists(absolutePath)) {
        foundCommands.push({
          command: absolutePath,
          args: [...candidate.args],
        });
      }
    }
  }

  return dedupePythonCommands(foundCommands);
}

async function resolvePythonCommand(candidate: string) {
  if (!candidate) {
    return null;
  }

  if (await IOUtils.exists(candidate)) {
    return {
      command: candidate,
      args: [],
    };
  }

  const searchPaths = getExecutableSearchPaths();
  for (const searchPath of searchPaths) {
    for (const resolvedPath of getExecutableCandidates(searchPath, candidate)) {
      if (await IOUtils.exists(resolvedPath)) {
        return {
          command: resolvedPath,
          args: [],
        };
      }
    }
  }

  return null;
}

function getExecutableSearchPaths() {
  const separator = Services.appinfo.OS === "WINNT" ? ";" : ":";
  return (Services.env.get("PATH") || "")
    .split(separator)
    .map((path) => path.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
}

function getExecutableCandidates(searchPath: string, executableName: string) {
  const candidates = [PathUtils.join(searchPath, executableName)];
  if (
    Services.appinfo.OS === "WINNT" &&
    !/\.(?:exe|cmd|bat)$/i.test(executableName)
  ) {
    candidates.push(PathUtils.join(searchPath, `${executableName}.exe`));
  }

  return candidates;
}

function dedupePythonCommands(commands: PythonCommand[]) {
  const seen = new Set<string>();
  const deduped: PythonCommand[] = [];
  for (const command of commands) {
    const key = `${command.command}\u0000${command.args.join("\u0000")}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(command);
  }

  return deduped;
}

async function createHelperOutputPath(item: Zotero.Item) {
  const outputDir = PathUtils.join(PathUtils.tempDir, config.addonRef);
  await Zotero.File.createDirectoryIfMissingAsync(outputDir);
  return PathUtils.join(
    outputDir,
    `pdf-helper-${item.id}-${Zotero.Utilities.randomString(8)}.json`,
  );
}

async function runProcessAsync(process: nsIProcess, args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const observer = {
      observe(_subject: unknown, topic: string) {
        if (topic === "process-finished") {
          resolve();
          return;
        }

        reject(new Error(`Process ended with topic: ${topic}`));
      },
    };

    if (Services.appinfo.OS === "WINNT") {
      process.runwAsync(args, args.length, observer as nsIObserver, false);
    } else {
      process.runAsync(args, args.length, observer as nsIObserver, false);
    }
  });
}

function mapHelperReport(report: HelperReportPayload): FigureScanResult {
  const figureEntries = (report.figures || [])
    .map(mapHelperEntry)
    .filter(Boolean) as FigureEntry[];
  const tableEntries = (report.tables || [])
    .map(mapHelperEntry)
    .filter(Boolean) as FigureEntry[];

  return {
    entries: [...figureEntries, ...tableEntries].sort(compareHelperEntries),
    warnings: (report.warnings || []).filter(Boolean),
  };
}

function createEmptyHelperResult(
  status: HelperDiagnostics["status"],
  message: string,
): FigureScanResult {
  return {
    entries: [],
    warnings: [],
    helperDiagnostics: {
      status,
      message,
    },
  };
}

async function getHelperCacheKey(item: Zotero.Item, pdfPath: string) {
  try {
    const stat = await IOUtils.stat(pdfPath);
    return [item.id, pdfPath, stat.lastModified ?? 0, stat.size ?? 0].join("|");
  } catch (error) {
    ztoolkit.log("Failed to build helper cache key", {
      itemID: item.id,
      pdfPath,
      error: getErrorMessage(error),
    });
    return undefined;
  }
}

function cloneFigureScanResult(result: FigureScanResult): FigureScanResult {
  return {
    entries: result.entries.map((entry) => ({
      ...entry,
      navigation: entry.navigation
        ? {
            ...entry.navigation,
            targetBBoxNormalized: entry.navigation.targetBBoxNormalized
              ? [...entry.navigation.targetBBoxNormalized]
              : undefined,
          }
        : undefined,
    })),
    warnings: [...result.warnings],
    helperDiagnostics: result.helperDiagnostics
      ? { ...result.helperDiagnostics }
      : undefined,
  };
}

function mapHelperEntry(payload: HelperEntryPayload): FigureEntry | null {
  if (
    !payload.id ||
    !payload.type ||
    !payload.label ||
    typeof payload.page_index !== "number"
  ) {
    return null;
  }

  return {
    id: payload.id,
    type: payload.type,
    label: payload.label,
    caption: payload.caption || payload.label,
    pageIndex: payload.page_index,
    navigation: mapHelperNavigation(payload.navigation),
  };
}

function mapHelperNavigation(payload?: HelperNavigationPayload) {
  if (!payload) {
    return undefined;
  }

  const normalizedBBox = normalizeBBox(payload.target_bbox_normalized);
  return {
    strategy: payload.strategy || "caption",
    anchor: payload.anchor || "top",
    targetBBoxNormalized: normalizedBBox,
    source: payload.source,
    reason: payload.reason,
    confidence: payload.confidence,
    lowConfidence: payload.low_confidence,
  } as FigureEntry["navigation"];
}

function normalizeBBox(value?: number[]) {
  if (!value || value.length !== 4) {
    return undefined;
  }

  const bbox = value.map((part) => clamp(Number(part), 0, 1));
  if (bbox.some((part) => !Number.isFinite(part))) {
    return undefined;
  }

  return bbox as [number, number, number, number];
}

function compareHelperEntries(a: FigureEntry, b: FigureEntry) {
  if (a.pageIndex !== b.pageIndex) {
    return a.pageIndex - b.pageIndex;
  }
  if (a.type !== b.type) {
    return a.type.localeCompare(b.type);
  }
  return a.label.localeCompare(b.label);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function formatCommand(command: PythonCommand) {
  const parts = [command.command, ...command.args].filter(Boolean);
  return parts.join(" ");
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
