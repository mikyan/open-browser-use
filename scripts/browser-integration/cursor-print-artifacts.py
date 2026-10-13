"""Read-only oracle for the synthetic cursor-print browser fixture.

Run with the bundled Python (pypdf/Pillow) and pdftoppm on PATH. The input PDFs
and screen captures are never changed. Only derived PNGs and the JSON report
are overwritten, so a failed run can be inspected again without losing inputs.
"""

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys

from PIL import Image
from pypdf import PdfReader
from pypdf.generic import ContentStream


MAX_FILE_BYTES = 32 * 1024 * 1024
MAX_PDF_BYTES = 16 * 1024 * 1024
MAX_PIXELS = 16 * 1024 * 1024
MIN_BLUE_PIXELS = 32
MARKERS = (
    ("OBU-PRINT-RECEIPT-2026", "Prepared by browser agent"),
    ("OBU-PRINT-SECOND-PAGE",),
)


class OracleFailure(Exception):
    pass


def require(condition, message):
    if not condition:
        raise OracleFailure(message)


def file_identity(path, limit=MAX_FILE_BYTES):
    size = path.stat().st_size
    require(0 < size <= limit, "artifact byte limit or empty artifact")
    data = path.read_bytes()
    require(len(data) == size, "artifact changed while reading")
    return {"artifact": path.name, "bytes": size, "sha256": hashlib.sha256(data).hexdigest()}


def pixel_summary(path, *, screen=False):
    identity = file_identity(path)
    with Image.open(path) as image:
        require(image.format == "PNG", "expected PNG")
        width, height = image.size
        require(0 < width * height <= MAX_PIXELS, "PNG pixel limit")
        require(getattr(image, "n_frames", 1) == 1, "animated PNG is not evidence")
        rgba = image.convert("RGBA")
        pixels = Image.alpha_composite(Image.new("RGBA", image.size, "white"), rgba).convert("RGB")
        nonwhite = colored = blue = 0
        tolerance = 3 if screen else 0
        for red, green, blue_channel in pixels.getdata():
            nonwhite += min(red, green, blue_channel) < 250
            colored += max(red, green, blue_channel) - min(red, green, blue_channel) > tolerance
            blue += blue_channel - red >= 35 and blue_channel - green >= 10
    return {**identity, "width": width, "height": height, "pixels": width * height,
            "nonwhitePixels": nonwhite, "coloredPixels": colored, "bluePixels": blue,
            "channelTolerance": tolerance}


def image_inventory(reader):
    """Count image resources, including nested Forms and inline images.

    Counting resources is intentional: a grayscale cursor would evade the
    color oracle. This fixture contains only DOM text and vector shapes.
    """
    seen = set()
    counts = {"imageXObjects": 0, "inlineImages": 0, "forms": 0}

    def content(stream):
        if stream is None:
            return
        parsed = ContentStream(stream, reader)
        require(len(parsed.get_data()) <= MAX_PDF_BYTES, "PDF content stream limit")
        counts["inlineImages"] += sum(operator == b"INLINE IMAGE" for _, operator in parsed.operations)

    def resources(value, depth=0):
        require(depth <= 32, "PDF resource depth limit")
        if value is None:
            return
        value = value.get_object()
        xobjects = value.get("/XObject", {})
        xobjects = xobjects.get_object() if hasattr(xobjects, "get_object") else xobjects
        for reference in xobjects.values():
            obj = reference.get_object()
            key = (getattr(reference, "idnum", None), getattr(reference, "generation", None))
            if key[0] is None:
                key = ("direct", id(obj))
            if key in seen:
                continue
            seen.add(key)
            require(len(seen) <= 1000, "PDF resource count limit")
            if obj.get("/Subtype") == "/Image":
                counts["imageXObjects"] += 1
            elif obj.get("/Subtype") == "/Form":
                counts["forms"] += 1
                content(obj)
                resources(obj.get("/Resources"), depth + 1)

    for page in reader.pages:
        content(page.get_contents())
        resources(page.get("/Resources"))
    return counts


def render_pdf(path):
    prefix = path.with_name(path.stem + "-page")
    result = subprocess.run(
        ["pdftoppm", "-png", "-r", "96", "-f", "1", "-l", "2", str(path), str(prefix)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, check=False,
    )
    require(result.returncode == 0, "pdftoppm failed")
    return [prefix.with_name(prefix.name + f"-{page}.png") for page in (1, 2)]


def inspect_pdf(path, detail, renderer=render_pdf):
    detail.update(file_identity(path, MAX_PDF_BYTES))
    reader = PdfReader(path, strict=True)
    require(not reader.is_encrypted, "encrypted PDF")
    detail["pageCount"] = len(reader.pages)
    require(len(reader.pages) == 2, "expected exactly two PDF pages")
    detail["pages"] = []
    for index, page in enumerate(reader.pages):
        text = " ".join((page.extract_text() or "").split())
        markers = {marker: marker in text for marker in MARKERS[index]}
        geometry = [float(page.mediabox.width), float(page.mediabox.height)]
        detail["pages"].append({"page": index + 1, "sizePoints": geometry, "markers": markers})
        require(all(markers.values()), f"missing business text on page {index + 1}")
        require(all(abs(actual - expected) < 0.1 for actual, expected in zip(geometry, (600, 750))),
                "unexpected PDF page geometry")
    detail["images"] = image_inventory(reader)
    # Render even when resources contain images: the failed baseline must retain
    # its original visual evidence as well as the image-resource counterexample.
    detail["rasters"] = []
    for path in renderer(path):
        detail["rasters"].append(pixel_summary(path))
    require(len(detail["rasters"]) == 2, "missing rendered page")
    failures = []
    if detail["images"]["imageXObjects"] or detail["images"]["inlineImages"]:
        failures.append("unexpected raster image in DOM-only PDF")
    for index, raster in enumerate(detail["rasters"]):
        if (raster["width"], raster["height"]) != (800, 1000):
            failures.append(f"unexpected raster geometry on page {index + 1}")
        if raster["nonwhitePixels"] < 500:
            failures.append(f"blank or insufficient business rendering on page {index + 1}")
        if raster["coloredPixels"]:
            failures.append(f"colored feedback printed on page {index + 1}")
    require(not failures, "; ".join(failures))


def verify_run(run_dir, renderer=render_pdf):
    report = {"version": 1, "passed": False, "pdfs": {}, "screens": {}, "errors": []}
    for name in ("background", "default"):
        detail = report["pdfs"][name] = {}
        try:
            inspect_pdf(run_dir / f"cursor-print-{name}.pdf", detail, renderer)
            detail["passed"] = True
        except Exception as error:
            detail["passed"] = False
            # Parser exceptions can include input text. Preserve only their
            # class, with fixed oracle explanations for our own validations.
            message = str(error) if isinstance(error, OracleFailure) else type(error).__name__
            report["errors"].append({"artifact": f"cursor-print-{name}.pdf", "error": message})
    for name in ("before", "after"):
        try:
            detail = pixel_summary(run_dir / f"cursor-print-{name}.png", screen=True)
            report["screens"][name] = detail
            require(detail["bluePixels"] >= MIN_BLUE_PIXELS, "screen lacks substantial blue feedback")
            require(detail["nonwhitePixels"] >= 500, "screen lacks business rendering")
            detail["passed"] = True
        except Exception as error:
            report["screens"].setdefault(name, {})["passed"] = False
            message = str(error) if isinstance(error, OracleFailure) else type(error).__name__
            report["errors"].append({"artifact": f"cursor-print-{name}.png", "error": message})
    report["passed"] = not report["errors"]
    (run_dir / "cursor-print-artifacts.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run_dir", type=Path)
    args = parser.parse_args()
    report = verify_run(args.run_dir.resolve())
    print(json.dumps(report))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
