import { getLocaleID } from "../utils/locale";

type FigureEntryType = "figure" | "table";

interface FigureEntry {
  id: string;
  type: FigureEntryType;
  label: string;
  caption: string;
  pageIndex: number;
}

const PANE_ID = "zoterofig-reader-figures";
const FAKE_FIGURES: FigureEntry[] = [
  {
    id: "figure-1",
    type: "figure",
    label: "Figure 1",
    caption: "Overview of the experimental workflow and main variables.",
    pageIndex: 0,
  },
  {
    id: "table-1",
    type: "table",
    label: "Table 1",
    caption: "Summary of baseline characteristics and measurements.",
    pageIndex: 1,
  },
  {
    id: "figure-2",
    type: "figure",
    label: "Figure 2",
    caption: "Comparison of model performance across evaluation settings.",
    pageIndex: 2,
  },
];

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
      renderFigureList(props.body, props.item);
      props.setSectionSummary(`${FAKE_FIGURES.length}`);
    },
    sectionButtons: [
      {
        type: "refresh",
        icon: "chrome://zotero/skin/16/universal/book.svg",
        l10nID: getLocaleID("reader-figures-refresh-button-tooltip"),
        onClick: ({ body, item }) => {
          renderFigureList(body, item);
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

function renderFigureList(body: HTMLDivElement, item: Zotero.Item) {
  body.replaceChildren();

  const doc = body.ownerDocument as Document;
  const container = doc.createElement("div");
  Object.assign(container.style, {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    overflow: "visible",
    padding: "10px 0 12px",
  });

  for (const entry of FAKE_FIGURES) {
    container.appendChild(createFigureCard(doc, entry, item));
  }

  body.appendChild(container);
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

  heading.append(label, page);
  card.append(heading, caption, badge);
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
