#!/usr/bin/env python3
"""把「分享收录」xlsx 导入 mo 站的资源数据。

xlsx 的样式表在某些 openpyxl 版本下会报错，所以直接解 zip 读 XML，不依赖第三方库。

用法：
    python import_from_xlsx.py "D:\\download\\分享收录 (1).xlsx" --dry-run
    python import_from_xlsx.py "D:\\download\\分享收录 (1).xlsx"

导入的条目 id 带 xlsx- 前缀，重跑会覆盖同前缀条目，其他条目不动。
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

IMPORT_PREFIX = "xlsx-"
HERE = Path(__file__).resolve().parent
DST = HERE / "data" / "items.json"

# 网盘域名 -> 展示名
PAN_NAMES = {
    "pan.baidu.com": "百度网盘",
    "drive.uc.cn": "UC 网盘",
    "pan.quark.cn": "夸克网盘",
    "pan.xunlei.com": "迅雷网盘",
    "www.kdocs.cn": "金山文档",
    "kdocs.cn": "金山文档",
}
# 游戏区白名单：明确无成人内容的工具、网站与通用说明，
# 白名单之外的游戏条目一律标记 adult=True（宁可多标，不可漏标）
GAME_SAFE_KEYWORDS = [
    "ce工具", "终末地基质规划器", "终末地基质小助手", "超卓文本编辑器",
    "steam官网", "steamDB", "外星仔加速器", "Watt Toolkit", "Epic游戏商城",
    "可露希尔小卖部", "视频压缩包解压说明", "单击网盘分享", "末世孤雄",
    "末世装备", "末世孵化", "龙珠之跨维度", "解压查看", "下载后后缀改为",
]


def is_adult_game(name: str) -> bool:
    return not any(k in name for k in GAME_SAFE_KEYWORDS)


def read_sheets(xlsx: Path) -> dict[str, dict[int, dict[str, str]]]:
    """直接解 zip 读工作表，返回 {工作表名: {行号: {列字母: 值}}}。"""
    with zipfile.ZipFile(xlsx) as zf:
        shared: list[str] = []
        if "xl/sharedStrings.xml" in zf.namelist():
            s = zf.read("xl/sharedStrings.xml").decode("utf-8")
            for si in re.findall(r"<si>(.*?)</si>", s, re.S):
                text = "".join(re.findall(r"<t[^>]*>(.*?)</t>", si, re.S))
                shared.append(html.unescape(text))

        wb = zf.read("xl/workbook.xml").decode("utf-8")
        rels = zf.read("xl/_rels/workbook.xml.rels").decode("utf-8")
        rel_map = dict(re.findall(r'Id="(rId\d+)"[^>]*Target="([^"]+)"', rels))

        sheets: dict[str, dict[int, dict[str, str]]] = {}
        for m in re.finditer(
            r'<sheet[^>]*name="([^"]+)"[^>]*r:id="(rId\d+)"', wb
        ):
            name = html.unescape(m.group(1))
            target = rel_map.get(m.group(2), "")
            path = "xl/" + target.lstrip("/")
            if path not in zf.namelist():
                continue
            sheets[name] = parse_sheet(zf.read(path).decode("utf-8"), shared)
        return sheets


def parse_sheet(xml: str, shared: list[str]) -> dict[int, dict[str, str]]:
    rows: dict[int, dict[str, str]] = {}
    for c in re.finditer(r'<c r="([A-Z]+)(\d+)"([^>]*)>(.*?)</c>', xml, re.S):
        col, row, attrs, body = c.group(1), int(c.group(2)), c.group(3), c.group(4)
        typ = re.search(r't="([^"]+)"', attrs)
        typ = typ.group(1) if typ else "n"
        v = re.search(r"<v>(.*?)</v>", body, re.S)
        if typ == "s" and v:
            idx = int(v.group(1))
            val = shared[idx] if idx < len(shared) else ""
        elif typ == "inlineStr":
            val = html.unescape("".join(re.findall(r"<t[^>]*>(.*?)</t>", body, re.S)))
        elif v:
            val = html.unescape(v.group(1))
        else:
            val = ""
        val = val.strip()
        if val:
            rows.setdefault(row, {})[col] = val
    return rows


URL_RE = re.compile(r"https?://[^\s一-鿿]+")
PW_RE = re.compile(r"(?:提取码|密码|pwd)[:：=\s]*([A-Za-z0-9]{4,8})")


def split_link(text: str) -> tuple[str, str]:
    """从一段文本里抽出 URL 和提取码。"""
    url_match = URL_RE.search(text or "")
    url = url_match.group(0).rstrip("#，,。") if url_match else ""
    pw = ""
    pw_match = PW_RE.search(text or "")
    if pw_match:
        pw = pw_match.group(1)
    elif url and "pwd=" in url:
        m = re.search(r"pwd=([A-Za-z0-9]+)", url)
        if m:
            pw = m.group(1)
    return url, pw


def pan_name(url: str) -> str:
    for domain, label in PAN_NAMES.items():
        if domain in url:
            return label
    return "网盘"
def clean_title(text: str) -> str:
    """去掉标题里的 URL 和提取码残留，压掉多余空白。"""
    t = URL_RE.sub("", text or "")
    t = PW_RE.sub("", t)
    t = re.sub(r"[（(]?\s*提取码\s*[:：]?\s*[）)]?", "", t)
    return re.sub(r"\s+", " ", t).strip(" -—·\\/")


def guess_platform_tags(title: str) -> list[str]:
    """从标题里的【PC】【双端】【网站】等标记提取平台标签。"""
    tags = []
    for mark in re.findall(r"[【\[]([^】\]]{1,12})[】\]]", title):
        mark = mark.strip()
        if mark and len(mark) <= 8:
            tags.append(mark)
    return tags[:2]


def make_item(
    idx: int, name: str, url: str, password: str, section: str,
    subsection: str | None, kind: str, note: str = "", extra_tags: list[str] | None = None,
) -> dict:
    tags = list(extra_tags or [])
    if url:
        tags.append(pan_name(url))
    item = {
        "id": f"{IMPORT_PREFIX}{section}-{idx}",
        "name": name[:80],
        "section": section,
        "description": note or name[:100],
        "url": url,
        "tags": tags[:6],
        "kind": kind,
        "need_login": False,
        "update_info": "网盘分享",
        "note": "",
    }
    if subsection:
        item["subsection"] = subsection
    if password:
        item["password"] = password
    return item


def import_novel_sheet(rows: dict[int, dict[str, str]]) -> list[dict]:
    """小说表。

    表格结构不太规整：
      - 开头几行是通用入口（网盘合集、教程），归到「收录」分区
      - 遇到 A 列写着「韩轻」的标记行后，下面是韩轻作品
      - 有的行标题在 A 列、链接在 B 列；有的行标题在上一行 B 列、链接在本行 B 列
    所以按「先收集标题，遇到链接就配对」的方式处理。
    """
    items: list[dict] = []
    section, subsection = "collection", None
    pending_title = ""
    seq = 0

    marker_map = {
        "韩轻": ("novel", "kr"),
        "日轻": ("novel", "jp"),
        "韩漫": ("manga", "kr"),
        "日漫": ("manga", "jp"),
        "漫画": ("manga", None),
        "动画": ("anime", None),
    }

    for row in sorted(rows):
        cells = rows[row]
        a, b = cells.get("A", ""), cells.get("B", "")

        # 分区标记行
        if a.strip() in marker_map and not URL_RE.search(a):
            section, subsection = marker_map[a.strip()]
            pending_title = clean_title(b) if b and not URL_RE.search(b) else ""
            continue

        # 找出这一行的链接与标题
        joined = f"{a} {b}"
        url, password = split_link(joined)
        title_src = a if a and not URL_RE.search(a) else ""
        title = clean_title(title_src)

        if not url:
            # 纯文字行：可能是下一条的标题，也可能是说明文字
            if title:
                pending_title = title
            continue

        name = title or pending_title
        pending_title = ""
        if not name:
            continue

        seq += 1
        kind = "网盘资源"
        if section == "collection":
            kind = "合集入口"
        items.append(
            make_item(
                seq, name, url, password, section, subsection, kind,
                extra_tags=guess_platform_tags(name),
            )
        )

    return items
def import_game_sheet(rows: dict[int, dict[str, str]]) -> list[dict]:
    """游戏表：链接和标题散落在 B/C/D/E 列，取该行第一个 URL 和最长的非 URL 文本。"""
    items: list[dict] = []
    seq = 0

    for row in sorted(rows):
        cells = rows[row]
        values = [cells.get(c, "") for c in ("A", "B", "C", "D", "E", "F")]
        joined = " ".join(v for v in values if v)

        url, password = split_link(joined)
        if not url:
            continue

        # 标题取该行最长的非 URL 文本
        candidates = [clean_title(v) for v in values if v and not URL_RE.match(v.strip())]
        candidates = [c for c in candidates if len(c) > 4 and not c.lower().startswith("http")]
        name = max(candidates, key=len) if candidates else ""
        if not name:
            continue

        seq += 1
        item = make_item(
            seq, name, url, password, "game", None, "游戏资源",
            extra_tags=guess_platform_tags(name),
        )
        if is_adult_game(name):
            item["adult"] = True
        items.append(item)

    return items


def load_dst() -> dict:
    if not DST.exists():
        sys.exit(f"找不到 {DST}")
    with DST.open(encoding="utf-8") as fh:
        return json.load(fh)


def main() -> int:
    ap = argparse.ArgumentParser(description="从 xlsx 导入资源到 mo 站")
    ap.add_argument("xlsx", help="xlsx 文件路径")
    ap.add_argument("--dry-run", action="store_true", help="只预览，不写文件")
    args = ap.parse_args()

    xlsx = Path(args.xlsx)
    if not xlsx.exists():
        sys.exit(f"找不到文件：{xlsx}")

    sheets = read_sheets(xlsx)
    print("工作表：" + "、".join(f"{k}({len(v)}行)" for k, v in sheets.items()))

    new_items: list[dict] = []
    for name, rows in sheets.items():
        if "游戏" in name or "游戲" in name:
            got = import_game_sheet(rows)
        else:
            got = import_novel_sheet(rows)
        print(f"  [{name}] 解析出 {len(got)} 条")
        new_items.extend(got)

    # id 去重，保留先出现的
    seen, deduped = set(), []
    for it in new_items:
        if it["id"] in seen:
            continue
        seen.add(it["id"])
        deduped.append(it)
    new_items = deduped
    from collections import Counter
    dist = Counter(
        (it["section"], it.get("subsection") or "-") for it in new_items
    )
    print("\n分区分布：")
    for (sec, sub), n in sorted(dist.items()):
        print(f"  {sec}/{sub}: {n}")

    dst = load_dst()
    kept = [
        it for it in (dst.get("items") or [])
        if not str(it.get("id", "")).startswith(IMPORT_PREFIX)
    ]
    old_imported = len(dst.get("items", [])) - len(kept)
    print(f"\n原有导入条目 {old_imported} 条将被替换，其他 {len(kept)} 条保留")

    if args.dry_run:
        print("\n前 8 条预览：")
        for it in new_items[:8]:
            pw = f" 提取码={it['password']}" if it.get("password") else ""
            print(f"  [{it['section']}/{it.get('subsection','-')}] {it['name'][:44]}{pw}")
        print("\n--dry-run：未写入文件")
        return 0

    dst["items"] = kept + new_items
    dst["generated_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    tmp = DST.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(dst, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    tmp.replace(DST)

    print(f"\n已写入 {DST.name}，共 {len(dst['items'])} 条")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())





