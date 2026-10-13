"""Synthetic parser/render oracle tests; these do not run a browser."""

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

from PIL import Image, ImageDraw
from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, NumberObject, DecodedStreamObject


SPEC = importlib.util.spec_from_file_location("cursor_print_artifacts", Path(__file__).with_name("cursor-print-artifacts.py"))
ORACLE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ORACLE)


def pdf(path, *, missing_text=False, image=False, color=False):
    writer = PdfWriter()
    font = writer._add_object(DictionaryObject({NameObject("/Type"): NameObject("/Font"),
        NameObject("/Subtype"): NameObject("/Type1"), NameObject("/BaseFont"): NameObject("/Helvetica")}))
    for index in range(2):
        page = writer.add_blank_page(600, 750)
        resources = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})})
        text = " ".join(ORACLE.MARKERS[index]) if not missing_text else "Unrelated document"
        stream = DecodedStreamObject()
        fill = "0.3 0.5 1 rg" if color else "0.5 g"
        stream.set_data(f"{fill} 30 30 300 60 re f 0 g BT /F1 12 Tf 30 700 Td ({text}) Tj ET".encode())
        page[NameObject("/Contents")] = writer._add_object(stream)
        if image:
            # A nested grayscale image is invisible to a color-only oracle.
            raster = DecodedStreamObject()
            raster.update({NameObject("/Type"): NameObject("/XObject"), NameObject("/Subtype"): NameObject("/Image"),
                NameObject("/Width"): NumberObject(1), NameObject("/Height"): NumberObject(1),
                NameObject("/ColorSpace"): NameObject("/DeviceGray"), NameObject("/BitsPerComponent"): NumberObject(8)})
            raster.set_data(b"\x00")
            form = DecodedStreamObject()
            form.update({NameObject("/Subtype"): NameObject("/Form"),
                NameObject("/Resources"): DictionaryObject({NameObject("/XObject"): DictionaryObject({NameObject("/Cursor"): writer._add_object(raster)})})})
            form.set_data(b"")
            resources[NameObject("/XObject")] = DictionaryObject({NameObject("/Nested"): writer._add_object(form)})
        page[NameObject("/Resources")] = resources
    with path.open("wb") as output:
        writer.write(output)


def screenshot(path, color=True):
    image = Image.new("RGB", (800, 1000), "white")
    ImageDraw.Draw(image).rectangle((40, 40, 400, 120), fill=(79, 140, 255) if color else (100, 100, 100))
    image.save(path)


class CursorPrintArtifactsTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        for name in ("background", "default"):
            pdf(self.root / f"cursor-print-{name}.pdf")
        for name in ("before", "after"):
            screenshot(self.root / f"cursor-print-{name}.png")

    def test_actual_poppler_positive_repeat_preserves_inputs(self):
        originals = {path: path.read_bytes() for path in self.root.iterdir()}
        first = ORACLE.verify_run(self.root)
        second = ORACLE.verify_run(self.root)
        self.assertTrue(first["passed"], first["errors"])
        self.assertEqual(first, second)
        self.assertEqual({path: path.read_bytes() for path in originals}, originals)
        self.assertTrue((self.root / "cursor-print-default-page-2.png").exists())

    def test_grayscale_image_nested_in_form_fails_and_retains_rasters(self):
        pdf(self.root / "cursor-print-background.pdf", image=True)
        result = ORACLE.verify_run(self.root)
        self.assertFalse(result["passed"])
        self.assertEqual(result["pdfs"]["background"]["images"]["imageXObjects"], 2)
        self.assertEqual(len(result["pdfs"]["background"]["rasters"]), 2)

    def test_colored_pdf_fails_even_when_text_and_page_count_match(self):
        pdf(self.root / "cursor-print-default.pdf", color=True)
        result = ORACLE.verify_run(self.root)
        self.assertFalse(result["passed"])
        self.assertGreater(result["pdfs"]["default"]["rasters"][0]["coloredPixels"], 100)

    def test_wrong_business_text_and_no_screen_feedback_do_not_pass(self):
        pdf(self.root / "cursor-print-default.pdf", missing_text=True)
        screenshot(self.root / "cursor-print-after.png", color=False)
        result = ORACLE.verify_run(self.root)
        self.assertFalse(result["passed"])
        self.assertEqual(len(result["errors"]), 2)
        saved = json.loads((self.root / "cursor-print-artifacts.json").read_text())
        self.assertEqual(saved, result)

    def test_blank_renderer_output_cannot_pass_with_good_text_metadata(self):
        def blank_renderer(path):
            paths = [path.with_name(path.stem + f"-page-{index}.png") for index in (1, 2)]
            for image_path in paths:
                Image.new("RGB", (800, 1000), "white").save(image_path)
            return paths
        result = ORACLE.verify_run(self.root, blank_renderer)
        self.assertFalse(result["passed"])
        self.assertTrue(all("blank" in error["error"] for error in result["errors"]))


if __name__ == "__main__":
    unittest.main()
