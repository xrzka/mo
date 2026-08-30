#!/usr/bin/env python3
"""把中转站榜单站的数据同步到墨小说漫画站的 AI 分区。

榜单站 (relay_board_site/data/resources.json) 是唯一数据源；
本脚本把它转成 mo 站的资源卡片结构，覆盖 AI 分区里由同步生成的条目，
其他分区和手工添加的 AI 条目都不动。

用法：
    python sync_ai_section.py            # 同步
    python sync_ai_section.py --dry-run  # 只看会改什么，不写文件
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

# 同步生成的条目统一带这个 id 前缀，据此识别哪些该被覆盖
SYNC_PREFIX = "relay-"

HERE = Path(__file__).resolve().parent
SRC = HERE.parent / "relay_board_site" / "data" / "resources.json"
DST = HERE / "data" / "items.json"
def currency_symbol(code: str | None) -> str:
    return {"USD": "$", "CNY": "¥"}.get(code or "", "")


def build_tags(relay: dict) -> list[str]:
    """把额度、签到、倍率、网络与账号要求压成短标签，卡片上最多显示 6 个。"""
    quota: list[str] = []   # 额度类：注册送 / 签到 / 倍率 / 免费站卖点
    limits: list[str] = []  # 门槛类：需代理 / GitHub 年限 / 使用禁忌
    cur = currency_symbol(relay.get("bonus_currency"))
    benefits = relay.get("benefit_flags") or []

    register_bonus = relay.get("register_bonus")
    checkin_bonus = relay.get("checkin_bonus")

    if register_bonus:
        quota.append(f"注册送{cur}{register_bonus}")
    if checkin_bonus:
        quota.append(f"签到{cur}{checkin_bonus}")
    elif "checkin" in benefits:
        # 支持签到但没给具体额度
        quota.append("可签到")

    multiplier = relay.get("displayed_multiplier")
    if isinstance(multiplier, (int, float)) and multiplier > 0:
        quota.append(f"倍率{multiplier:g}")

    if relay.get("direct_connect") is False:
        limits.append("需代理")
    if relay.get("github_age_required"):
        limits.append("GitHub 满一年")
    # 使用禁忌（如「严禁多号」）也属于门槛，必须出现在卡片上
    caveat_tag = relay.get("caveat_tag")
    if caveat_tag:
        limits.append(str(caveat_tag))

    # 没有额度信息的站（纯免费站）拿榜单站自带的标签当主描述。
    # 注意不能只在 quota+limits 都空时才回退 —— 免费站往往也需要代理，
    # 那样标签就只剩一个「需代理」，站点的实际卖点全丢了。
    if not quota:
        site_tags = [str(t) for t in (relay.get("site_tags") or []) if t]
        # 榜单站的标签里可能已经写了「需代理」，去重避免重复显示
        site_tags = [t for t in site_tags if t not in limits]
        quota = site_tags or ["免费使用"]

    return (quota + limits)[:6]


def build_note(relay: dict) -> str:
    """备注里放使用前必须知道的信息：账号门槛、网络限制、使用禁忌、可用模型。"""
    parts: list[str] = []

    age = relay.get("github_age_required")
    if age:
        parts.append(f"GitHub 账号需注册满{age}。")
    if relay.get("direct_connect") is False:
        parts.append("该站无法直连，需自备网络代理。")
    # 禁忌放在模型清单之前 —— 违规的后果是封号，比能用什么模型更要紧
    caveat = relay.get("caveat")
    if caveat:
        parts.append(str(caveat))

    models = [
        m.get("display_name") or m.get("model_id")
        for m in (relay.get("models") or [])
        if isinstance(m, dict)
    ]
    models = [m for m in models if m]
    if models:
        parts.append("可用模型：" + "、".join(models) + "。")

    return " ".join(parts)
def to_mo_item(relay: dict) -> dict:
    """榜单站条目 -> mo 站资源卡片。"""
    benefits = relay.get("benefit_flags") or []
    has_checkin = bool(relay.get("checkin_bonus")) or "checkin" in benefits

    if has_checkin:
        update_info = "每日可签到"
    elif relay.get("availability"):
        update_info = str(relay["availability"])
    elif relay.get("consumer_category") == "free":
        # 免费站多数是「看官方免费活动不定时开放」，除非数据里另有说明
        update_info = "不定时开放"
    else:
        update_info = "注册即用"

    return {
        "id": SYNC_PREFIX + str(relay.get("resource_id", "")),
        "name": relay.get("resource_name") or "未命名站点",
        "section": "ai",
        "description": relay.get("description") or relay.get("resource_description") or "",
        "url": relay.get("site_url") or "",
        "tags": build_tags(relay),
        # 免登录的在线工具不是中转站，写成中转站会误导
        "kind": relay.get("site_kind") or "AI API 中转站",
        # 默认要账号（中转站都要），数据里显式写 false 才当免登录
        "need_login": relay.get("requires_account") is not False,
        "update_info": update_info,
        "note": build_note(relay),
    }


def load_json(path: Path) -> dict:
    if not path.exists():
        sys.exit(f"找不到文件：{path}")
    try:
        with path.open(encoding="utf-8") as fh:
            return json.load(fh)
    except json.JSONDecodeError as exc:
        sys.exit(f"{path.name} 不是合法 JSON：{exc}")


def sync(dry_run: bool = False) -> int:
    src = load_json(SRC)
    dst = load_json(DST)

    relay_items = src.get("items") or []
    if not relay_items:
        sys.exit("榜单站数据为空，已中止（避免误清空 AI 分区）")

    new_ai = [to_mo_item(r) for r in relay_items]

    # 保留：非 AI 分区的全部条目 + AI 分区里手工添加的条目（id 不带同步前缀）
    kept = [
        item
        for item in (dst.get("items") or [])
        if item.get("section") != "ai" or not str(item.get("id", "")).startswith(SYNC_PREFIX)
    ]
    old_synced = [
        item
        for item in (dst.get("items") or [])
        if item.get("section") == "ai" and str(item.get("id", "")).startswith(SYNC_PREFIX)
    ]
    old_ids = {item.get("id") for item in old_synced}
    new_ids = {item.get("id") for item in new_ai}
    added = [i["name"] for i in new_ai if i["id"] not in old_ids]
    removed = [i.get("name") for i in old_synced if i.get("id") not in new_ids]

    # 变更明细：同名条目逐字段比对，只报真正变了的字段
    old_by_id = {i.get("id"): i for i in old_synced}
    changed: list[str] = []
    for item in new_ai:
        old = old_by_id.get(item["id"])
        if not old:
            continue
        diffs = [k for k in item if k != "id" and old.get(k) != item[k]]
        if diffs:
            changed.append(f"{item['name']}（{', '.join(diffs)}）")

    print(f"数据源：{SRC.name} — {len(relay_items)} 个站点")
    print(f"目标：{DST.name} — AI 分区原有同步条目 {len(old_synced)} 条")
    print(f"保留未动：{len(kept)} 条（其他分区 + 手工添加的 AI 条目）")
    if added:
        print("  新增：" + "、".join(added))
    if removed:
        print("  移除：" + "、".join(str(r) for r in removed))
    if changed:
        print("  更新：" + "；".join(changed))
    if not (added or removed or changed):
        print("  无变化")

    if dry_run:
        print("\n--dry-run：未写入文件")
        return 0

    dst["items"] = kept + new_ai
    dst["generated_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    # 先写临时文件再替换，避免中途出错把目标文件写坏
    tmp = DST.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(dst, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    tmp.replace(DST)

    print(f"\n已写入 {DST.name}，共 {len(dst['items'])} 条")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="同步中转站榜单到 mo 站 AI 分区")
    parser.add_argument("--dry-run", action="store_true", help="只显示变更，不写文件")
    args = parser.parse_args()
    return sync(dry_run=args.dry_run)


if __name__ == "__main__":
    raise SystemExit(main())




