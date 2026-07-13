#!/usr/bin/env python3
"""Deterministically vectorize orthogonal floor-plan linework with OpenCV."""

from __future__ import annotations

import argparse
import json
import math
import sys

try:
    import cv2
    import numpy as np
except Exception as exc:  # pragma: no cover - handled by the TypeScript boundary
    print(f"OpenCV runtime unavailable: {exc}", file=sys.stderr)
    raise SystemExit(3)


def read_image(path: str):
    data = np.fromfile(path, dtype=np.uint8)
    image = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError("OpenCV could not decode the source image")
    return image


def merge_axis_segments(segments, coordinate_tolerance=2, gap_tolerance=5, minimum_length=10):
    merged = []
    for orientation in ("h", "v"):
        values = sorted((item for item in segments if item[0] == orientation), key=lambda item: (item[1], item[2]))
        groups = []
        for _, coordinate, start, end in values:
            target = None
            for group in reversed(groups[-12:]):
                if abs(group[0] - coordinate) <= coordinate_tolerance:
                    target = group
                    break
            if target is None:
                groups.append([coordinate, [(start, end)]])
            else:
                count = len(target[1])
                target[0] = round((target[0] * count + coordinate) / (count + 1))
                target[1].append((start, end))

        for coordinate, runs in groups:
            runs.sort()
            start, end = runs[0]
            for next_start, next_end in runs[1:]:
                if next_start <= end + gap_tolerance:
                    end = max(end, next_end)
                    continue
                if end - start >= minimum_length:
                    merged.append((orientation, coordinate, start, end))
                start, end = next_start, next_end
            if end - start >= minimum_length:
                merged.append((orientation, coordinate, start, end))
    return merged


def axis_alignment_fraction(points):
    axis_length = 0.0
    total_length = 0.0
    for index, current in enumerate(points):
        following = points[(index + 1) % len(points)]
        dx = abs(int(following[0]) - int(current[0]))
        dy = abs(int(following[1]) - int(current[1]))
        length = math.hypot(dx, dy)
        total_length += length
        if dx <= 2 or dy <= 2:
            axis_length += length
    return axis_length / max(1.0, total_length)


def extract_structural_contours(binary):
    contours, _ = cv2.findContours(binary, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    selected = []
    mask = np.zeros_like(binary)
    for contour in contours:
        perimeter = cv2.arcLength(contour, True)
        if perimeter < 20:
            continue
        approximation = cv2.approxPolyDP(contour, max(1.0, perimeter * 0.0025), True)
        points = approximation[:, 0, :]
        if len(points) < 2 or axis_alignment_fraction(points) < 0.82:
            continue
        _, _, width, height = cv2.boundingRect(contour)
        area = cv2.contourArea(contour)
        structural_size = area >= 35 and max(width, height) >= 18
        elongated_line = max(width, height) >= 30 and min(width, height) <= 14
        if not structural_size and not elongated_line:
            continue
        # Short, jagged, flat contours are almost always text annotations such as
        # elevation labels. Real windows of this size remain simple rectangles.
        if min(width, height) <= 10 and max(width, height) <= 50 and len(points) > 12:
            continue
        selected.append(approximation)
        cv2.polylines(mask, [approximation], True, 255, 1)
    return selected, mask


def extract_axis_linework(binary, minimum_dimension):
    line_kernel = max(8, min(20, round(minimum_dimension * 0.014)))
    horizontal = cv2.morphologyEx(
        binary,
        cv2.MORPH_OPEN,
        cv2.getStructuringElement(cv2.MORPH_RECT, (line_kernel, 1)),
    )
    vertical = cv2.morphologyEx(
        binary,
        cv2.MORPH_OPEN,
        cv2.getStructuringElement(cv2.MORPH_RECT, (1, line_kernel)),
    )
    minimum_length = max(8, round(minimum_dimension * 0.012))
    raw_segments = []
    for mask, orientation in ((horizontal, "h"), (vertical, "v")):
        edge_mask = cv2.Canny(mask, 50, 150)
        lines = cv2.HoughLinesP(
            edge_mask,
            1,
            np.pi / 180,
            threshold=max(10, minimum_length),
            minLineLength=minimum_length,
            maxLineGap=max(3, round(minimum_dimension * 0.006)),
        )
        if lines is None:
            continue
        for x1, y1, x2, y2 in lines[:, 0]:
            if orientation == "h" and abs(int(y2) - int(y1)) <= 2:
                raw_segments.append(("h", round((int(y1) + int(y2)) / 2), min(int(x1), int(x2)), max(int(x1), int(x2))))
            elif orientation == "v" and abs(int(x2) - int(x1)) <= 2:
                raw_segments.append(("v", round((int(x1) + int(x2)) / 2), min(int(y1), int(y2)), max(int(y1), int(y2))))
    return merge_axis_segments(
        raw_segments,
        coordinate_tolerance=2,
        gap_tolerance=max(4, round(minimum_dimension * 0.007)),
        minimum_length=minimum_length,
    ), horizontal, vertical, line_kernel


def supplementary_axis_segments(segments, contour_mask, minimum_dimension):
    proximity = cv2.dilate(
        contour_mask,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7)),
    )
    minimum_length = max(18, round(minimum_dimension * 0.023))
    accepted = []
    for segment in segments:
        orientation, coordinate, start, end = segment
        if end - start < minimum_length:
            continue
        line_mask = np.zeros_like(contour_mask)
        if orientation == "h":
            cv2.line(line_mask, (start, coordinate), (end, coordinate), 255, 1)
        else:
            cv2.line(line_mask, (coordinate, start), (coordinate, end), 255, 1)
        line_pixels = np.count_nonzero(line_mask)
        coverage = np.count_nonzero((line_mask > 0) & (proximity > 0)) / float(max(1, line_pixels))
        if coverage < 0.8:
            accepted.append(segment)
    return accepted


def source_similarity(horizontal, vertical, contours, supplementary, shape):
    target = cv2.Canny(cv2.bitwise_or(horizontal, vertical), 50, 150)
    candidate = np.zeros(shape, dtype=np.uint8)
    for contour in contours:
        cv2.polylines(candidate, [contour], True, 255, 1)
    for orientation, coordinate, start, end in supplementary:
        if orientation == "h":
            cv2.line(candidate, (start, coordinate), (end, coordinate), 255, 1)
        else:
            cv2.line(candidate, (coordinate, start), (coordinate, end), 255, 1)
    tolerance = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
    target_near = cv2.dilate(target, tolerance)
    candidate_near = cv2.dilate(candidate, tolerance)
    candidate_pixels = max(1, np.count_nonzero(candidate))
    target_pixels = max(1, np.count_nonzero(target))
    precision = np.count_nonzero((candidate > 0) & (target_near > 0)) / float(candidate_pixels)
    recall = np.count_nonzero((target > 0) & (candidate_near > 0)) / float(target_pixels)
    f1 = 2.0 * precision * recall / max(1e-9, precision + recall)
    return precision, recall, f1


def extract_footprint(horizontal, vertical, width, height):
    minimum_dimension = min(width, height)
    gap = max(32, min(96, round(minimum_dimension * 0.088)))
    horizontal_closed = cv2.morphologyEx(
        cv2.bitwise_or(horizontal, vertical),
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_RECT, (gap, 1)),
    )
    vertical_closed = cv2.morphologyEx(
        cv2.bitwise_or(horizontal, vertical),
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_RECT, (1, gap)),
    )
    radius = max(2, round(minimum_dimension * 0.003))
    barrier = cv2.dilate(
        cv2.bitwise_or(horizontal_closed, vertical_closed),
        np.ones((radius * 2 + 1, radius * 2 + 1), np.uint8),
        iterations=1,
    )
    padded = cv2.copyMakeBorder(barrier, 1, 1, 1, 1, cv2.BORDER_CONSTANT, value=0)
    flooded = padded.copy()
    flood_mask = np.zeros((padded.shape[0] + 2, padded.shape[1] + 2), np.uint8)
    cv2.floodFill(flooded, flood_mask, (0, 0), 255)
    enclosed = cv2.bitwise_not(flooded[1:-1, 1:-1])
    footprint = cv2.bitwise_or(barrier, enclosed)
    contours, _ = cv2.findContours(footprint, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        raise RuntimeError("No connected building footprint was detected")
    contour = max(contours, key=cv2.contourArea)
    perimeter = cv2.arcLength(contour, True)
    polygon = cv2.approxPolyDP(contour, max(1.0, perimeter * 0.003), True)[:, 0, :]
    area_ratio = cv2.contourArea(contour) / float(width * height)
    if len(polygon) < 4 or area_ratio < 0.12 or area_ratio > 0.98:
        raise RuntimeError(f"Detected footprint is not credible (vertices={len(polygon)}, areaRatio={area_ratio:.3f})")
    return polygon, area_ratio, gap


def polygon_shape_changes(points):
    if len(points) < 4:
        return 0, 0
    crosses = []
    for index, current in enumerate(points):
        previous = points[index - 1]
        following = points[(index + 1) % len(points)]
        cross = (current[0] - previous[0]) * (following[1] - current[1]) - (current[1] - previous[1]) * (following[0] - current[0])
        if abs(cross) > 1e-6:
            crosses.append(cross)
    if not crosses:
        return 0, 0
    orientation = 1 if sum(crosses) >= 0 else -1
    reflex = sum(1 for value in crosses if value * orientation < 0)
    projections = max(0, (len(points) - 4 - reflex) // 2)
    return reflex, projections


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--left", type=int, required=True)
    parser.add_argument("--top", type=int, required=True)
    parser.add_argument("--crop-width", type=int, required=True)
    parser.add_argument("--crop-height", type=int, required=True)
    parser.add_argument("--physical-width", type=float, required=True)
    parser.add_argument("--physical-height", type=float, required=True)
    args = parser.parse_args()

    image = read_image(args.image)
    image_height, image_width = image.shape[:2]
    left = max(0, min(args.left, image_width - 1))
    top = max(0, min(args.top, image_height - 1))
    right = max(left + 1, min(left + args.crop_width, image_width))
    bottom = max(top + 1, min(top + args.crop_height, image_height))
    crop = image[top:bottom, left:right]
    height, width = crop.shape[:2]
    if width < 80 or height < 80:
        raise RuntimeError("Detected floor-plan crop is too small")

    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    threshold_value, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    minimum_dimension = min(width, height)
    segments, horizontal, vertical, line_kernel = extract_axis_linework(binary, minimum_dimension)
    contours, contour_mask = extract_structural_contours(binary)
    supplementary = supplementary_axis_segments(segments, contour_mask, minimum_dimension)
    polygon, area_ratio, closure_gap = extract_footprint(horizontal, vertical, width, height)
    if len(contours) + len(supplementary) < 8:
        raise RuntimeError(f"Too little structural linework was detected ({len(contours) + len(supplementary)})")

    physical_width = float(args.physical_width)
    physical_height = float(args.physical_height)
    if not math.isfinite(physical_width) or not math.isfinite(physical_height) or physical_width <= 0 or physical_height <= 0:
        raise RuntimeError("Physical calibration dimensions are invalid")

    def point(x, y):
        return {
            "x": float(x) / float(max(1, width - 1)) * physical_width,
            "y": physical_height - float(y) / float(max(1, height - 1)) * physical_height,
        }

    linework = []
    for contour in contours:
        contour_points = [point(int(item[0]), int(item[1])) for item in contour[:, 0, :]]
        if len(contour_points) >= 2:
            linework.append({"points": contour_points, "closed": True, "layer": "SOURCE_CONTOUR", "inferred": False})

    seen = set()
    for orientation, coordinate, start, end in supplementary:
        if orientation == "h":
            first = point(start, coordinate)
            second = point(end, coordinate)
        else:
            first = point(coordinate, start)
            second = point(coordinate, end)
        key = tuple(round(value, 3) for value in (first["x"], first["y"], second["x"], second["y"]))
        reverse = (key[2], key[3], key[0], key[1])
        if key in seen or reverse in seen:
            continue
        seen.add(key)
        linework.append({"points": [first, second], "closed": False, "layer": "SOURCE_LINEWORK", "inferred": False})

    outer_boundary = [point(int(item[0]), int(item[1])) for item in polygon]
    notches, projections = polygon_shape_changes([(item["x"], item["y"]) for item in outer_boundary])
    source_precision, source_recall, source_f1 = source_similarity(
        horizontal,
        vertical,
        contours,
        supplementary,
        binary.shape,
    )
    result = {
        "kind": "lumi_floorplan_opencv_vectorization",
        "version": 2,
        "width": physical_width,
        "height": physical_height,
        "unit": "mm",
        "coordinateSystem": "bottom_left_y_up",
        "outerBoundary": outer_boundary,
        "sourceTopology": {
            "isRectangular": len(outer_boundary) == 4,
            "outerVertexCount": len(outer_boundary),
            "visibleNotches": notches,
            "visibleProjections": projections,
            "traceMode": "opencv_source_linework",
        },
        "polylines": linework,
        "walls": [],
        "rooms": [],
        "doors": [],
        "windows": [],
        "columns": [],
        "holes": [],
        "labels": [],
        "furniture": [],
        "metrics": {
            "threshold": float(threshold_value),
            "lineKernel": line_kernel,
            "closureGap": closure_gap,
            "lineSegmentCount": len(linework),
            "contourCount": len(contours),
            "supplementaryLineCount": len(supplementary),
            "outerVertexCount": len(outer_boundary),
            "footprintAreaRatio": area_ratio,
            "sourcePixelPrecision": source_precision,
            "sourcePixelRecall": source_recall,
            "sourcePixelF1": source_f1,
            "pixelTolerance": 3,
            "cropWidth": width,
            "cropHeight": height,
        },
    }
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(2)
