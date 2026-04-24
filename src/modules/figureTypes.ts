export type FigureEntryType = "figure" | "table";

export type FigureNavigationAnchor = "top" | "center" | "bottom";
export type FigureNavigationStrategy = "bbox" | "caption";

export interface FigureNavigation {
  strategy: FigureNavigationStrategy;
  anchor: FigureNavigationAnchor;
  targetBBoxNormalized?: [number, number, number, number];
  source?: string;
  reason?: string;
  confidence?: number;
  lowConfidence?: boolean;
}

export interface HelperDiagnostics {
  status: "not_pdf" | "no_pdf_path" | "no_python" | "failed" | "succeeded";
  message: string;
  matchedFigureCount?: number;
  helperFigureCount?: number;
  selectedCommand?: string;
}

export interface FigureEntry {
  id: string;
  type: FigureEntryType;
  label: string;
  caption: string;
  pageIndex: number;
  targetTopRatio?: number;
  navigation?: FigureNavigation;
}

export interface FigureScanResult {
  entries: FigureEntry[];
  warnings: string[];
  helperDiagnostics?: HelperDiagnostics;
}
