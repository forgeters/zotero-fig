#!/usr/bin/env python3
"""Probe whether PyMuPDF can locate figure/table captions and image bboxes.

This script stays independent from the Zotero plugin runtime, but its default
output is shaped as a stable helper JSON payload that the plugin can consume
directly in a later integration step.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable

try:
    import fitz  # PyMuPDF
except ImportError as exc:  # pragma: no cover - exercised by user environment
    raise SystemExit(
        "PyMuPDF is not installed. Install it with: python -m pip install PyMuPDF"
    ) from exc


MAX_CAPTION_LENGTH = 300
CJK_NUMERAL_CHARS = "零〇一二两三四五六七八九十百千万"
CJK_NUMBER_PATTERN = rf"[0-9０-９{CJK_NUMERAL_CHARS}]+"
PLUGIN_SCHEMA_VERSION = "zotero-fig-helper/v1"


@dataclass
class BBox:
    x0: float
    y0: float
    x1: float
    y1: float

    @property
    def width(self) -> float:
        return max(0.0, self.x1 - self.x0)

    @property
    def height(self) -> float:
        return max(0.0, self.y1 - self.y0)

    @property
    def area(self) -> float:
        return self.width * self.height

    @property
    def center_x(self) -> float:
        return (self.x0 + self.x1) / 2

    @property
    def center_y(self) -> float:
        return (self.y0 + self.y1) / 2


@dataclass
class Caption:
    kind: str
    label: str
    caption: str
    page_index: int
    bbox: BBox
    source: str


@dataclass
class ImageBox:
    page_index: int
    bbox: BBox
    source: str
    width: int | None = None
    height: int | None = None
    xref: int | None = None


@dataclass
class FigureMatch:
    label: str
    page_index: int
    caption: str
    caption_bbox: BBox
    image_bbox: BBox | None
    image_source: str | None
    confidence: float
    reason: str
    low_confidence: bool


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Evaluate PyMuPDF figure/table caption and image-bbox extraction."
    )
    parser.add_argument("pdf", type=Path, help="PDF file to inspect")
    parser.add_argument(
        "--out",
        type=Path,
        help="Optional JSON output path. Probe mode defaults to tmp/pdf-probe/<pdf-stem>.json.",
    )
    parser.add_argument(
        "--max-pages",
        type=int,
        default=0,
        help="Only inspect the first N pages. 0 means all pages.",
    )
    parser.add_argument(
        "--min-image-area",
        type=float,
        default=0.004,
        help="Ignore image boxes smaller than this normalized page-area ratio.",
    )
    parser.add_argument(
        "--min-drawing-area",
        type=float,
        default=0.006,
        help="Ignore vector drawing boxes smaller than this normalized page-area ratio.",
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="Pretty-print JSON output.",
    )
    parser.add_argument(
        "--format",
        choices=("plugin", "probe"),
        default="plugin",
        help="Output schema. 'plugin' is the stable helper payload for Zotero.",
    )
    parser.add_argument(
        "--stdout",
        action="store_true",
        help="Write JSON to stdout only. In plugin mode this skips default temp files.",
    )
    parser.add_argument(
        "--document-id",
        help="Opaque document id passed through into the JSON payload.",
    )
    parser.add_argument(
        "--attachment-key",
        help="Optional Zotero attachment key passed through into the JSON payload.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    pdf_path = args.pdf.resolve()
    if not pdf_path.exists():
        print(f"PDF not found: {pdf_path}", file=sys.stderr)
        return 2

    started = time.perf_counter()
    doc = fitz.open(pdf_path)
    try:
        analysis = probe_document(
            doc,
            pdf_path,
            max_pages=args.max_pages,
            min_image_area=args.min_image_area,
            min_drawing_area=args.min_drawing_area,
        )
    finally:
        doc.close()

    elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
    analysis["elapsed_ms"] = elapsed_ms
    report = (
        build_plugin_report(
            analysis,
            pdf_path,
            elapsed_ms=elapsed_ms,
            document_id=args.document_id,
            attachment_key=args.attachment_key,
        )
        if args.format == "plugin"
        else analysis
    )

    out_path = resolve_output_path(args, pdf_path)
    if out_path:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(
            serialize_json(report, pretty=True),
            encoding="utf-8",
        )

    json_text = serialize_json(report, pretty=args.pretty)
    if args.stdout:
        print(json_text)
    elif args.format == "probe":
        print_summary(report, out_path)
        if args.pretty:
            print(json_text)
    else:
        print_plugin_summary(report, out_path)

    return 0


def probe_document(
    doc: fitz.Document,
    pdf_path: Path,
    max_pages: int,
    min_image_area: float,
    min_drawing_area: float,
) -> dict[str, Any]:
    page_count = len(doc)
    pages_to_scan = page_count if max_pages <= 0 else min(page_count, max_pages)
    captions: list[Caption] = []
    image_boxes: list[ImageBox] = []
    page_reports: list[dict[str, Any]] = []

    for page_index in range(pages_to_scan):
        page = doc[page_index]
        page_captions = extract_captions(page, page_index)
        page_images = extract_image_boxes(
            page,
            page_index,
            min_image_area,
            min_drawing_area,
        )
        captions.extend(page_captions)
        image_boxes.extend(page_images)
        page_reports.append(
            {
                "page_index": page_index,
                "width": round(float(page.rect.width), 3),
                "height": round(float(page.rect.height), 3),
                "captions": len(page_captions),
                "figures": sum(1 for item in page_captions if item.kind == "figure"),
                "tables": sum(1 for item in page_captions if item.kind == "table"),
                "image_boxes": len(page_images),
                "raster_boxes": sum(
                    1 for item in page_images if not item.source.startswith("drawing")
                ),
                "drawing_boxes": sum(
                    1 for item in page_images if item.source.startswith("drawing")
                ),
            }
        )

    captions = refine_captions(captions)
    figure_matches = match_figures_to_images(captions, image_boxes)
    figure_captions = [caption for caption in captions if caption.kind == "figure"]
    table_captions = [caption for caption in captions if caption.kind == "table"]
    matched_figures = [match for match in figure_matches if match.image_bbox]
    warnings = get_sequence_warnings(captions)

    return {
        "tool": "PyMuPDF",
        "pymupdf_version": getattr(fitz, "VersionBind", "unknown"),
        "pdf": str(pdf_path),
        "page_count": page_count,
        "scanned_pages": pages_to_scan,
        "summary": {
            "captions": len(captions),
            "figures": len(figure_captions),
            "tables": len(table_captions),
            "image_boxes": len(image_boxes),
            "matched_figures": len(matched_figures),
            "figure_match_rate": safe_ratio(len(matched_figures), len(figure_captions)),
        },
        "pages": page_reports,
        "warnings": warnings,
        "captions": [caption_to_json(caption) for caption in captions],
        "image_boxes": [image_to_json(image) for image in image_boxes],
        "figure_matches": [match_to_json(match) for match in figure_matches],
    }


def extract_captions(page: fitz.Page, page_index: int) -> list[Caption]:
    captions: list[Caption] = []
    lines = merge_caption_label_lines(extract_text_lines(page))
    for line in lines:
        detected = detect_caption(line["text"])
        if not detected:
            continue

        kind, label, caption_text = detected
        captions.append(
            Caption(
                kind=kind,
                label=label,
                caption=trim_caption(caption_text),
                page_index=page_index,
                bbox=BBox(*line["bbox"]),
                source="pymupdf_text_dict",
            )
        )

    return captions


def extract_text_lines(page: fitz.Page) -> list[dict[str, Any]]:
    data = page.get_text("dict")
    lines: list[dict[str, Any]] = []
    for block in data.get("blocks", []):
        if block.get("type") != 0:
            continue

        for line in block.get("lines", []):
            spans = line.get("spans", [])
            text = normalize_text(join_text_parts(span.get("text", "") for span in spans))
            if not text:
                continue

            bbox = line.get("bbox") or union_raw_bboxes(span.get("bbox") for span in spans)
            if not bbox:
                continue

            lines.append({"text": text, "bbox": tuple(float(value) for value in bbox)})

    lines.sort(key=lambda item: (round(item["bbox"][1], 1), item["bbox"][0]))
    return lines


def merge_caption_label_lines(lines: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    index = 0
    while index < len(lines):
        line = lines[index]
        if is_caption_label_only(line["text"]):
            next_line = find_next_caption_continuation(line, lines[index + 1 :])
            if next_line:
                merged.append(
                    {
                        "text": normalize_text(f"{line['text']} {next_line['text']}"),
                        "bbox": union_raw_bboxes([line["bbox"], next_line["bbox"]]),
                    }
                )
                index += 1
            else:
                merged.append(line)
        else:
            merged.append(line)
        index += 1

    return merged


def find_next_caption_continuation(
    label_line: dict[str, Any],
    following_lines: list[dict[str, Any]],
) -> dict[str, Any] | None:
    label_bbox = BBox(*label_line["bbox"])
    candidates = []
    for line in following_lines:
        bbox = BBox(*line["bbox"])
        if bbox.y0 <= label_bbox.y0:
            continue
        if bbox.y0 - label_bbox.y1 > 45:
            break
        if detect_caption(line["text"]):
            continue
        candidates.append((bbox.y0 - label_bbox.y1, line))

    if not candidates:
        return None

    candidates.sort(key=lambda item: item[0])
    return candidates[0][1]


def is_caption_label_only(text: str) -> bool:
    normalized = normalize_text(text)
    english = re.match(
        r"^(Figure|Fig\.?|Table)\s*[A-Za-z]?\d+(?:[.-]\d+)?[A-Za-z]?$",
        normalized,
        flags=re.IGNORECASE,
    )
    cjk = re.match(
        rf"^[图表]\s*{CJK_NUMBER_PATTERN}(?:[.－．-]{CJK_NUMBER_PATTERN})?$",
        normalized,
    )

    return bool(english or cjk)


def extract_image_boxes(
    page: fitz.Page,
    page_index: int,
    min_image_area: float,
    min_drawing_area: float,
) -> list[ImageBox]:
    page_area = max(1.0, float(page.rect.width * page.rect.height))
    boxes: list[ImageBox] = []

    boxes.extend(extract_image_blocks(page, page_index, page_area, min_image_area))
    boxes.extend(extract_image_rects(page, page_index, page_area, min_image_area))
    boxes.extend(extract_drawing_boxes(page, page_index, page_area, min_drawing_area))

    return merge_image_boxes(boxes)


def extract_image_blocks(
    page: fitz.Page,
    page_index: int,
    page_area: float,
    min_image_area: float,
) -> list[ImageBox]:
    boxes: list[ImageBox] = []
    data = page.get_text("dict")
    for block in data.get("blocks", []):
        if block.get("type") != 1:
            continue

        bbox = block.get("bbox")
        if not bbox:
            continue

        image_box = ImageBox(
            page_index=page_index,
            bbox=BBox(*[float(value) for value in bbox]),
            source="text_dict_image_block",
            width=optional_int(block.get("width")),
            height=optional_int(block.get("height")),
        )
        if is_meaningful_box(image_box.bbox, page_area, min_image_area):
            boxes.append(image_box)

    return boxes


def extract_image_rects(
    page: fitz.Page,
    page_index: int,
    page_area: float,
    min_image_area: float,
) -> list[ImageBox]:
    boxes: list[ImageBox] = []
    try:
        image_items = page.get_images(full=True)
    except Exception as exc:  # pragma: no cover - depends on PDFs
        return [
            ImageBox(
                page_index=page_index,
                bbox=BBox(0, 0, 0, 0),
                source=f"get_images_error:{type(exc).__name__}",
            )
        ]

    for item in image_items:
        xref = optional_int(item[0] if item else None)
        width = optional_int(item[2] if len(item) > 2 else None)
        height = optional_int(item[3] if len(item) > 3 else None)
        try:
            rects = page.get_image_rects(item, transform=False)
        except Exception:
            rects = []

        for rect in rects:
            bbox = BBox(float(rect.x0), float(rect.y0), float(rect.x1), float(rect.y1))
            image_box = ImageBox(
                page_index=page_index,
                bbox=bbox,
                source="get_image_rects",
                width=width,
                height=height,
                xref=xref,
            )
            if is_meaningful_box(image_box.bbox, page_area, min_image_area):
                boxes.append(image_box)

    return boxes


def extract_drawing_boxes(
    page: fitz.Page,
    page_index: int,
    page_area: float,
    min_drawing_area: float,
) -> list[ImageBox]:
    boxes: list[ImageBox] = []
    try:
        drawings = page.get_drawings()
    except Exception:
        return boxes

    min_raw_area = page_area * 0.00002
    drawing_boxes: list[BBox] = []
    for drawing in drawings:
        rect = drawing.get("rect")
        if not rect:
            continue

        bbox = BBox(float(rect.x0), float(rect.y0), float(rect.x1), float(rect.y1))
        if bbox.width >= 1.5 and bbox.height >= 1.5 and bbox.area >= min_raw_area:
            drawing_boxes.append(bbox)

    for bbox in merge_nearby_boxes(
        drawing_boxes,
        page.rect,
        gap=max(14.0, float(page.rect.width) * 0.055),
    ):
        if is_meaningful_box(bbox, page_area, min_drawing_area):
            boxes.append(
                ImageBox(
                    page_index=page_index,
                    bbox=bbox,
                    source="drawing_cluster",
                )
            )

    return boxes


def detect_caption(text: str) -> tuple[str, str, str] | None:
    normalized = normalize_text(text)
    label_only = re.match(
        r"^(Figure|Fig\.?|Table)\s*([A-Za-z]?\d+(?:[.-]\d+)?[A-Za-z]?)$",
        normalized,
        flags=re.IGNORECASE,
    )
    if label_only:
        marker = label_only.group(1).lower()
        kind = "table" if marker.startswith("tab") else "figure"
        label = f"{'Table' if kind == 'table' else 'Figure'} {label_only.group(2)}"
        return kind, label, label

    english = re.match(
        r"^(Figure|Fig\.?|Table)\s*([A-Za-z]?\d+(?:[.-]\d+)?[A-Za-z]?)(?:\s*([-:.–—])\s*|\s+)(.*)$",
        normalized,
        flags=re.IGNORECASE,
    )
    if english:
        marker = english.group(1).lower()
        kind = "table" if marker.startswith("tab") else "figure"
        label = f"{'Table' if kind == 'table' else 'Figure'} {english.group(2)}"
        caption = english.group(4) or normalized
        if not english.group(3) and looks_like_inline_english_reference(caption):
            return None
        if is_likely_subfigure_reference(label, caption):
            return None
        return kind, label, caption

    cjk_label_only = re.match(
        rf"^([图表])\s*({CJK_NUMBER_PATTERN}(?:[.－．-]{CJK_NUMBER_PATTERN})?)$",
        normalized,
    )
    if cjk_label_only:
        kind = "table" if cjk_label_only.group(1) == "表" else "figure"
        label = (
            f"{cjk_label_only.group(1)}"
            f"{normalize_digits(cjk_label_only.group(2)).replace(' ', '')}"
        )
        return kind, label, label

    cjk = re.match(
        rf"^([图表])\s*({CJK_NUMBER_PATTERN}(?:[.－．-]{CJK_NUMBER_PATTERN})?)(?:\s*([-:：.–—])\s*|\s+)?(.*)$",
        normalized,
    )
    if cjk:
        kind = "table" if cjk.group(1) == "表" else "figure"
        label = f"{cjk.group(1)}{normalize_digits(cjk.group(2)).replace(' ', '')}"
        caption = cjk.group(4) or normalized
        if not cjk.group(3) and looks_like_inline_cjk_reference(caption):
            return None
        if is_likely_subfigure_reference(label, caption):
            return None
        return kind, label, caption

    return None


def refine_captions(captions: list[Caption]) -> list[Caption]:
    deduped: dict[str, Caption] = {}
    for caption in captions:
        key = caption_key(caption)
        existing = deduped.get(key)
        if not existing or caption_score(caption) > caption_score(existing):
            deduped[key] = caption

    values = list(deduped.values())
    base_keys = {caption_base_key(caption) for caption in values if not caption_suffix(caption)}
    filtered = [
        caption
        for caption in values
        if not caption_suffix(caption) or caption_base_key(caption) not in base_keys
    ]
    filtered.sort(key=caption_sort_key)

    return filtered


def caption_key(caption: Caption) -> str:
    return f"{caption.kind}:{normalize_label_number(caption.label)}"


def caption_base_key(caption: Caption) -> str:
    return re.sub(r"[A-Za-z]$", "", caption_key(caption))


def caption_suffix(caption: Caption) -> str:
    match = re.search(r"\d+([A-Za-z])$", caption.label)
    return match.group(1).upper() if match else ""


def normalize_label_number(label: str) -> str:
    return normalize_text(label).replace(" ", "").upper()


def caption_score(caption: Caption) -> float:
    score = min(len(caption.caption), 240)
    if caption.caption == caption.label:
        score -= 30
    if caption_suffix(caption):
        score -= 40
    if looks_like_inline_english_reference(caption.caption) or looks_like_inline_cjk_reference(
        caption.caption
    ):
        score -= 60
    return score


def caption_sort_key(caption: Caption) -> tuple[str, int, float, str]:
    return (caption.kind, caption.page_index, caption.bbox.y0, caption.label)


def is_likely_subfigure_reference(label: str, caption: str) -> bool:
    if not re.search(r"\d+[A-Za-z]$", label):
        return False

    normalized = normalize_text(caption)
    if len(normalized) < 80:
        return True

    return bool(re.match(r"^[a-z]", normalized))


def match_figures_to_images(
    captions: list[Caption],
    image_boxes: list[ImageBox],
) -> list[FigureMatch]:
    matches: list[FigureMatch] = []
    figure_captions = [caption for caption in captions if caption.kind == "figure"]

    for caption in figure_captions:
        same_page_images = [
            image for image in image_boxes if image.page_index == caption.page_index
        ]
        matched_image, confidence, reason = choose_image_for_caption(
            caption,
            same_page_images,
            figure_captions,
        )
        matches.append(
            FigureMatch(
                label=caption.label,
                page_index=caption.page_index,
                caption=caption.caption,
                caption_bbox=caption.bbox,
                image_bbox=matched_image.bbox if matched_image else None,
                image_source=matched_image.source if matched_image else None,
                confidence=confidence,
                reason=reason,
                low_confidence=confidence < 0.45,
            )
        )

    return matches


def choose_image_for_caption(
    caption: Caption,
    images: list[ImageBox],
    figure_captions: list[Caption],
) -> tuple[ImageBox | None, float, str]:
    if not images:
        return None, 0.0, "no_image_boxes_on_page"

    previous_caption_y = max(
        (
            item.bbox.y0
            for item in figure_captions
            if item.page_index == caption.page_index and item.bbox.y0 < caption.bbox.y0
        ),
        default=0.0,
    )
    candidates = [
        image
        for image in images
        if image.bbox.y1 <= caption.bbox.y0 + 12
        and image.bbox.center_y >= previous_caption_y
    ]
    if not candidates:
        candidates = [
            image for image in images if image.bbox.center_y <= caption.bbox.y0 + 12
        ]

    if not candidates:
        return None, 0.0, "no_image_above_caption"

    combined = combine_related_candidates(candidates, caption.bbox)
    if combined:
        confidence = score_image_caption_match(combined.bbox, caption.bbox)
        confidence = max(0.05, min(0.95, confidence))
        return combined, confidence, "above_caption_combined_regions"

    scored = [
        (image, score_image_caption_match(image.bbox, caption.bbox))
        for image in candidates
    ]
    scored.sort(key=lambda item: item[1], reverse=True)
    best_image, score = scored[0]
    reason = "above_caption_nearest_largest"
    confidence = max(0.05, min(0.95, score))

    return best_image, confidence, reason


def combine_related_candidates(
    candidates: list[ImageBox],
    caption_bbox: BBox,
) -> ImageBox | None:
    if len(candidates) < 2:
        return None

    meaningful = [
        image
        for image in candidates
        if image.bbox.y1 <= caption_bbox.y0 + 12 and image.bbox.area > 0
    ]
    if len(meaningful) < 2:
        return None

    largest = max(meaningful, key=lambda image: image.bbox.area)
    meaningful = [
        image for image in meaningful if image.bbox.area >= largest.bbox.area * 0.05
    ]
    if len(meaningful) < 2:
        return None

    union = meaningful[0].bbox
    for image in meaningful[1:]:
        union = union_bbox(union, image.bbox)

    if union.area < largest.bbox.area * 1.08:
        return None

    return ImageBox(
        page_index=largest.page_index,
        bbox=union,
        source="matched_union",
    )


def score_image_caption_match(image_bbox: BBox, caption_bbox: BBox) -> float:
    vertical_gap = max(0.0, caption_bbox.y0 - image_bbox.y1)
    horizontal_overlap = overlap_1d(
        image_bbox.x0,
        image_bbox.x1,
        caption_bbox.x0,
        caption_bbox.x1,
    )
    horizontal_base = max(1.0, min(image_bbox.width, caption_bbox.width))
    overlap_score = min(1.0, horizontal_overlap / horizontal_base)
    gap_score = 1.0 / (1.0 + vertical_gap / 45.0)
    area_score = min(1.0, math.sqrt(image_bbox.area) / 250.0)

    return gap_score * 0.55 + overlap_score * 0.25 + area_score * 0.2


def merge_image_boxes(boxes: list[ImageBox]) -> list[ImageBox]:
    merged: list[ImageBox] = []
    for box in sorted(boxes, key=lambda item: item.bbox.area, reverse=True):
        duplicate = next(
            (
                existing
                for existing in merged
                if existing.page_index == box.page_index
                and bbox_iou(existing.bbox, box.bbox) > 0.9
            ),
            None,
        )
        if duplicate:
            continue
        merged.append(box)

    return sorted(merged, key=lambda item: (item.page_index, item.bbox.y0, item.bbox.x0))


def merge_nearby_boxes(
    boxes: list[BBox],
    page_rect: fitz.Rect,
    gap: float | None = None,
) -> list[BBox]:
    if not boxes:
        return []

    page_diagonal = math.sqrt(
        page_rect.width * page_rect.width + page_rect.height * page_rect.height
    )
    merge_gap = gap if gap is not None else max(8.0, page_diagonal * 0.012)
    merged: list[BBox] = []
    for box in sorted(boxes, key=lambda item: item.area, reverse=True):
        current = box
        changed = True
        while changed:
            changed = False
            remaining: list[BBox] = []
            for existing in merged:
                if boxes_are_near(current, existing, merge_gap):
                    current = union_bbox(current, existing)
                    changed = True
                else:
                    remaining.append(existing)
            merged = remaining
        merged.append(current)

    return sorted(merged, key=lambda item: (item.y0, item.x0))


def boxes_are_near(first: BBox, second: BBox, gap: float) -> bool:
    expanded = BBox(
        first.x0 - gap,
        first.y0 - gap,
        first.x1 + gap,
        first.y1 + gap,
    )
    return bbox_intersects(expanded, second)


def bbox_intersects(first: BBox, second: BBox) -> bool:
    return not (
        first.x1 < second.x0
        or second.x1 < first.x0
        or first.y1 < second.y0
        or second.y1 < first.y0
    )


def union_bbox(first: BBox, second: BBox) -> BBox:
    return BBox(
        min(first.x0, second.x0),
        min(first.y0, second.y0),
        max(first.x1, second.x1),
        max(first.y1, second.y1),
    )


def is_meaningful_box(bbox: BBox, page_area: float, min_image_area: float) -> bool:
    if bbox.width < 12 or bbox.height < 12:
        return False
    return bbox.area / page_area >= min_image_area


def bbox_iou(first: BBox, second: BBox) -> float:
    x0 = max(first.x0, second.x0)
    y0 = max(first.y0, second.y0)
    x1 = min(first.x1, second.x1)
    y1 = min(first.y1, second.y1)
    intersection = max(0.0, x1 - x0) * max(0.0, y1 - y0)
    union = first.area + second.area - intersection
    return 0.0 if union <= 0 else intersection / union


def overlap_1d(a0: float, a1: float, b0: float, b1: float) -> float:
    return max(0.0, min(a1, b1) - max(a0, b0))


def union_raw_bboxes(raw_bboxes: Iterable[Any]) -> tuple[float, float, float, float] | None:
    boxes = [bbox for bbox in raw_bboxes if bbox and len(bbox) >= 4]
    if not boxes:
        return None
    return (
        min(float(bbox[0]) for bbox in boxes),
        min(float(bbox[1]) for bbox in boxes),
        max(float(bbox[2]) for bbox in boxes),
        max(float(bbox[3]) for bbox in boxes),
    )


def caption_to_json(caption: Caption) -> dict[str, Any]:
    value = asdict(caption)
    value["bbox"] = bbox_to_list(caption.bbox)
    return value


def image_to_json(image: ImageBox) -> dict[str, Any]:
    value = asdict(image)
    value["bbox"] = bbox_to_list(image.bbox)
    return value


def match_to_json(match: FigureMatch) -> dict[str, Any]:
    value = asdict(match)
    value["caption_bbox"] = bbox_to_list(match.caption_bbox)
    value["image_bbox"] = bbox_to_list(match.image_bbox) if match.image_bbox else None
    return value


def build_plugin_report(
    analysis: dict[str, Any],
    pdf_path: Path,
    *,
    elapsed_ms: float,
    document_id: str | None,
    attachment_key: str | None,
) -> dict[str, Any]:
    page_metrics = {
        int(page["page_index"]): {
            "width": float(page["width"]),
            "height": float(page["height"]),
        }
        for page in analysis["pages"]
    }
    figure_match_map = {
        (int(item["page_index"]), normalize_label_number(item["label"])): item
        for item in analysis["figure_matches"]
    }

    figures: list[dict[str, Any]] = []
    tables: list[dict[str, Any]] = []
    for caption in analysis["captions"]:
        page_index = int(caption["page_index"])
        page_info = page_metrics.get(page_index, {"width": 1.0, "height": 1.0})
        caption_bbox = caption["bbox"]
        base_entry = {
            "id": make_plugin_entry_id(
                caption["kind"],
                page_index,
                caption["label"],
            ),
            "type": caption["kind"],
            "label": caption["label"],
            "caption": caption["caption"],
            "page_index": page_index,
            "page_number": page_index + 1,
            "caption_bbox": caption_bbox,
            "caption_bbox_normalized": normalize_bbox_list(
                caption_bbox,
                page_info["width"],
                page_info["height"],
            ),
        }

        if caption["kind"] == "figure":
            match = figure_match_map.get(
                (page_index, normalize_label_number(caption["label"]))
            )
            figures.append(
                {
                    **base_entry,
                    "navigation": build_figure_navigation(
                        match,
                        page_info,
                        caption_bbox,
                    ),
                }
            )
        else:
            tables.append(
                {
                    **base_entry,
                    "navigation": build_table_navigation(page_info, caption_bbox),
                }
            )

    located_figures = sum(
        1 for figure in figures if figure["navigation"]["strategy"] == "bbox"
    )
    return {
        "schema_version": PLUGIN_SCHEMA_VERSION,
        "generator": {
            "name": "pdf_probe",
            "engine": "PyMuPDF",
            "version": analysis["pymupdf_version"],
        },
        "document": {
            "document_id": document_id,
            "attachment_key": attachment_key,
            "pdf_path": str(pdf_path),
            "file_name": pdf_path.name,
            "page_count": int(analysis["page_count"]),
            "scanned_pages": int(analysis["scanned_pages"]),
            "elapsed_ms": elapsed_ms,
        },
        "stats": {
            "captions": int(analysis["summary"]["captions"]),
            "figures": len(figures),
            "tables": len(tables),
            "image_boxes": int(analysis["summary"]["image_boxes"]),
            "located_figures": located_figures,
            "figure_location_rate": safe_ratio(located_figures, len(figures)),
            "low_confidence_figures": sum(
                1 for figure in figures if figure["navigation"]["low_confidence"]
            ),
        },
        "warnings": analysis.get("warnings", []),
        "pages": [
            {
                "page_index": int(page["page_index"]),
                "page_number": int(page["page_index"]) + 1,
                "width": float(page["width"]),
                "height": float(page["height"]),
            }
            for page in analysis["pages"]
        ],
        "figures": figures,
        "tables": tables,
    }


def build_figure_navigation(
    match: dict[str, Any] | None,
    page_info: dict[str, float],
    caption_bbox: list[float],
) -> dict[str, Any]:
    if match and match.get("image_bbox"):
        target_bbox = match["image_bbox"]
        strategy = "bbox"
        anchor = "center"
        source = match.get("image_source") or "matched_image"
        confidence = round(float(match.get("confidence", 0.0)), 4)
        low_confidence = bool(match.get("low_confidence", confidence < 0.45))
        reason = match.get("reason", "matched_image")
    else:
        target_bbox = caption_bbox
        strategy = "caption"
        anchor = "bottom"
        source = "caption"
        confidence = 0.0
        low_confidence = True
        reason = match.get("reason", "no_match_record") if match else "no_match_record"

    return {
        "strategy": strategy,
        "anchor": anchor,
        "target_bbox": target_bbox,
        "target_bbox_normalized": normalize_bbox_list(
            target_bbox,
            page_info["width"],
            page_info["height"],
        ),
        "source": source,
        "reason": reason,
        "confidence": confidence,
        "low_confidence": low_confidence,
    }


def build_table_navigation(
    page_info: dict[str, float],
    caption_bbox: list[float],
) -> dict[str, Any]:
    return {
        "strategy": "caption",
        "anchor": "top",
        "target_bbox": caption_bbox,
        "target_bbox_normalized": normalize_bbox_list(
            caption_bbox,
            page_info["width"],
            page_info["height"],
        ),
        "source": "caption",
        "reason": "table_caption_anchor",
        "confidence": 1.0,
        "low_confidence": False,
    }


def make_plugin_entry_id(kind: str, page_index: int, label: str) -> str:
    return f"{kind}-{page_index}-{normalize_label_number(label).lower()}"


def normalize_bbox_list(
    bbox: list[float] | None,
    page_width: float,
    page_height: float,
) -> list[float] | None:
    if not bbox:
        return None

    safe_width = max(page_width, 1.0)
    safe_height = max(page_height, 1.0)
    return [
        round(clamp(float(bbox[0]) / safe_width, 0.0, 1.0), 6),
        round(clamp(float(bbox[1]) / safe_height, 0.0, 1.0), 6),
        round(clamp(float(bbox[2]) / safe_width, 0.0, 1.0), 6),
        round(clamp(float(bbox[3]) / safe_height, 0.0, 1.0), 6),
    ]


def resolve_output_path(args: argparse.Namespace, pdf_path: Path) -> Path | None:
    if args.out:
        return args.out
    if args.stdout and args.format == "plugin":
        return None

    suffix = ".plugin.json" if args.format == "plugin" else ".json"
    return Path("tmp/pdf-probe") / f"{pdf_path.stem}{suffix}"


def serialize_json(payload: dict[str, Any], *, pretty: bool) -> str:
    if pretty:
        return json.dumps(payload, ensure_ascii=False, indent=2)
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def bbox_to_list(bbox: BBox) -> list[float]:
    return [
        round(bbox.x0, 3),
        round(bbox.y0, 3),
        round(bbox.x1, 3),
        round(bbox.y1, 3),
    ]


def print_summary(report: dict[str, Any], out_path: Path | None) -> None:
    summary = report["summary"]
    print(f"PDF: {report['pdf']}")
    print(f"Pages scanned: {report['scanned_pages']}/{report['page_count']}")
    print(
        "Captions: {captions} | Figures: {figures} | Tables: {tables} | "
        "Image boxes: {image_boxes}".format(**summary)
    )
    print(
        "Matched figures: {matched_figures}/{figures} "
        "({figure_match_rate:.1%})".format(**summary)
    )
    print(f"Elapsed: {report['elapsed_ms']} ms")
    if out_path:
        print(f"JSON: {out_path}")


def print_plugin_summary(report: dict[str, Any], out_path: Path | None) -> None:
    stats = report["stats"]
    document = report["document"]
    print(f"PDF: {document['pdf_path']}")
    print(f"Pages scanned: {document['scanned_pages']}/{document['page_count']}")
    print(
        "Figures: {figures} | Tables: {tables} | "
        "Located figures: {located_figures} ({figure_location_rate:.1%})".format(
            **stats
        )
    )
    print(f"Elapsed: {document['elapsed_ms']} ms")
    if out_path:
        print(f"JSON: {out_path}")


def normalize_text(text: str) -> str:
    return fix_cjk_spacing(re.sub(r"\s+", " ", text).strip())


def fix_cjk_spacing(text: str) -> str:
    return (
        re.sub(rf"([图表])\s+(?=[0-9０-９{CJK_NUMERAL_CHARS}])", r"\1", text)
        .replace("．", ".")
        .replace("－", ".")
    )


def join_text_parts(parts: Iterable[str]) -> str:
    joined = ""
    for part in parts:
        normalized = normalize_text(part)
        if not normalized:
            continue
        if not joined:
            joined = normalized
            continue
        joined += "" if should_join_text_parts(joined, normalized) else " "
        joined += normalized
    return joined


def should_join_text_parts(left: str, right: str) -> bool:
    left_char = left[-1]
    right_char = right[0]
    if left_char in "图表" and re.match(rf"[0-9０-９{CJK_NUMERAL_CHARS}]", right_char):
        return True
    if re.match(r"[0-9０-９]", left_char) and re.match(r"[0-9０-９]", right_char):
        return True
    if re.match(r"[\u3400-\u9fff]", left_char) and re.match(
        r"[\u3400-\u9fff]", right_char
    ):
        return True
    return False


def trim_caption(caption: str) -> str:
    normalized = normalize_text(caption).lstrip("-:：.–— ")
    if len(normalized) <= MAX_CAPTION_LENGTH:
        return normalized
    return normalized[: MAX_CAPTION_LENGTH - 3] + "..."


def normalize_label_number(label: str) -> str:
    return normalize_text(label).replace(" ", "").upper()


def normalize_digits(value: str) -> str:
    return "".join(
        chr(ord(char) - 0xFEE0) if "０" <= char <= "９" else char for char in value
    )


def parse_label_parts(label: str, kind: str) -> dict[str, Any] | None:
    normalized = normalize_text(label)
    english = re.match(
        r"^(Figure|Table)\s+([A-Za-z]*)(\d+(?:[.-]\d+)?)([A-Za-z]?)$",
        normalized,
        flags=re.IGNORECASE,
    )
    if english:
        prefix = english.group(2).upper()
        number_part = english.group(3)
        suffix = english.group(4).upper()
        root_number = f"{prefix}{number_part}"
        sequence_number = (
            None
            if prefix or "." in number_part or "-" in number_part
            else optional_int(number_part)
        )
        return {
            "kind": kind,
            "key": f"{kind}:{root_number.upper()}{suffix}",
            "base_key": f"{kind}:{root_number.upper()}",
            "sequence_number": sequence_number,
            "suffix": suffix,
        }

    cjk = re.match(
        rf"^([图表])\s*({CJK_NUMBER_PATTERN})([A-Za-z]?)$",
        normalized,
    )
    if cjk:
        root_number = normalize_digits(cjk.group(2)).replace(" ", "")
        suffix = cjk.group(3).upper()
        sequence_number = parse_cjk_sequence_number(root_number)
        sequence_root = str(sequence_number) if sequence_number else root_number
        return {
            "kind": kind,
            "key": f"{kind}:{sequence_root.upper()}{suffix}",
            "base_key": f"{kind}:{sequence_root.upper()}",
            "sequence_number": sequence_number,
            "suffix": suffix,
        }

    return None


def get_sequence_warnings(captions: list[Caption]) -> list[str]:
    warnings: list[str] = []
    for kind in ("figure", "table"):
        numbers: set[int] = set()
        for caption in captions:
            if caption.kind != kind:
                continue
            parsed = parse_label_parts(caption.label, caption.kind)
            sequence_number = parsed["sequence_number"] if parsed else None
            if isinstance(sequence_number, int) and sequence_number > 0:
                numbers.add(sequence_number)
        if len(numbers) < 2:
            continue
        warnings.extend(get_missing_sequence_labels(kind, sorted(numbers)))
    return warnings[:8]


def get_missing_sequence_labels(kind: str, numbers: list[int]) -> list[str]:
    missing: list[str] = []
    available = set(numbers)
    max_number = numbers[-1] if numbers else 0
    prefix = "Figure" if kind == "figure" else "Table"
    for number in range(1, max_number + 1):
        if number not in available:
            missing.append(f"{prefix} {number}")
    return missing


def parse_cjk_sequence_number(value: str) -> int | None:
    if re.match(r"^\d+$", value):
        return optional_int(value)
    if "." in value or "-" in value:
        return None
    return parse_chinese_integer(value)


def parse_chinese_integer(value: str) -> int | None:
    digit_map = {
        "零": 0,
        "〇": 0,
        "一": 1,
        "二": 2,
        "两": 2,
        "三": 3,
        "四": 4,
        "五": 5,
        "六": 6,
        "七": 7,
        "八": 8,
        "九": 9,
    }
    unit_map = {"十": 10, "百": 100, "千": 1000, "万": 10000}
    if not re.match(rf"^[{CJK_NUMERAL_CHARS}]+$", value):
        return None
    if not any(char in unit_map for char in value):
        digits = [digit_map.get(char) for char in value]
        return int("".join(str(digit) for digit in digits)) if None not in digits else None

    total = 0
    section = 0
    number = 0
    for char in value:
        if char in digit_map:
            number = digit_map[char]
            continue

        unit = unit_map.get(char)
        if not unit:
            return None

        if unit == 10000:
            total += (section + number) * unit
            section = 0
        else:
            section += (number or 1) * unit
        number = 0

    return total + section + number


def looks_like_inline_english_reference(text: str) -> bool:
    normalized = normalize_text(text)
    return bool(
        re.match(
            r"^(shows?|shown|demonstrates?|illustrates?|indicates?|presents?|depicts?|contains?|and|or|above|below|left|right)\b",
            normalized,
            flags=re.IGNORECASE,
        )
    )


def looks_like_inline_cjk_reference(text: str) -> bool:
    normalized = normalize_text(text).replace(" ", "")
    return bool(re.match(r"^(所示|所列|中|中的|为|是|显示|表明|说明|可见|和|与|及)", normalized))


def clamp(value: float, minimum: float, maximum: float) -> float:
    return min(max(value, minimum), maximum)


def optional_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def safe_ratio(numerator: int, denominator: int) -> float:
    return 0.0 if denominator == 0 else numerator / denominator


if __name__ == "__main__":
    raise SystemExit(main())
