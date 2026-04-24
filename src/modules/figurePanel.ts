import { getLocaleID, getString } from "../utils/locale";
import { scanPDFWithHelper } from "./pdfHelper";
import type {
  FigureEntry,
  FigureEntryType,
  FigureScanResult,
  HelperDiagnostics,
} from "./figureTypes";

interface ParsedCaptionLabel {
  key: string;
  baseKey: string;
  type: FigureEntryType;
  rootNumber: string;
  suffix: string;
  sequenceNumber?: number;
}

interface PDFTextItem {
  str?: string;
  transform?: number[];
}

interface CaptionLine {
  text: string;
  targetTopRatio?: number;
}

type PDFViewerApplication = _ZoteroTypes.Reader.PDFViewerApplication;
type PDFViewerContext = {
  app: PDFViewerApplication;
  doc?: Document;
};

interface FigurePanelRenderProps {
  body: HTMLDivElement;
  item: Zotero.Item;
  setSectionSummary(summary: string): string;
}

const PANE_ID = "zoterofig-reader-figures";
const MAX_CAPTION_LENGTH = 220;
const CJK_NUMERAL_CHARS = "零〇一二两三四五六七八九十百千万";
const CJK_NUMBER_PATTERN = `[0-9０-９${CJK_NUMERAL_CHARS}]+`;

let registered = false;

export function registerReaderFigurePanel() {
  if (registered) {
    return;
  }

  const result = Zotero.ItemPaneManager.registerSection({
    paneID: PANE_ID,
    pluginID: addon.data.config.addonID,
    header: {
      l10nID: getLocaleID("reader-figures-head-text"),
      icon: "chrome://zotero/skin/16/universal/book.svg",
    },
    sidenav: {
      l10nID: getLocaleID("reader-figures-sidenav-tooltip"),
      icon: "chrome://zotero/skin/20/universal/save.svg",
    },
    onItemChange: ({ tabType, setEnabled }) => {
      setEnabled(tabType === "reader");
    },
    onRender: (props) => {
      renderStatus(props.body, getString("reader-figures-loading"));
      props.setSectionSummary("...");
    },
    onAsyncRender: async (props) => {
      await scanAndRender(props);
    },
    sectionButtons: [
      {
        type: "refresh",
        icon: "chrome://zotero/skin/16/universal/book.svg",
        l10nID: getLocaleID("reader-figures-refresh-button-tooltip"),
        onClick: (props) => {
          void scanAndRenderInternal(props, true);
        },
      },
    ],
  });

  registered = result !== false;
}

export function unregisterReaderFigurePanel() {
  if (!registered) {
    return;
  }

  Zotero.ItemPaneManager.unregisterSection(PANE_ID);
  registered = false;
}

async function scanAndRender(props: FigurePanelRenderProps) {
  await scanAndRenderInternal(props, false);
}

async function scanAndRenderInternal(
  props: FigurePanelRenderProps,
  forceRefresh: boolean,
) {
  renderStatus(props.body, getString("reader-figures-loading"));
  props.setSectionSummary("...");

  try {
    const result = await scanPDFCaptions(
      props.item,
      forceRefresh,
      (pageNumber, pageCount) => {
        if (!shouldRenderScanProgress(pageNumber, pageCount)) {
          return;
        }

        renderStatus(
          props.body,
          `${getString("reader-figures-loading")} ${pageNumber}/${pageCount}`,
        );
      },
    );
    props.setSectionSummary(`${result.entries.length}`);
    renderFigureList(props.body, props.item, result);
  } catch (error) {
    ztoolkit.log("Failed to scan PDF captions", error);
    props.setSectionSummary("0");
    renderStatus(
      props.body,
      `${getString("reader-figures-error")} ${getErrorMessage(error)}`,
    );
  }
}

function shouldRenderScanProgress(pageNumber: number, pageCount: number) {
  return pageNumber === 1 || pageNumber === pageCount || pageNumber % 5 === 0;
}

async function scanPDFCaptions(
  item: Zotero.Item,
  forceRefresh: boolean,
  onProgress: (pageNumber: number, pageCount: number) => void,
): Promise<FigureScanResult> {
  const reader = await getReaderForItem(item);
  const pdfItem = getPDFItemForReader(item, reader);
  const [legacyResult, helperResult] = await Promise.all([
    scanPDFCaptionsLegacy(item, onProgress),
    scanPDFWithHelper(pdfItem, { forceRefresh }),
  ]);

  return mergeFigureScanResults(legacyResult, helperResult);
}

async function scanPDFCaptionsLegacy(
  item: Zotero.Item,
  onProgress: (pageNumber: number, pageCount: number) => void,
): Promise<FigureScanResult> {
  const reader = await getReaderForItem(item);
  if (!reader || reader.type !== "pdf") {
    return { entries: [], warnings: [] };
  }

  const pdfContext = await getPDFViewerContext(reader);
  if (!pdfContext?.app) {
    throw new Error("PDF viewer is not ready.");
  }

  const entries: FigureEntry[] = [];
  const seen = new Set<string>();
  const pageCount = getPDFPageCount(pdfContext);

  if (pageCount === 0) {
    return { entries: [], warnings: [] };
  }

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
    onProgress(pageNumber, pageCount);

    const lines = await getLinesForPage(pdfContext, pageNumber);
    collectCaptionEntries(lines, pageNumber - 1, entries, seen);
  }

  return refineCaptionEntries(entries);
}

function mergeFigureScanResults(
  legacyResult: FigureScanResult,
  helperResult: FigureScanResult,
): FigureScanResult {
  if (helperResult.entries.length === 0) {
    return {
      ...legacyResult,
      helperDiagnostics: helperResult.helperDiagnostics,
    };
  }

  const helperEntriesByKey = new Map(
    helperResult.entries.map((entry) => [getFigureMergeKey(entry), entry]),
  );
  const mergedEntries = legacyResult.entries.map((entry) => {
    if (entry.type !== "figure") {
      return entry;
    }

    const helperEntry = helperEntriesByKey.get(getFigureMergeKey(entry));
    if (!helperEntry?.navigation) {
      return entry;
    }

    return {
      ...entry,
      pageIndex: helperEntry.pageIndex,
      navigation: helperEntry.navigation,
    };
  });

  for (const helperEntry of helperResult.entries) {
    if (helperEntry.type !== "figure") {
      continue;
    }

    const key = getFigureMergeKey(helperEntry);
    const hasLegacyEntry = mergedEntries.some(
      (entry) => getFigureMergeKey(entry) === key,
    );
    if (!hasLegacyEntry) {
      mergedEntries.push(helperEntry);
    }
  }

  mergedEntries.sort(compareEntries);
  return {
    entries: mergedEntries,
    warnings: Array.from(
      new Set([
        ...(legacyResult.warnings || []),
        ...(helperResult.warnings || []),
      ]),
    ),
    helperDiagnostics: helperResult.helperDiagnostics,
  };
}

function getFigureMergeKey(entry: FigureEntry) {
  return `${entry.type}:${getCaptionEntryKey(entry)}`;
}

function getPDFItemForReader(
  item: Zotero.Item,
  reader: _ZoteroTypes.ReaderInstance | undefined,
) {
  if (item.isPDFAttachment()) {
    return item;
  }

  const readerItem = reader?._item;
  if (readerItem?.isPDFAttachment()) {
    return readerItem;
  }

  return item;
}

function getPDFPageCount(context: PDFViewerContext) {
  const domPageCount = getRenderedPageElements(context).reduce(
    (maxPageNumber, pageElement) => {
      const pageNumber = Number(pageElement.dataset.pageNumber);
      return Number.isFinite(pageNumber)
        ? Math.max(maxPageNumber, pageNumber)
        : maxPageNumber;
    },
    0,
  );

  return (
    context.app.pagesCount ||
    context.app.pdfDocument?.numPages ||
    context.app.pdfViewer?.pagesCount ||
    domPageCount
  );
}

async function getLinesForPage(context: PDFViewerContext, pageNumber: number) {
  const existingLines = getPageTextLinesFromDOMContext(context, pageNumber);
  if (existingLines.length > 0) {
    return existingLines;
  }

  const pageViewLines = await getPageTextLinesFromPageView(context, pageNumber);
  if (pageViewLines.length > 0) {
    return pageViewLines;
  }

  const fallbackLines = await getPageTextLinesFromPDFDocument(
    context.app,
    pageNumber,
  );
  if (fallbackLines.length > 0) {
    return fallbackLines;
  }

  return [];
}

async function getPageTextLinesFromPageView(
  context: PDFViewerContext,
  pageNumber: number,
) {
  const pageView = getPDFPageView(context, pageNumber);
  const pageElement = getHTMLElement(pageView?.div);
  if (pageElement) {
    const lines = getPageTextLinesFromDOM(pageElement);
    if (lines.length > 0) {
      return lines;
    }
  }

  const textLayerElement = getHTMLElement(
    pageView?.textLayer?.div ?? pageView?.textLayer?.textLayerDiv,
  );
  if (textLayerElement) {
    const lines = getPageTextLinesFromTextLayer(textLayerElement);
    if (lines.length > 0) {
      return lines;
    }
  }

  const pdfPage = pageView?.pdfPage;
  if (canReadPDFPageText(pdfPage)) {
    return getPageTextLines(pdfPage);
  }

  return [];
}

async function getPageTextLinesFromPDFDocument(
  pdfApplication: PDFViewerApplication,
  pageNumber: number,
) {
  const page = await pdfApplication.pdfDocument?.getPage(pageNumber);
  if (!canReadPDFPageText(page)) {
    return [];
  }

  return getPageTextLines(page);
}

function getPDFPageView(
  context: PDFViewerContext,
  pageNumber: number,
): _ZoteroTypes.anyObj | undefined {
  const pdfViewer = context.app.pdfViewer as _ZoteroTypes.anyObj | undefined;
  const pageIndex = pageNumber - 1;

  return pdfViewer?.getPageView?.(pageIndex) ?? pdfViewer?._pages?.[pageIndex];
}

function getPageTextLinesFromDOMContext(
  context: PDFViewerContext,
  pageNumber: number,
) {
  const pageElement = getRenderedPageElements(context).find((element) => {
    return Number(element.dataset.pageNumber) === pageNumber;
  });

  return pageElement ? getPageTextLinesFromDOM(pageElement) : [];
}

function collectCaptionEntries(
  lines: CaptionLine[],
  pageIndex: number,
  entries: FigureEntry[],
  seen: Set<string>,
) {
  for (const line of lines) {
    if (!mayContainCaptionStart(line.text)) {
      continue;
    }

    const detected = detectCaptionsInLine(line, pageIndex);
    for (const entry of detected) {
      const key = `${entry.type}:${entry.label}:${entry.pageIndex}`;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      entries.push(entry);
    }
  }
}

function mayContainCaptionStart(text: string) {
  return /^(?:Figure|Fig\.?|Table)\b|^[图表]\s*/i.test(normalizeText(text));
}

async function getPDFViewerContext(
  reader: _ZoteroTypes.ReaderInstance,
): Promise<PDFViewerContext | undefined> {
  await reader._initPromise;
  await reader._waitForReader();

  const pdfReader = reader as _ZoteroTypes.ReaderInstance<"pdf"> &
    _ZoteroTypes.anyObj;
  const context = await waitForPDFViewerContext(pdfReader);
  await context?.app.initializedPromise;

  return context;
}

async function waitForPDFViewerContext(
  reader: _ZoteroTypes.ReaderInstance<"pdf"> & _ZoteroTypes.anyObj,
) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const context = getPDFViewerContextCandidate(reader);
    if (context?.app) {
      return context;
    }

    await Zotero.Promise.delay(100);
  }

  return getPDFViewerContextCandidate(reader);
}

function getPDFViewerContextCandidate(
  reader: _ZoteroTypes.ReaderInstance<"pdf"> & _ZoteroTypes.anyObj,
): PDFViewerContext | undefined {
  const views = [
    reader._lastView,
    reader._primaryView,
    reader._internalReader?._lastView,
    reader._internalReader?._primaryView,
  ];

  for (const view of views) {
    const context = getPDFViewerContextFromView(view);
    if (context) {
      return context;
    }
  }

  return undefined;
}

function getPDFViewerContextFromView(
  view: _ZoteroTypes.anyObj | undefined,
): PDFViewerContext | undefined {
  if (!view) {
    return undefined;
  }

  const iframeWindow =
    view._iframeWindow ?? view._iframe?.contentWindow ?? undefined;
  const app =
    iframeWindow?.PDFViewerApplication ??
    iframeWindow?.wrappedJSObject?.PDFViewerApplication;

  if (!app) {
    return undefined;
  }

  return {
    app,
    doc: iframeWindow?.document,
  };
}

function getRenderedPageElements(context: PDFViewerContext) {
  const pageElementsFromDOM = Array.from(
    context.doc?.querySelectorAll<HTMLElement>(".page[data-page-number]") ?? [],
  ) as HTMLElement[];
  if (pageElementsFromDOM.length > 0) {
    return pageElementsFromDOM;
  }

  const pageElementsFromViewer = Array.from(
    context.app.pdfViewer?.container?.querySelectorAll<HTMLElement>(
      ".page[data-page-number]",
    ) ?? [],
  ) as HTMLElement[];

  return pageElementsFromViewer;
}

function getPageTextLinesFromDOM(pageElement: HTMLElement): CaptionLine[] {
  const textLayer = pageElement.querySelector<HTMLElement>(".textLayer");
  if (!textLayer) {
    return [];
  }

  const spans = Array.from(
    textLayer.querySelectorAll<HTMLElement>("span"),
  ) as HTMLElement[];
  if (spans.length === 0) {
    return splitTextIntoLines(textLayer.innerText || textLayer.textContent);
  }

  return getPageTextLinesFromTextLayer(textLayer, pageElement);
}

function getPageTextLinesFromTextLayer(
  textLayer: HTMLElement,
  pageElement?: HTMLElement,
): CaptionLine[] {
  const spans = Array.from(
    textLayer.querySelectorAll<HTMLElement>("span"),
  ) as HTMLElement[];
  if (spans.length === 0) {
    return splitTextIntoLines(textLayer.innerText || textLayer.textContent);
  }

  const pageRect = pageElement?.getBoundingClientRect();
  const lines: Array<{ y: number; topRatio?: number; parts: string[] }> = [];
  for (const span of spans) {
    const text = normalizeText(span.textContent ?? "");
    if (!text) {
      continue;
    }

    const spanRect = span.getBoundingClientRect();
    const y = Math.round(spanRect.top / 3) * 3;
    const topRatio =
      pageRect && pageRect.height > 0
        ? clamp((spanRect.top - pageRect.top) / pageRect.height, 0, 1)
        : undefined;
    const lastLine = lines.at(-1);
    if (lastLine && Math.abs(lastLine.y - y) <= 3) {
      lastLine.parts.push(text);
      if (typeof topRatio === "number") {
        lastLine.topRatio =
          typeof lastLine.topRatio === "number"
            ? Math.min(lastLine.topRatio, topRatio)
            : topRatio;
      }
    } else {
      lines.push({ y, topRatio, parts: [text] });
    }
  }

  return lines
    .map((line) => ({
      text: normalizeText(joinPDFTextParts(line.parts)),
      targetTopRatio: line.topRatio,
    }))
    .filter((line) => Boolean(line.text));
}

function getHTMLElement(value: unknown): HTMLElement | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const node = value as Partial<HTMLElement>;
  return node.nodeType === 1 && typeof node.querySelector === "function"
    ? (node as HTMLElement)
    : undefined;
}

async function getPageTextLines(
  page: _ZoteroTypes.Reader.PDFPageProxy,
): Promise<CaptionLine[]> {
  const textContent = await page.getTextContent();
  const items = textContent.items as PDFTextItem[];
  const lines: Array<{ y: number | null; parts: string[] }> = [];

  for (const item of items) {
    const text = normalizeText(item.str ?? "");
    if (!text) {
      continue;
    }

    const y = getTextItemY(item);
    const lastLine = lines.at(-1);
    if (lastLine && shouldAppendToLine(lastLine.y, y)) {
      lastLine.parts.push(text);
    } else {
      lines.push({ y, parts: [text] });
    }
  }

  return lines
    .map((line) => ({ text: normalizeText(joinPDFTextParts(line.parts)) }))
    .filter((line) => Boolean(line.text));
}

function canReadPDFPageText(
  page: unknown,
): page is _ZoteroTypes.Reader.PDFPageProxy {
  return (
    typeof (page as { getTextContent?: unknown }).getTextContent === "function"
  );
}

function getTextItemY(item: PDFTextItem): number | null {
  const y = item.transform?.[5];
  return typeof y === "number" ? Math.round(y / 3) * 3 : null;
}

function shouldAppendToLine(previousY: number | null, currentY: number | null) {
  if (previousY === null || currentY === null) {
    return true;
  }

  return Math.abs(previousY - currentY) <= 3;
}

function detectCaptionsInLine(
  line: CaptionLine,
  pageIndex: number,
): FigureEntry[] {
  const normalizedLine = normalizeText(line.text);
  const englishCaption =
    /^(Figure|Fig\.?|Table)\s*([A-Za-z]?\d+(?:[.-]\d+)?[A-Za-z]?)(?:\s*([-:.–—])\s*|\s+)(.*)$/i;
  const cjkCaption = new RegExp(
    `^([图表])\\s*(${CJK_NUMBER_PATTERN}(?:[.－．-]${CJK_NUMBER_PATTERN})?)(?:\\s*([-:：.–—])\\s*|\\s+)?(.*)$`,
  );

  const englishMatch = normalizedLine.match(englishCaption);
  if (englishMatch) {
    const separator = englishMatch[3];
    const caption = englishMatch[4] || normalizedLine;
    if (!separator && looksLikeInlineFigureReference(caption)) {
      return [];
    }

    const marker = englishMatch[1].toLowerCase();
    const type: FigureEntryType = marker.startsWith("tab") ? "table" : "figure";
    const label = `${type === "figure" ? "Figure" : "Table"} ${
      englishMatch[2]
    }`;

    return [
      createFigureEntry({
        type,
        label,
        caption,
        pageIndex,
        targetTopRatio: line.targetTopRatio,
      }),
    ];
  }

  const cjkMatch = normalizedLine.match(cjkCaption);
  if (cjkMatch) {
    const type: FigureEntryType = cjkMatch[1] === "表" ? "table" : "figure";
    const caption = cjkMatch[4] || normalizedLine;
    if (!cjkMatch[3] && looksLikeInlineCJKFigureReference(caption)) {
      return [];
    }

    const labelNumber = normalizeCJKNumberToken(cjkMatch[2]);
    const label = `${cjkMatch[1]}${labelNumber}`;

    return [
      createFigureEntry({
        type,
        label,
        caption,
        pageIndex,
        targetTopRatio: line.targetTopRatio,
      }),
    ];
  }

  return [];
}

function looksLikeInlineFigureReference(text: string) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return false;
  }

  if (/^[a-z]/.test(normalized)) {
    return true;
  }

  return /^(shows?|showed|shown|demonstrates?|demonstrated|illustrates?|illustrated|indicates?|indicated|presents?|presented|depicts?|depicted|contains?|contained|summari[sz]es|compares?|compared|reports?|reported|and|or|above|below|left|right)\b/i.test(
    normalized,
  );
}

function looksLikeInlineCJKFigureReference(text: string) {
  const normalized = normalizeText(text).replace(/\s+/g, "");
  if (!normalized) {
    return false;
  }

  return /^(所示|所列|中|中的|为|是|显示|表明|说明|可见|给出|列出|展示|比较|总结|和|与|及)/.test(
    normalized,
  );
}

function refineCaptionEntries(entries: FigureEntry[]): FigureScanResult {
  const dedupedByLabel = new Map<string, FigureEntry>();

  for (const entry of entries) {
    const parsedLabel = parseCaptionLabel(entry);
    const key = parsedLabel?.key ?? normalizeText(entry.label).toLowerCase();
    const existing = dedupedByLabel.get(key);

    if (
      !existing ||
      scoreCaptionCandidate(entry) > scoreCaptionCandidate(existing)
    ) {
      dedupedByLabel.set(key, entry);
    }
  }

  const dedupedEntries = Array.from(dedupedByLabel.values());
  const parsedLabels = new Map<FigureEntry, ParsedCaptionLabel>();
  const baseKeys = new Set<string>();

  for (const entry of dedupedEntries) {
    const parsedLabel = parseCaptionLabel(entry);
    if (!parsedLabel) {
      continue;
    }

    parsedLabels.set(entry, parsedLabel);
    if (!parsedLabel.suffix) {
      baseKeys.add(parsedLabel.baseKey);
    }
  }

  const filteredEntries = dedupedEntries
    .filter((entry) => {
      const parsedLabel = parsedLabels.get(entry);
      return !parsedLabel?.suffix || !baseKeys.has(parsedLabel.baseKey);
    })
    .sort(compareEntries);

  return {
    entries: filteredEntries,
    warnings: getSequenceWarnings(filteredEntries),
  };
}

function parseCaptionLabel(entry: FigureEntry): ParsedCaptionLabel | undefined {
  const label = normalizeText(entry.label);
  const englishLabel = label.match(
    /^(Figure|Table)\s+([A-Za-z]*)(\d+(?:[.-]\d+)?)([A-Za-z]?)$/i,
  );
  if (englishLabel) {
    const [, marker, prefix, numberPart, suffix] = englishLabel;
    const type: FigureEntryType = marker.toLowerCase().startsWith("tab")
      ? "table"
      : "figure";
    const rootNumber = `${prefix.toUpperCase()}${numberPart}`;
    const sequenceNumber =
      prefix || numberPart.includes(".") || numberPart.includes("-")
        ? undefined
        : Number(numberPart);

    return createParsedCaptionLabel(type, rootNumber, suffix, sequenceNumber);
  }

  const cjkLabel = label.match(
    new RegExp(`^([图表])\\s*(${CJK_NUMBER_PATTERN})([A-Za-z]?)$`),
  );
  if (cjkLabel) {
    const type: FigureEntryType = cjkLabel[1] === "表" ? "table" : "figure";
    const rootNumber = normalizeCJKNumberToken(cjkLabel[2]);
    const sequenceNumber = parseCJKSequenceNumber(rootNumber);
    return createParsedCaptionLabel(
      type,
      sequenceNumber ? String(sequenceNumber) : rootNumber,
      cjkLabel[3],
      sequenceNumber,
    );
  }

  return undefined;
}

function createParsedCaptionLabel(
  type: FigureEntryType,
  rootNumber: string,
  suffix: string,
  sequenceNumber?: number,
): ParsedCaptionLabel {
  const normalizedRoot = rootNumber.toUpperCase();
  const normalizedSuffix = suffix.toUpperCase();
  const baseKey = `${type}:${normalizedRoot}`;

  return {
    key: `${baseKey}${normalizedSuffix}`,
    baseKey,
    type,
    rootNumber: normalizedRoot,
    suffix: normalizedSuffix,
    sequenceNumber,
  };
}

function scoreCaptionCandidate(entry: FigureEntry) {
  let score = Math.min(entry.caption.length, 200);

  if (normalizeText(entry.caption) !== normalizeText(entry.label)) {
    score += 25;
  }
  if (entry.caption.length < 8) {
    score -= 25;
  }
  if (looksLikeInlineFigureReference(entry.caption)) {
    score -= 80;
  }

  return score;
}

function compareEntries(a: FigureEntry, b: FigureEntry) {
  const parsedA = parseCaptionLabel(a);
  const parsedB = parseCaptionLabel(b);
  if (parsedA?.type !== parsedB?.type) {
    return a.type.localeCompare(b.type);
  }

  const sequenceA = parsedA?.sequenceNumber ?? Number.MAX_SAFE_INTEGER;
  const sequenceB = parsedB?.sequenceNumber ?? Number.MAX_SAFE_INTEGER;
  if (sequenceA !== sequenceB) {
    return sequenceA - sequenceB;
  }

  if (a.pageIndex !== b.pageIndex) {
    return a.pageIndex - b.pageIndex;
  }

  return a.label.localeCompare(b.label);
}

function getSequenceWarnings(entries: FigureEntry[]) {
  const warnings: string[] = [];
  for (const type of ["figure", "table"] as FigureEntryType[]) {
    const sequenceNumbers = new Set<number>();
    for (const entry of entries) {
      const parsedLabel = parseCaptionLabel(entry);
      if (
        parsedLabel?.type === type &&
        parsedLabel.sequenceNumber &&
        parsedLabel.sequenceNumber > 0
      ) {
        sequenceNumbers.add(parsedLabel.sequenceNumber);
      }
    }

    const orderedNumbers = Array.from(sequenceNumbers).sort((a, b) => a - b);
    if (orderedNumbers.length < 2) {
      continue;
    }

    const missingLabels = getMissingSequenceLabels(type, orderedNumbers);
    if (missingLabels.length > 0) {
      warnings.push(...missingLabels);
    }
  }

  return warnings.slice(0, 8);
}

function getMissingSequenceLabels(type: FigureEntryType, numbers: number[]) {
  const missingLabels: string[] = [];
  const available = new Set(numbers);
  const maxNumber = numbers.at(-1) ?? 0;
  const labelPrefix = type === "figure" ? "Figure" : "Table";

  for (let number = 1; number <= maxNumber; number++) {
    if (!available.has(number)) {
      missingLabels.push(`${labelPrefix} ${number}`);
    }
  }

  return missingLabels;
}

function normalizeDigits(value: string) {
  return value.replace(/[０-９]/g, (digit) =>
    String.fromCharCode(digit.charCodeAt(0) - 0xfee0),
  );
}

function normalizeCJKNumberToken(value: string) {
  return normalizeDigits(value)
    .replace(/\s+/g, "")
    .replace(/[．－]/g, ".");
}

function parseCJKSequenceNumber(value: string) {
  if (/^\d+$/.test(value)) {
    return Number(value);
  }

  if (value.includes(".") || value.includes("-")) {
    return undefined;
  }

  return parseChineseInteger(value);
}

function parseChineseInteger(value: string) {
  const digitMap: Record<string, number> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  const unitMap: Record<string, number> = {
    十: 10,
    百: 100,
    千: 1000,
    万: 10000,
  };

  if (!new RegExp(`^[${CJK_NUMERAL_CHARS}]+$`).test(value)) {
    return undefined;
  }

  if (![...value].some((char) => char in unitMap)) {
    const digits = [...value].map((char) => digitMap[char]);
    return digits.every((digit) => typeof digit === "number")
      ? Number(digits.join(""))
      : undefined;
  }

  let total = 0;
  let section = 0;
  let number = 0;
  for (const char of value) {
    if (char in digitMap) {
      number = digitMap[char];
      continue;
    }

    const unit = unitMap[char];
    if (!unit) {
      return undefined;
    }

    if (unit === 10000) {
      total += (section + number) * unit;
      section = 0;
    } else {
      section += (number || 1) * unit;
    }
    number = 0;
  }

  return total + section + number;
}

function createFigureEntry({
  type,
  label,
  caption,
  pageIndex,
  targetTopRatio,
}: Omit<FigureEntry, "id">): FigureEntry {
  const cleanCaption = trimCaption(caption);

  return {
    id: `${type}-${pageIndex}-${label}`,
    type,
    label,
    caption: cleanCaption || label,
    pageIndex,
    targetTopRatio,
  };
}

function trimCaption(caption: string) {
  const normalized = normalizeText(caption).replace(/^[-:：.–—\s]+/, "");
  if (normalized.length <= MAX_CAPTION_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_CAPTION_LENGTH - 3)}...`;
}

function normalizeText(text: string) {
  return fixCJKPDFSpacing(text.replace(/\s+/g, " ").trim());
}

function fixCJKPDFSpacing(text: string) {
  return text
    .replace(/([图表])\s+(?=[0-9０-９零〇一二两三四五六七八九十百千万])/g, "$1")
    .replace(/([0-9０-９])\s+(?=[0-9０-９])/g, "$1")
    .replace(
      /([零〇一二两三四五六七八九十百千万])\s+(?=[零〇一二两三四五六七八九十百千万])/g,
      "$1",
    )
    .replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, "$1");
}

function joinPDFTextParts(parts: string[]) {
  return parts.reduce((joinedText, part) => {
    const normalizedPart = normalizeText(part);
    if (!normalizedPart) {
      return joinedText;
    }

    if (!joinedText) {
      return normalizedPart;
    }

    return `${joinedText}${shouldJoinPDFTextParts(joinedText, normalizedPart) ? "" : " "}${normalizedPart}`;
  }, "");
}

function shouldJoinPDFTextParts(left: string, right: string) {
  const leftChar = left.at(-1) ?? "";
  const rightChar = right.at(0) ?? "";

  if (/^[图表]$/.test(leftChar) && isCJKLabelNumberChar(rightChar)) {
    return true;
  }
  if (isDigitChar(leftChar) && isDigitChar(rightChar)) {
    return true;
  }
  if (isChineseNumeralChar(leftChar) && isChineseNumeralChar(rightChar)) {
    return true;
  }
  if (isDigitChar(leftChar) && /^[A-Za-z]$/.test(right)) {
    return true;
  }

  return false;
}

function isCJKLabelNumberChar(char: string) {
  return isDigitChar(char) || isChineseNumeralChar(char);
}

function isDigitChar(char: string) {
  return /^[0-9０-９]$/.test(char);
}

function isChineseNumeralChar(char: string) {
  return new RegExp(`^[${CJK_NUMERAL_CHARS}]$`).test(char);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function splitTextIntoLines(text: string | null | undefined) {
  return (text ?? "")
    .split(/\r?\n/g)
    .map((line) => normalizeText(line))
    .filter(Boolean)
    .map((line) => ({ text: line }));
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function renderFigureList(
  body: HTMLDivElement,
  item: Zotero.Item,
  result: FigureScanResult,
) {
  body.replaceChildren();
  const doc = body.ownerDocument as Document;

  if (result.entries.length === 0) {
    if (shouldShowHelperNotice(result.helperDiagnostics)) {
      body.appendChild(createHelperNoticeBlock(doc, result.helperDiagnostics!));
    }

    const empty = doc.createElement("div");
    empty.textContent = getString("reader-figures-empty");
    Object.assign(empty.style, {
      color: "var(--fill-secondary)",
      fontSize: "12px",
      lineHeight: "1.45",
      padding: "10px 0 12px",
    });
    body.appendChild(empty);
    return;
  }

  if (shouldShowHelperNotice(result.helperDiagnostics)) {
    body.appendChild(createHelperNoticeBlock(doc, result.helperDiagnostics!));
  }
  if (result.warnings.length > 0) {
    body.appendChild(createWarningBlock(doc, result.warnings));
  }

  const container = doc.createElement("div");
  Object.assign(container.style, {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    overflow: "visible",
    padding: "10px 0 12px",
  });

  for (const entry of result.entries) {
    container.appendChild(createFigureCard(doc, entry, item));
  }

  body.appendChild(container);
}

function createWarningBlock(doc: Document, warnings: string[]) {
  const warning = doc.createElement("div");
  warning.textContent = getString("reader-figures-sequence-warning", {
    args: {
      labels: warnings.join(", "),
    },
  });
  Object.assign(warning.style, {
    background: "var(--material-background)",
    border: "1px solid var(--fill-quinary)",
    borderRadius: "6px",
    color: "var(--fill-secondary)",
    fontSize: "12px",
    lineHeight: "1.45",
    margin: "10px 0 0",
    padding: "8px",
  });

  return warning;
}

function shouldShowHelperNotice(diagnostics?: HelperDiagnostics) {
  if (!diagnostics) {
    return false;
  }

  if (diagnostics.status !== "succeeded") {
    return true;
  }

  const matched = diagnostics.matchedFigureCount ?? 0;
  const total = diagnostics.helperFigureCount ?? 0;
  return total === 0 || matched < total;
}

function createHelperNoticeBlock(
  doc: Document,
  diagnostics: HelperDiagnostics,
) {
  const block = doc.createElement("div");
  Object.assign(block.style, {
    background: "var(--material-background)",
    border: "1px solid var(--fill-quinary)",
    borderRadius: "6px",
    color: "var(--fill-secondary)",
    fontSize: "12px",
    lineHeight: "1.45",
    margin: "10px 0 0",
    padding: "8px",
  });
  block.textContent = getHelperNoticeText(diagnostics);

  return block;
}

function getHelperNoticeText(diagnostics: HelperDiagnostics) {
  if (
    diagnostics.status === "succeeded" &&
    typeof diagnostics.matchedFigureCount === "number" &&
    typeof diagnostics.helperFigureCount === "number"
  ) {
    return getString("reader-figures-helper-partial", {
      args: {
        matched: String(diagnostics.matchedFigureCount),
        total: String(diagnostics.helperFigureCount),
      },
    });
  }

  if (diagnostics.status === "no_python") {
    return getString("reader-figures-helper-no-python");
  }

  return getString("reader-figures-helper-fallback");
}

function renderStatus(body: HTMLDivElement, message: string) {
  body.replaceChildren();

  const doc = body.ownerDocument as Document;
  const status = doc.createElement("div");
  status.textContent = message;
  Object.assign(status.style, {
    color: "var(--fill-secondary)",
    fontSize: "12px",
    lineHeight: "1.45",
    padding: "10px 0 12px",
  });

  body.appendChild(status);
}

function createFigureCard(
  doc: Document,
  entry: FigureEntry,
  item: Zotero.Item,
) {
  const card = doc.createElement("div");
  card.setAttribute("role", "button");
  card.setAttribute("tabindex", "0");
  card.title = `Jump to ${entry.label}`;
  Object.assign(card.style, {
    background: "var(--material-background)",
    border: "1px solid var(--fill-quinary)",
    borderRadius: "6px",
    boxSizing: "border-box",
    color: "inherit",
    cursor: "pointer",
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    lineHeight: "1.35",
    minHeight: "86px",
    overflow: "visible",
    padding: "10px",
    textAlign: "left",
    whiteSpace: "normal",
    width: "100%",
  });

  const heading = doc.createElement("div");
  Object.assign(heading.style, {
    alignItems: "center",
    display: "flex",
    gap: "6px",
    justifyContent: "space-between",
    minHeight: "18px",
  });

  const label = doc.createElement("strong");
  label.textContent = entry.label;
  Object.assign(label.style, {
    overflowWrap: "anywhere",
  });

  const page = doc.createElement("span");
  page.textContent = `p. ${entry.pageIndex + 1}`;
  Object.assign(page.style, {
    color: "var(--fill-secondary)",
    fontSize: "12px",
  });

  const caption = doc.createElement("div");
  caption.textContent = entry.caption;
  Object.assign(caption.style, {
    color: "var(--fill-secondary)",
    display: "block",
    fontSize: "12px",
    lineHeight: "1.45",
    overflow: "visible",
    overflowWrap: "anywhere",
    whiteSpace: "normal",
  });

  const badge = doc.createElement("span");
  badge.textContent = entry.type === "figure" ? "Figure" : "Table";
  Object.assign(badge.style, {
    border: "1px solid var(--fill-quinary)",
    borderRadius: "4px",
    fontSize: "11px",
    padding: "1px 4px",
    width: "fit-content",
  });

  const badges = doc.createElement("div");
  Object.assign(badges.style, {
    display: "flex",
    flexWrap: "wrap",
    gap: "6px",
  });
  badges.appendChild(badge);

  heading.append(label, page);
  card.append(heading, caption, badges);
  card.addEventListener("click", () => {
    void navigateToFigure(entry, item);
  });
  card.addEventListener("keydown", (event) => {
    const keyboardEvent = event as KeyboardEvent;
    if (keyboardEvent.key !== "Enter" && keyboardEvent.key !== " ") {
      return;
    }

    keyboardEvent.preventDefault();
    void navigateToFigure(entry, item);
  });

  return card;
}

async function navigateToFigure(entry: FigureEntry, item: Zotero.Item) {
  const reader = await getReaderForItem(item);
  if (!reader) {
    ztoolkit.log("No active reader found for figure navigation", entry);
    return;
  }

  await reader.navigate({ pageIndex: entry.pageIndex });
  await scrollToFigureTarget(reader, entry);
}

async function getReaderForItem(item: Zotero.Item) {
  const matchingReader = Zotero.Reader._readers.find((reader) => {
    return reader.itemID === item.id || reader._item?.id === item.id;
  });

  if (matchingReader) {
    return matchingReader;
  }

  return ztoolkit.Reader.getReader(500);
}

async function scrollToFigureTarget(
  reader: _ZoteroTypes.ReaderInstance,
  entry: FigureEntry,
) {
  if (reader.type !== "pdf") {
    return;
  }

  const context = await getPDFViewerContext(reader);
  if (!context) {
    return;
  }

  const pageElement = await waitForRenderedPageElement(
    context,
    entry.pageIndex + 1,
  );
  const scrollContainer = getPDFScrollContainer(context);
  if (!pageElement || !scrollContainer) {
    return;
  }

  const helperTargetRatio = getHelperTargetTopRatio(entry);
  if (typeof helperTargetRatio === "number") {
    scrollToPageRatio(scrollContainer, pageElement, helperTargetRatio, entry);
    return;
  }

  const targetTopRatio =
    (await waitForCaptionTargetTopRatio(pageElement, entry)) ??
    entry.targetTopRatio;
  if (typeof targetTopRatio !== "number") {
    return;
  }

  scrollToPageRatio(scrollContainer, pageElement, targetTopRatio, entry);
}

function scrollToPageRatio(
  scrollContainer: HTMLElement,
  pageElement: HTMLElement,
  targetTopRatio: number,
  entry: FigureEntry,
) {
  const containerRect = scrollContainer.getBoundingClientRect();
  const pageRect = pageElement.getBoundingClientRect();
  const targetTop =
    scrollContainer.scrollTop +
    (pageRect.top - containerRect.top) +
    pageRect.height * targetTopRatio;
  const anchorOffset = getAnchorOffset(scrollContainer, entry);
  scrollContainer.scrollTop = Math.max(0, targetTop - anchorOffset);
}

function getHelperTargetTopRatio(entry: FigureEntry) {
  const bbox = entry.navigation?.targetBBoxNormalized;
  if (!bbox || bbox.length !== 4) {
    return undefined;
  }

  if (entry.navigation?.anchor === "center") {
    return clamp((bbox[1] + bbox[3]) / 2, 0, 1);
  }

  return clamp(bbox[1], 0, 1);
}

function getAnchorOffset(scrollContainer: HTMLElement, entry: FigureEntry) {
  switch (entry.navigation?.anchor) {
    case "center":
      return scrollContainer.clientHeight * 0.5;

    case "top":
      return scrollContainer.clientHeight * 0.12;

    case "bottom":
      return scrollContainer.clientHeight * 0.82;
  }

  return entry.type === "figure"
    ? scrollContainer.clientHeight * 0.82
    : scrollContainer.clientHeight * 0.12;
}

async function waitForRenderedPageElement(
  context: PDFViewerContext,
  pageNumber: number,
) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const pageElement = getRenderedPageElements(context).find((element) => {
      return Number(element.dataset.pageNumber) === pageNumber;
    });
    if (pageElement) {
      return pageElement;
    }

    await Zotero.Promise.delay(100);
  }

  return undefined;
}

async function waitForCaptionTargetTopRatio(
  pageElement: HTMLElement,
  entry: FigureEntry,
) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const targetTopRatio = getCaptionTargetTopRatio(pageElement, entry);
    if (typeof targetTopRatio === "number") {
      return targetTopRatio;
    }

    await Zotero.Promise.delay(100);
  }

  return undefined;
}

function getCaptionTargetTopRatio(
  pageElement: HTMLElement,
  entry: FigureEntry,
) {
  const lines = getPageTextLinesFromDOM(pageElement);
  const entryKey = getCaptionEntryKey(entry);

  for (const line of lines) {
    const detectedEntries = detectCaptionsInLine(line, entry.pageIndex);
    for (const detectedEntry of detectedEntries) {
      if (
        getCaptionEntryKey(detectedEntry) === entryKey &&
        typeof line.targetTopRatio === "number"
      ) {
        return line.targetTopRatio;
      }
    }

    if (
      startsWithCaptionLabel(line.text, entry.label) &&
      typeof line.targetTopRatio === "number"
    ) {
      return line.targetTopRatio;
    }
  }

  return undefined;
}

function getCaptionEntryKey(entry: FigureEntry) {
  return (
    parseCaptionLabel(entry)?.key ?? normalizeText(entry.label).toLowerCase()
  );
}

function startsWithCaptionLabel(text: string, label: string) {
  return normalizeText(text)
    .toLowerCase()
    .startsWith(normalizeText(label).toLowerCase());
}

function getPDFScrollContainer(
  context: PDFViewerContext,
): HTMLElement | undefined {
  return (
    getHTMLElement(context.app.pdfViewer?.container) ??
    getHTMLElement(context.doc?.querySelector("#viewerContainer"))
  );
}
