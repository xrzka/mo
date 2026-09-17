# -*- coding: utf-8 -*-
"""RapidOCR 本地识别 cs/ 截图，逐图输出到 cs/_ocr_<name>.txt"""
import sys
from pathlib import Path
from rapidocr_onnxruntime import RapidOCR

engine = RapidOCR()
cs_dir = Path(r"D:\local_translate_tool\mo_site\cs")
for p in sorted(cs_dir.glob("cs-skl-*.jpg")):
    result, _ = engine(str(p))
    lines = [str(item[1]).strip() for item in (result or []) if len(str(item[1]).strip()) > 0]
    out = p.parent / ("_ocr_" + p.stem + ".txt")
    out.write_text("\n".join(lines), encoding="utf-8")
    print("==", p.name, "lines=", len(lines))
