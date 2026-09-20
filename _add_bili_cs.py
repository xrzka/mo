# -*- coding: utf-8 -*-
"""
Download Bilibili opus images and add a CS entry to items.json
"""
import json
import re
from pathlib import Path

# Bilibili article images (full-size URLs extracted from HTML)
IMAGE_URLS = [
    "https://i0.hdslb.com/bfs/new_dyn/a06f0759b58376f04c785687411ce58810521989.jpg",
    "https://i0.hdslb.com/bfs/new_dyn/dde44a7a203be44986590d7b2a808fc710521989.jpg",
    "https://i0.hdslb.com/bfs/new_dyn/865ad19c1b305b500617a525dcf37c0710521989.jpg",
]

# Image filenames for cs/ directory
IMAGE_FILES = ["cs-bilibili-japan-scam-1.jpg", "cs-bilibili-japan-scam-2.jpg", "cs-bilibili-japan-scam-3.jpg"]

# New CS entry data
NEW_ENTRY = {
    "id": "cs-bili-2",
    "name": "B站动态：日本「秋田大叔」诈骗犯事件（农夫与蛇）",
    "section": "cs",
    "description": "2026年9月16日 B站动态：华人在日本遇到自称被骗的大叔，好心帮忙给了1万日元路费，结果发现是当地著名诈骗犯，专门假冒求职被骗者利用他人同情心行骗。",
    "tags": ["挂人", "日本", "诈骗", "农夫与蛇", "避雷"],
    "kind": "挂人 / 社会事件",
    "need_login": False,
    "update_info": "长期",
    "note": "【事件经过】\n1. 有华人大哥在日本工作期间，遇到自称被黑厂坑骗的秋田口音大叔\n2. 大叔说找工作被骗、政府和警察不管、吃不上饭，拿着手机不知所措急得哭了\n3. 大哥心善，给大叔买了饭，问下一步打算，大叔说想回家但只有300日元不够火车票钱\n4. 大哥取了一万日元给他，大叔说只要8750就够了，大哥说剩下路上买食物，两人就此别过\n5. 大哥在朋友圈记录这段经历，感慨日本右翼执政下连小老百姓生活都守护不住\n\n【反转】\n这段后来被转到社交媒体，网友指出这是日本当地有名的诈骗犯，专门假冒求职被坑骗的被害者，利用人的同情心。不光这位华人大哥，许多日本人都受害过，甚至专门开了帖子交流被骗经历。\n\n【文章核心观点】\n如果到此为止，就是标准的「意林体」故事：不作为的政府、可怜的旅人、善良的居民，一切都很美好。但反转来了——这是诈骗犯利用同情心行骗。农夫与蛇的故事会一遍遍上演。\n\n【避坑建议】\n1. 善心要有底线：对陌生人施助前，先验证对方说法是否属实，可以通过多途径核实\n2. 警惕「卖惨」套路：哭诉、急迫、金额刚好够回家的，都是经典诈骗起手式\n3. 不要私下给现金：真想帮可以替对方叫车、买票、联系领事馆，而不是直接转账或给现金\n4. 日本针对华人的「求职骗局」要特别警惕：冒充秋田口音、声称黑厂被骗、急需路费回国——都是已知话术\n5. 已受骗怎么办：保留证据（聊天记录、转账凭证），向当地警方报案并联系中国驻日使领馆",
    "images": [
        "cs/cs-bili-2-1.jpg",
        "cs/cs-bili-2-2.jpg",
        "cs/cs-bili-2-3.jpg"
    ]
}

def main():
    base = Path(r"D:\local_translate_tool\mo_site")
    cs_dir = base / "cs"
    cs_dir.mkdir(parents=True, exist_ok=True)
    
    # Download images using requests
    import requests
    for url, out_name in zip(IMAGE_URLS, IMAGE_FILES):
        out_path = cs_dir / out_name
        print(f"Downloading {url} -> {out_path}")
        try:
            resp = requests.get(url, timeout=30, stream=True)
            resp.raise_for_status()
            with open(out_path, "wb") as f:
                for chunk in resp.iter_content(chunk_size=8192):
                    if chunk:
                        f.write(chunk)
            print(f"  OK: {out_path.stat().st_size} bytes")
        except Exception as e:
            print(f"  FAILED: {e}")
    
    # Update items.json
    items_path = base / "data" / "items.json"
    with open(items_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    
    # Append new entry at end of items array
    data["items"].append(NEW_ENTRY)
    
    # Write back with proper formatting
    with open(items_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    
    print(f"\nUpdated items.json: total items = {len(data['items'])}")
    
    # Bump cache-buster in index.html if needed
    index_path = base / "index.html"
    content = index_path.read_text(encoding="utf-8")
    # Update timestamp or version
    # Check if version marker exists
    m = re.search(r'[?&]v=(\d+[a-zA-Z])', content)
    if m:
        old_v = m.group(1)
        # Bump letter
        new_v = old_v[:-1] + chr(ord(old_v[-1]) + 1) if old_v[-1].isalpha() else old_v + "a"
        content = content.replace(f"?v={old_v}", f"?v={new_v}")
        print(f"Bumped cache-buster: {old_v} -> {new_v}")
        index_path.write_text(content, encoding="utf-8")
    else:
        print("No cache-buster found in index.html")
    
    print("\nDone! New CS entry: cs-bili-2")

if __name__ == "__main__":
    main()
