import worker, { _internal } from "./index.js";

const ORIGIN = "https://xrzka.github.io";
let failures = 0;
const check = (name, ok, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};
const request = (path) => new Request(`https://worker.test${path}`, {
  headers: { Origin: ORIGIN, "CF-Connecting-IP": "1.2.3.4" },
});
const call = async (path) => {
  const response = await worker.fetch(request(path), { DB: {} });
  const data = await response.json();
  return { status: response.status, data };
};

console.log("\n--- 观看区纯函数 ---");
check("搜索词清除控制字符", _internal.watchText(" 海\n贼\x00王 ") === "海 贼 王");
check("漫画章节从嵌套结构提取", JSON.stringify(_internal.mangaGroups({
  chapter_groups: [{ chapters: [{ chapter_id: 12 }, { id: "13" }] }],
})) === JSON.stringify(["12", "13"]));
check("漫画章节不再生成假 default", _internal.mangaGroups({ chapter_groups: [] }).length === 0);
const goodImage = _internal.mangaImageUrl("/book/a.webp");
check("漫画相对图片转成代理 URL", goodImage.startsWith("/api/watch/asset?kind=manga&url="), goodImage);
check("漫画图片拒绝非白名单域名", _internal.mangaImageUrl("https://evil.example/a.jpg") === "");

console.log("\n--- 小说与动画解析 ---");
const novelHtml = `<li class="book-li"><a href="/novel/123.html"><img data-src="/cover.jpg"><span class="book-title">测试小说</span></a></li>`;
const novels = _internal.parseNovelCards(novelHtml, "https://tw.linovelib.com");
check("小说卡片提取 id 与标题", novels[0]?.id === "123" && novels[0]?.title === "测试小说", JSON.stringify(novels));
check("小说封面经过本站代理", novels[0]?.cover?.startsWith("/api/watch/asset?kind=novel&url="), novels[0]?.cover);
const animeHtml = `<div><img data-original="/poster.jpg"><span class="title"><a href="/detail/88.html">测试动画</a></span></div>`;
const anime = _internal.parseAnimeCards(animeHtml, "https://www.lmm85.com");
check("动画卡片提取并代理封面", anime[0]?.id === "88" && anime[0]?.cover?.includes("kind=anime"), JSON.stringify(anime));

const chapter = _internal.parseNovelChapter(
  `<h1 class="chapter-title">第一章</h1><article class="read-content">` +
    `<p>第一段正文</p><img src="/images/page.jpg"><p>第二段正文</p></article>`,
  "https://www.bilinovel.com", "123", "456"
);
check("小说正文提取段落与图片", chapter.blocks.length === 3, JSON.stringify(chapter));
check("小说镜像图片使用实际来源", decodeURIComponent(chapter.blocks[1]?.src || "").includes("www.bilinovel.com/images/page.jpg"), chapter.blocks[1]?.src);

const episodes = _internal.parseAnimeEpisodes(
  `<a href="/play/88_1_1.html">第 1 集</a><a href="/play/88_1_1.html">重复</a>` +
  `<a href="/play/88_1_2.html">第 2 集</a>`
);
check("动画选集提取并去重", episodes.length === 2 && episodes[1]?.id === "88_1_2", JSON.stringify(episodes));
check("动画播放器拒绝任意外站", _internal.animeEmbedUrl("https://evil.example/player") === "");
check("动画播放器允许固定域名", _internal.animeEmbedUrl("http://yun.92cj.com/player") === "https://yun.92cj.com/player");
const player = _internal.parseAnimePlayer(
  `<script>var player_aaaa={"from":"vxdev","url":"abc123"};</script>`,
  "https://www.lmm85.com", "88_1_1"
);
check("动画原生播放数据生成白名单播放器", player.startsWith("https://yun.92cj.com/yunbox/"), player);

console.log("\n--- 漫画完整接口链路 ---");
const originalFetch = globalThis.fetch;
let firstHomeFailed = false;
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  if (url.hostname === "crm.weichu.asia" && url.pathname.endsWith("/home/data")) {
    firstHomeFailed = true;
    throw new Error("mirror offline");
  }
  if (url.pathname.endsWith("/home/data")) return Response.json({ code: 200, data: {
    home_content_list: [{ comic_list: [{ id: 7, name: "测试漫画", picY: "/cover/7.jpg" }] }],
  }});
  if (url.pathname.endsWith("/search/suggest")) return Response.json({ code: 200, data: {
    search_suggest: [{ comic_id: 8, comic_name: "搜索漫画", pic: "https://cf-1.imgio.club/8.jpg" }],
  }});
  if (url.pathname.endsWith("/detail/7")) return Response.json({ code: 200, data: {
    id: 7, name: "测试漫画", chapter_groups: [{ chapters: [{ chapter_id: 701 }, { id: 702, name: "第二话" }] }],
  }});
  if (url.pathname.endsWith("/chapter/v2/701")) return Response.json({ code: 201, data: {
    name: "第一话", pics: ["/pages/1.jpg", "https://evil.example/2.jpg"],
  }});
  throw new Error(`unexpected upstream: ${url}`);
};
try {
  let result = await call("/api/watch/manga?action=list");
  check("漫画首页首线路失败后自动切镜像", result.status === 200 && firstHomeFailed, String(result.status));
  check("漫画首页返回可点击卡片", result.data.items[0]?.id === "7", JSON.stringify(result.data));

  result = await call("/api/watch/manga?action=list&q=%E6%B5%8B%E8%AF%95");
  check("漫画搜索返回结果", result.status === 200 && result.data.items[0]?.id === "8", JSON.stringify(result.data));

  result = await call("/api/watch/manga?action=detail&comic=7");
  check("详情兼容嵌套章节结构", JSON.stringify(result.data.chapters?.map((x) => x.id)) === JSON.stringify(["701", "702"]), JSON.stringify(result.data));

  result = await call("/api/watch/manga?action=chapter&comic=7&chapter=701");
  check("章节只保留白名单图片", result.status === 200 && result.data.images.length === 1, JSON.stringify(result.data));
  check("章节图片使用代理链路", result.data.images[0]?.startsWith("/api/watch/asset?kind=manga&url="), result.data.images[0]);

  result = await call("/api/watch/manga?action=detail&comic=bad");
  check("非法漫画 id 被拒绝", result.status === 400, String(result.status));

  result = await call("/api/watch/asset?kind=manga&url=https%3A%2F%2Fevil.example%2Fx.jpg");
  check("资源代理拦截非白名单 URL", result.status === 403, String(result.status));
} finally {
  globalThis.fetch = originalFetch;
}

console.log(failures ? `\n${failures} 项失败` : "\n全部通过");
process.exit(failures ? 1 : 0);
