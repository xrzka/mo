import { handle as handleBoardAdmin } from "./board_admin.js";

/**
 * 墨小说漫画 —— 点击 / 访问统计 + 资源帮找与失效反馈后端（Cloudflare Worker + D1）。
 *
 * 统计接口：
 *   GET  /api/stats  返回各周期 Top N 点击数 + 访问人数
 *   POST /api/hit    {"id":"资源id"}  点击 +1
 *   POST /api/visit  {}               当天访问人数 +1（按访客指纹去重）
 *
 * 反馈接口（requests 表，用 kind 区分两类）：
 *   GET  /api/requests             列出，可带 ?kind=want|broken&status=...
 *   POST /api/requests             kind=want   {"title":"作品名","note":"..."}
 *                                  kind=broken {"item_id":"站内条目id","note":"..."}
 *   POST /api/requests/vote        {"id":123}  +1（按指纹去重）
 *
 * 设计取舍：
 * - 用 D1 而不是 KV。计数是读改写，KV 最终一致会丢数；D1 的
 *   INSERT ... ON CONFLICT DO UPDATE n = n + 1 是原子的。
 * - 访客不写 IP，只存 IP+UA+日期 的 SHA-256 前 32 位。日期当盐，
 *   跨天无法关联同一访客，也无法反查 IP。
 * - 统计接口没有鉴权，因为它只能让计数变大，读不到隐私数据。
 *   反馈接口能写入任意文本，所以额外加了长度上限、每日条数上限和
 *   控制字符过滤，见 REQ_* 常量与 sanitizeText()。
 */

const PERIODS = ["day", "week", "month", "year", "all"];
const RANK_LIMIT = 20;

/** 允许跨域访问的站点。部署时改成你自己的域名。 */
const ALLOWED_ORIGINS = ["https://xrzka.github.io"];

/** 单个 IP 每分钟最多多少次写入，挡掉刷榜脚本。 */
const RATE_LIMIT = 60;

/** 资源 id 白名单字符集，防止任意字符串灌进表里把库撑大。 */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/* ---------- 资源帮找 / 失效反馈的约束 ---------- */

/** 作品名与补充说明的长度上限，按字符数算（中文一个字算 1）。 */
const REQ_TITLE_MAX = 60;
const REQ_NOTE_MAX = 300;

/** 列表一次最多返回多少条。 */
const REQ_PAGE_MAX = 100;

/** 同一访客每天最多提交几条，防止刷屏。两种 kind 分别计数。 */
const REQ_PER_DAY = 5;

/** 库里最多保留多少条待处理，满了拒绝新增而不是无限膨胀。 */
const REQ_OPEN_MAX = 500;

/** 两种请求类型：want 想要没有的资源，broken 报告站内资源失效。 */
const REQ_KINDS = ["want", "broken"];

/* ---------- 管理员编辑的约束 ---------- */

/**
 * 可以被覆盖的字段。
 *
 * **故意不含 id** —— 点击数（clicks.item）与失效反馈（requests.item_id）都以
 * id 为键，改了等于把这条已有的统计和反馈全丢掉。
 *
 * placements 是分区归属（可多选，见 parsePlacements）。
 * section / subsection 是它的单值旧形式，保留是为了兼容已有的覆盖行 ——
 * 新的保存一律走 placements。
 */
const OVERRIDE_FIELDS = [
  "name", "description", "url", "password", "note",
  "section", "subsection", "placements", "deleted",
];

/** 各字段长度上限（按字符数，中文算 1）。 */
const OVERRIDE_MAX = {
  name: 120,
  description: 400,
  url: 500,
  password: 40,
  note: 1000,
  section: 32,
  subsection: 32,
  placements: 300,
  deleted: 1,
};

/**
 * 分区与小分区白名单。**必须与 app.js 的 SECTIONS 保持一致** ——
 * 不一致的话，这里放行的值到前端会被 normalize() 当成无效丢弃，
 * 表现为「保存成功但分区没变」。test_sections.mjs 专门盯这件事。
 *
 * 空数组表示该分区没有小分区。
 */
const SECTION_SUBS = {
  novel: ["site", "app", "download", "kr", "jp"],
  manga: ["site", "app", "wechat", "download", "kr", "jp"],
  anime: ["site", "app"],
  watch: ["music", "manga", "anime", "novel"],
  game: ["site", "app", "gal"],
  music: ["site", "app", "download"],
  study: ["course", "video", "doc"],
  tool: [],
  ai: ["relay", "image", "tool"],
  forum: [],
  guide: [],
  collection: ["site", "app", "cloud", "doc", "guide"],
};

/** 一条资源最多挂几个「分区/小分区」位置。够用且防手滑 ——
 *  挂满十几个分区的资源等于没分类。 */
const PLACEMENT_MAX = 8;

/**
 * 解析分区归属串。格式 `novel:jp,novel:download,manga:kr,tool`，逗号分隔，
 * 冒号后是小分区（可省略表示只落在该分区的「全部」里）。
 *
 * 为什么用一个字符串而不是几列：一条资源可以挂在任意多个位置，
 * 列数固定的表存不下；存 JSON 又要额外防注入和形状校验。
 * 这个格式扁平、好校验、出问题时肉眼能读。
 *
 * **同一分区可以出现多次，只要小分区不同** —— 一个网盘包既算「下载」又算
 * 「日轻」是真实需求。去重的是完整的「分区:小分区」对，不是分区本身。
 * 但同一分区不能既指定小分区又留空（`novel,novel:jp`）：留空意味着
 * 「落在该区的全部里」，已经被具体小分区那条涵盖了，留着只会让计数翻倍。
 *
 * 第一个是主归属，决定卡片默认显示哪个标签。
 *
 * 返回 { ok: true, value } 或 { ok: false, error }。
 */
function parsePlacements(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: true, value: "" };   // 空串 = 不指定，用原值

  const parts = text.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length > PLACEMENT_MAX) {
    return { ok: false, error: `最多只能挂 ${PLACEMENT_MAX} 个位置` };
  }

  const out = [];
  const seen = new Set();        // 完整的 'sec:sub' 对
  const bareSections = new Set(); // 只写了分区、没指定小分区的
  const withSub = new Set();      // 指定过小分区的分区
  for (const part of parts) {
    const [rawSec, rawSub = ""] = part.split(":");
    const sec = rawSec.trim();
    const sub = rawSub.trim();

    if (!(sec in SECTION_SUBS)) return { ok: false, error: `未知分区：${sec}` };
    if (sub && !SECTION_SUBS[sec].includes(sub)) {
      return { ok: false, error: `「${sec}」下没有小分区「${sub}」` };
    }
    const key = sub ? `${sec}:${sub}` : sec;
    if (seen.has(key)) continue;   // 完全相同的一对，静默取第一个
    seen.add(key);
    if (sub) withSub.add(sec);
    else bareSections.add(sec);
    out.push(key);
  }

  // 同区「留空」与「具体小分区」并存时，丢掉留空那条 —— 它是前者的超集，
  // 同时留着会让这条资源在该区的列表里出现两次。
  const redundant = [...bareSections].filter((s) => withSub.has(s));
  const final = redundant.length
    ? out.filter((k) => !redundant.includes(k))
    : out;

  if (!final.length) return { ok: false, error: "至少要选一个分区" };
  return { ok: true, value: final.join(",") };
}

/** 新增条目的 id 前缀。挑 custom- 是因为现有 id 都是
 *  manual- / xlsx- / gal- / relay- 开头，不会撞，也便于一眼认出来源。
 *  xlsx 导入与 AI 同步脚本只重写自己前缀的条目，所以 custom- 不会被冲掉。 */
const CUSTOM_PREFIX = "custom-";

/** 后台新增条目的条数上限。防手滑刷爆库，也提示该把数据折回 items.json 了。 */
const CUSTOM_MAX_ITEMS = 300;

/** 会话有效期，12 小时。到点要重新登录，减少 token 泄露后的窗口。 */
const SESSION_HOURS = 12;

/** 同一 IP 每分钟最多试几次密码。超了直接 429，挡暴力破解。 */
const LOGIN_TRIES = 5;

/** PBKDF2 迭代次数。Worker 的 CPU 时间有限，10 万次约几十毫秒，够用。 */
const PBKDF2_ITER = 100000;

const pad2 = (n) => String(n).padStart(2, "0");

/** ISO 8601 周编号，与前端 app.js 的算法保持一致。 */
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dow);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${pad2(week)}`;
}

/** 各周期当前桶名。统一用 UTC —— 服务端没有「用户时区」，
 *  混用会让同一次点击落进不同的天。 */
function buckets(now = new Date()) {
  return {
    day: `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-${pad2(now.getUTCDate())}`,
    week: isoWeek(now),
    month: `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}`,
    year: String(now.getUTCFullYear()),
    all: "all",
  };
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
/** CORS 头。Origin 不在白名单时不回 ACAO，浏览器自己会拦。 */
function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const ok = ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin);
  const h = {
    "Content-Type": "application/json; charset=utf-8",
    Vary: "Origin",
  };
  if (ok && origin) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS";
    // 后台编辑要带 Authorization 头，不放行的话浏览器预检就拦了
    h["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
    h["Access-Control-Max-Age"] = "86400";
  }
  return { headers: h, allowed: ok };
}

const json = (data, request, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: corsHeaders(request).headers });

/* ---------- 观看区上游（只允许固定白名单，绝不接受任意 URL） ---------- */
const WATCH_MUSIC_API = "http://www.tinysignal.fun/soda_music/music_action_v2.php";
const WATCH_QUERY_MAX = 80;
const WATCH_AUDIO_HOSTS = new Set([
  "music.163.com", "music.126.net", "m7.music.126.net", "m8.music.126.net",
  "m701.music.126.net", "m801.music.126.net",
]);
// 音频代理宿主判定：如主集合；另放行上游 getAlgerListenUrl 会真实返回的
// CDN（酷我曲库中转 bd-*.kuwo.cn），按「基础域名 + 任意子域」匹配，避免
// 酷我换区域子域又要逐个加白名单。白名单仍兜底开放代理风险 —— 只放行
// 播放链路里真实出现过的域名。
function audioHostAllowed(host) {
  const name = String(host || "").toLowerCase();
  if (WATCH_AUDIO_HOSTS.has(name)) return true;
  return name === "kuwo.cn" || name.endsWith(".kuwo.cn");
}

function watchText(value, max = WATCH_QUERY_MAX) {
  return String(value || "").replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, max);
}

async function watchFetch(url, init = {}, timeoutMs = 15000, allowedHosts = null, allowedFn = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let target = new URL(url);
    const allowed = allowedHosts
      ? new Set([...allowedHosts].map((host) => String(host).toLowerCase()))
      : new Set([target.hostname.toLowerCase()]);
    const allowedCheck = allowedFn
      ? (host) => allowed.has(String(host).toLowerCase()) || allowedFn(String(host).toLowerCase())
      : (host) => allowed.has(String(host).toLowerCase());
    for (let redirects = 0; redirects <= 3; redirects++) {
      if (!["http:", "https:"].includes(target.protocol)
          || !allowedCheck(target.hostname)) {
        throw new Error("upstream redirect host not allowed");
      }
      const response = await fetch(target, {
        ...init, signal: controller.signal, redirect: "manual",
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get("Location");
      if (!location || redirects === 3) throw new Error("too many upstream redirects");
      target = new URL(location, target);
    }
    throw new Error("too many upstream redirects");
  } finally {
    clearTimeout(timer);
  }
}

/* 音乐区默认不能只有「最新 10 首」：getNewestSongsV2 固定返回 10 条且
   category 参数被上游忽略。这里并发拉「最新 + 若干热门关键词」的搜索结果，
   按 id 去重合并。关键词挑宽泛品类词（各约 100 首），合并去重后足够分页。
   数量控制在 4 个以内：Worker 要等最慢的一路返回，太多会把整体时长拖爆。 */
const WATCH_MUSIC_EXPLORE_KEYS = ["华语", "流行", "纯音乐", "经典"];

/** 网易云图床支持 ?param=WxH 裁剪：封面原图 200~700KB，300y300 只要 5~30KB，
    不加参数的话一页卡片要拉几 MB 的图，封面半天出不来。 */
function musicCoverUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (!/^https?:\/\/p\d*\.music\.126\.net\//i.test(raw)) return raw.replace(/^http:/, "https:");
  const base = raw.replace(/^http:/, "https:").split("?")[0];
  return `${base}?param=300y300`;
}

/** 把上游两种返回（getNewestSongsV2 / searchV2）归一化成统一歌曲形状。
 *  getNewest: data.result = [{id,name,picUrl,song:{artists,album}}]
 *  searchV2:  data.result.songs = [网易云标准 {id,name,ar:[{name}],al:{picUrl}}] */
function normalizeMusicList(payload) {
  const root = payload?.data;
  const raw = Array.isArray(root?.result) ? root.result : root?.result?.songs || [];
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const song = entry?.song || entry || {};
    const artists = song.artists || song.ar || entry.artists || [];
    const album = song.album || song.al || {};
    return {
      id: String(song.id || entry.id || ""),
      name: song.name || entry.name || "未知歌曲",
      artists: Array.isArray(artists) ? artists.map((a) => a?.name).filter(Boolean) : [],
      cover: musicCoverUrl(song.pic || entry.pic || entry.picUrl || album.picUrl || ""),
    };
  }).filter((x) => x.id);
}

async function watchMusic(request, url) {
  const action = watchText(url.searchParams.get("action") || "getNewestSongsV2", 32);

  if (action === "explore") {
    const jobs = [
      { action: "getNewestSongsV2" },
      ...WATCH_MUSIC_EXPLORE_KEYS.map((kw) => ({ action: "searchV2", keywords: kw })),
    ];
    const results = await Promise.allSettled(jobs.map((job) => watchMusicUpstream(job)));
    const merged = [];
    const seen = new Set();
    let failed = 0;
    for (const result of results) {
      if (result.status !== "fulfilled" || !result.value) { failed += 1; continue; }
      for (const song of normalizeMusicList(result.value)) {
        const id = String(song?.id || "");
        if (!id || seen.has(id)) continue;
        seen.add(id);
        merged.push(song);
      }
    }
    if (!merged.length) return json({ error: "音乐上游暂时不可用" }, request, 502);
    return json({ items: merged.slice(0, 300), failed }, request);
  }

  if (!["getNewestSongsV2", "searchV2", "getAlgerListenUrl"].includes(action)) {
    return json({ error: "unsupported music action" }, request, 400);
  }
  const params = new URLSearchParams({ action });
  if (action === "searchV2") {
    const keywords = watchText(url.searchParams.get("q"));
    if (!keywords) return json({ error: "请输入搜索内容" }, request, 400);
    params.set("keywords", keywords);
  }
  if (action === "getAlgerListenUrl") {
    const id = watchText(url.searchParams.get("id"), 40);
    if (!/^\d{1,24}$/.test(id)) return json({ error: "bad song id" }, request, 400);
    params.set("linkMid", id);
  }
  const payload = await watchMusicUpstream(Object.fromEntries(params));
  return json(payload, request);
}

/** 调音乐上游一次，返回原始 payload；explore 聚合用。 */
async function watchMusicUpstream(job) {
  const params = new URLSearchParams(job);
  const upstream = await watchFetch(`${WATCH_MUSIC_API}?${params}`, {
    headers: { Accept: "application/json,text/plain,*/*" },
  }, 20000);
  const text = await upstream.text();
  if (!upstream.ok) throw new Error(`music upstream HTTP ${upstream.status}`);
  return JSON.parse(text);
}

async function watchAudio(request, url) {
  let target;
  try { target = new URL(url.searchParams.get("url") || ""); } catch { return json({ error: "bad audio url" }, request, 400); }
  if (target.protocol !== "https:" || !audioHostAllowed(target.hostname)) {
    return json({ error: "audio host not allowed" }, request, 403);
  }
  const range = request.headers.get("Range") || "";
  const headers = { Referer: "https://music.163.com/", "User-Agent": "Mozilla/5.0" };
  if (/^bytes=\d*-\d*$/.test(range)) headers.Range = range;
  const upstream = await watchFetch(target, { headers }, 25000, WATCH_AUDIO_HOSTS, audioHostAllowed);
  if (!upstream.ok && upstream.status !== 206) return json({ error: `audio upstream HTTP ${upstream.status}` }, request, 502);
  const out = new Headers(corsHeaders(request).headers);
  out.set("Content-Type", upstream.headers.get("Content-Type") || "audio/mpeg");
  out.set("Cache-Control", "public, max-age=1800");
  for (const h of ["Content-Length", "Content-Range", "Accept-Ranges"]) {
    const value = upstream.headers.get(h); if (value) out.set(h, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

const WATCH_NOVEL_ORIGINS = [
  "https://tw.linovelib.com", "https://www.bilinovel.com", "https://www.linovelib.com",
];
// 搜索端点是桌面版 www.linovelib.com/S6/（POST）。带 searchkey 的请求会被
// Cloudflare Managed Challenge 拦下（需要浏览器 JS 计算，纯 HTTP 拿不到结果），
// 所以这里只做「尝试」，真正兜底靠 searchNovelLocal 抓 wenku 列表本地匹配。
const WATCH_NOVEL_SEARCH_ORIGINS = ["https://www.linovelib.com"];
const WATCH_ANIME_ORIGINS = ["https://www.lmm85.com", "https://m.lm6.net"];
const WATCH_MANGA_API_ORIGINS = [
  "http://crm.weichu.asia", "http://meiwenti.xn--vhqr42drhf5k7b.com",
  "http://bkbfblh.xn--vhqr42drhf5k7b.com",
];
// 前端「漫画线路」下拉用这些 key 锁定单条线路；不带 source 就按上面的顺序自动回落。
const WATCH_MANGA_SOURCE_KEYS = ["crm", "meiwenti", "bkbfblh"];
const WATCH_MANGA_IMAGE_ORIGIN = "https://i.lzimg.xyz";
const WATCH_MANGA_PACK = "com.hbsclj.uth";
const WATCH_MANGA_SIGN = "CDD266DF8B2399C24DA38E408B6D9825C7BD2AF073229847F551EA653EA096E1";
const WATCH_MANGA_IMAGE_HOSTS = new Set(["i.lzimg.xyz", "cf-1.imgio.club"]);
// 漫画多源之后图片域名变多（叽叽漫画 / GMH 各有自己的图床），按「基础域名 +
// 子域」放行，避免每加一个源就要改一次白名单。
const WATCH_MANGA_IMAGE_DOMAINS = [
  "lzimg.xyz", "imgio.club",
  "jjmhw.cc", "jjmhw8.top", "jjmhw6.top",
  "6wm.top", "g-mh.org",
];

/** 图片是否来自允许的图床。子域一并放行（c-nd3-1.6wm.top 之类）。 */
function mangaImageHostAllowed(host) {
  const name = String(host || "").toLowerCase();
  if (WATCH_MANGA_IMAGE_HOSTS.has(name)) return true;
  return WATCH_MANGA_IMAGE_DOMAINS.some((domain) => name === domain || name.endsWith(`.${domain}`));
}
const WATCH_VIDEO_HOSTS = /(?:^|\.)(?:92cj\.com|upaiyun\.com|bcebos\.com|qpic\.cn|qq\.com)$/i;

/* 小说正文插图走独立图床（lazysizes 的 data-src），域名跟正文站不同。
 * 之前只放行正文站自身域名，导致插图一律 403「asset host not allowed」。
 * 按「基础域名 + 子域」放行，新图床只需往这里加一项。 */
const WATCH_NOVEL_IMAGE_DOMAINS = [
  "readpai.com",     // linovelib / bilinovel 正文插图 CDN（img3.readpai.com）
  "linovelib.com", "bilinovel.com", "bilinovel.net",
];

function novelImageHostAllowed(host) {
  const name = String(host || "").toLowerCase();
  if (WATCH_NOVEL_ORIGINS.some((origin) => name === new URL(origin).hostname)) return true;
  if (WATCH_NOVEL_SEARCH_ORIGINS.some((origin) => name === new URL(origin).hostname)) return true;
  return WATCH_NOVEL_IMAGE_DOMAINS.some((domain) => name === domain || name.endsWith(`.${domain}`));
}

/** 站徽/图标/懒加载占位这类装饰图，不是正文插图。
 *  只检查路径与文件名，避开域名误判（readpai.com 含 "ad"）。 */
function isNovelDecorationImage(value) {
  let path = String(value || "");
  try {
    const parsed = new URL(path);
    path = `${parsed.pathname}${parsed.search}`;
  } catch { /* 相对路径原样判断 */ }
  const name = path.split("/").pop() || "";
  return /(?:^|\/)(?:logo|icon|avatar|sloading|loading|blank|spacer|placeholder)[^/]*$/i.test(path)
    || /(?:^|[-_.])(?:logo|icon|avatar|ads?|banner)(?:[-_.]|$)/i.test(name)
    || /\.svg(?:$|\?)/i.test(name);
}

const WATCH_ENTITIES = {
  nbsp: " ", amp: "&", quot: '"', apos: "'", lt: "<", gt: ">",
  hellip: "…", mdash: "—", ndash: "–", middot: "·", times: "×",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", copy: "©", reg: "®",
};

function decodeEntities(value) {
  return String(value || "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code) || 32))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16) || 32))
    .replace(/&([a-z]+);/gi, (whole, name) => WATCH_ENTITIES[name.toLowerCase()] ?? whole);
}

function stripTags(value) {
  return decodeEntities(String(value || "").replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ").trim();
}

function absoluteWatchUrl(value, origin) {
  try { return new URL(decodeEntities(value), origin).toString(); } catch { return ""; }
}

function proxyWatchAsset(value, kind) {
  const url = absoluteWatchUrl(value, "https://invalid.local");
  if (!url || url.includes("invalid.local")) return "";
  return `/api/watch/asset?kind=${kind}&url=${encodeURIComponent(url)}`;
}

async function fetchWatchHtml(url, referer = "") {
  // 用手机 UA：linovelib 等正文站会检测 UA，桌面 UA 会返回手机版内容（含"暂不支持电脑端阅读"警告 + 只有插图无正文段落）。
  const response = await watchFetch(url, { headers: {
    Accept: "text/html,application/xhtml+xml", "User-Agent": WATCH_MOBILE_UA,
    "Accept-Language": "zh-CN,zh;q=0.9", ...(referer ? { Referer: referer } : {}),
  } }, 25000);
  if (!response.ok) throw new Error(`upstream HTTP ${response.status}`);
  return await response.text();
}

/** 带重试的 HTML 抓取：上游（linovelib 等）偶发 429/5xx/超时，单次失败就返回会让用户
 *  翻到某一章时整章空白。这里对同一 URL 重试几次，间隔递增，降低偶发限流的影响。 */
async function fetchWatchHtmlRetry(url, referer = "", retries = 2, baseDelayMs = 400) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchWatchHtml(url, referer);
    } catch (error) {
      lastError = error;
      const msg = String(error?.message || error);
      // 429/5xx/超时 才值得重试；403/404 等确定失败不重试。
      const retryable = /upstream HTTP (429|5\d\d)|abort|timeout|fetch failed|internal/i.test(msg);
      if (!retryable || attempt === retries) throw error;
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * (attempt + 1)));
    }
  }
  throw lastError;
}

async function fetchFirstWatchHtml(origins, path) {
  const errors = [];
  for (const origin of origins) {
    try { return { html: await fetchWatchHtmlRetry(`${origin}${path}`), origin }; }
    catch (error) { errors.push(`${new URL(origin).hostname}: ${error.message}`); }
  }
  throw new Error(errors.join("; ") || "upstream unavailable");
}

/** 抓桌面版 www.linovelib.com 的章节 HTML（桌面 UA + Referer 桌面首页）。
 *  桌面版返回 mlfy_main_text 容器的一页全量完整正文。带重试。
 *  纯 HTTP 可能被反爬返回截断/乱序，因此可回退到本地 Playwright 渲染服务。 */
const PLAYWRIGHT_RENDER_URL = "http://127.0.0.1:50051/render";
async function fetchNovelDesktopHtml(path) {
  const url = `${WATCH_NOVEL_DESKTOP_ORIGIN}${path}`;
  let lastError;
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const response = await watchFetch(url, { headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": WATCH_DESKTOP_UA,
        "Accept-Language": "zh-CN,zh;q=0.9",
        Referer: `${WATCH_NOVEL_DESKTOP_ORIGIN}/`,
      } }, 25000);
      if (!response.ok) throw new Error(`upstream HTTP ${response.status}`);
      const html = await response.text();
      // 纯 HTTP 若拿到正文段落少于 20 段，视为反爬截断，回退到 Playwright 渲染。
      if ((html.match(/<p\b/gi) || []).length >= 20) return html;
      const rendered = await renderWithPlaywright(url);
      if (rendered && (rendered.match(/<p\b/gi) || []).length > 0) return rendered;
      throw new Error(`desktop chapter empty after fallback (${html.length}/${rendered?.length || 0})`);
    } catch (error) {
      lastError = error;
      const msg = String(error?.message || error);
      const retryable = /upstream HTTP (429|5\d\d)|abort|timeout|fetch failed|internal|empty after fallback/i.test(msg);
      if (!retryable || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw lastError;
}

/** 调用本地 Playwright 渲染服务，获取 JS 渲染后的完整 HTML。 */
async function renderWithPlaywright(url) {
  try {
    const response = await fetch(PLAYWRIGHT_RENDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    });
    if (!response.ok) return "";
    const payload = await response.json();
    return payload?.html || "";
  } catch {
    return "";
  }
}

/** 小说搜索（桌面版 www.linovelib.com/S6/，POST）。
 *  带 searchkey 的请求被 Cloudflare Managed Challenge 保护，纯 HTTP 大概率
 *  拿不到结果（返回 0 字节 challenge 占位页）。这里走完整 guard 流程尝试一次，
 *  失败由上层回退到 searchNovelLocal 本地 wenku 索引匹配。 */
async function fetchNovelSearch(q) {
  const origin = WATCH_NOVEL_SEARCH_ORIGINS[0];
  const allowed = [origin, ...WATCH_NOVEL_ORIGINS].map((o) => new URL(o).hostname.toLowerCase());
  const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  let cookie = "";

  // 1) search_guard=js 拿 jieqiSearchJs token
  try {
    const jsRes = await watchFetch(`${origin}/S6/?search_guard=js`, {
      headers: { Accept: "*/*", "User-Agent": DESKTOP_UA, "Accept-Language": "zh-CN,zh;q=0.9", Referer: `${origin}/S6/` },
    }, 12000, allowed);
    if (jsRes.ok) {
      const jsBody = await jsRes.text();
      const token = jsBody.match(/jieqiSearchJs=([^";]+)/)?.[1] || "";
      if (token) cookie = `jieqiSearchJs=${token}`;
    }
  } catch { /* token 拿不到就裸搜 */ }

  // 2) redeem（触发服务端放行）
  if (cookie) {
    try {
      await watchFetch(`${origin}/S6/?search_guard=redeem&r=${Date.now()}`, {
        headers: { Accept: "*/*", "User-Agent": DESKTOP_UA, Cookie: cookie, "Accept-Language": "zh-CN,zh;q=0.9", Referer: `${origin}/S6/` },
      }, 12000, allowed);
    } catch { /* redeem 失败不致命 */ }
  }

  // 3) POST 搜索
  const response = await watchFetch(`${origin}/S6/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": DESKTOP_UA,
      "Accept-Language": "zh-CN,zh;q=0.9",
      Referer: `${origin}/S6/`,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: `searchkey=${encodeURIComponent(q)}`,
  }, 25000, allowed);
  if (!response.ok) throw new Error(`upstream HTTP ${response.status}`);
  const html = await response.text();
  if (!html || html.length < 200) throw new Error("empty search result (CF challenge)");
  return { html, origin };
}

/** 本地搜索兜底：linovelib 搜索被 CF 拦时，抓 wenku 列表前 N 页做标题/简介匹配。
 *  wenku 每页 30 本，抓 8 页约 240 本（最新/热门优先），覆盖绝大多数用户搜索。
 *  索引缓存在 globalThis（Worker 隔离实例内存），10 分钟刷新一次，避免每次搜索
 *  都抓 8 页触发 linovelib 429 限流。 */
let novelLocalIndexCache = null;
async function searchNovelLocal(q) {
  const keyword = String(q || "").trim();
  if (!keyword) return [];
  const pages = 8;
  const cacheTtl = 10 * 60 * 1000; // 10 分钟

  // 读缓存（跨请求共享，避免 429）
  if (!novelLocalIndexCache || Date.now() - novelLocalIndexCache.at > cacheTtl) {
    novelLocalIndexCache = await buildNovelLocalIndex(pages);
  }
  const cards = novelLocalIndexCache.cards;

  // 匹配：标题包含关键词（简/繁都试），去掉书名号/空格归一
  const norm = (s) => String(s || "").replace(/[\s·・《》「」]/g, "");
  const k = norm(keyword);
  const kT = norm(novelS2T(keyword));
  const kS = norm(novelT2S(keyword));
  const hits = cards.filter((c) => {
    const t = norm(c.title);
    return t.includes(k) || t.includes(kT) || t.includes(kS)
      || (k.length >= 2 && t.includes(k.slice(0, Math.max(2, k.length - 1))));
  });
  return hits.slice(0, 30);
}

/** 构建 wenku 本地索引（抓前 N 页，第 1 页带重试，后续页串行）。 */
async function buildNovelLocalIndex(pages = 8) {
  const origin = "https://tw.linovelib.com";
  const cards = [];
  const seen = new Set();

  const grabPage = async (page) => {
    const html = await fetchWatchHtml(`${origin}/wenku/lastupdate_0_0_0_0_0_0_0_${page}_0.html`, `${origin}/wenku/`);
    const re = /<li[^>]*class=["'][^"']*book-li[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi;
    const out = [];
    let m;
    while ((m = re.exec(html))) {
      const block = m[1];
      const href = block.match(/href=["'](\/novel\/(\d+)\.html)["']/i);
      if (!href) continue;
      const title = stripTags(block.match(/class=["']book-title["'][^>]*>([\s\S]*?)<\//i)?.[1] || "");
      if (!title) continue;
      const images = [...block.matchAll(/(?:data-src|src)=["']([^"']+)["']/gi)]
        .map((e) => e[1]).filter((v) => v && !/book-cover-no|data:image/i.test(v));
      const coverUrl = absoluteWatchUrl(images[0] || "", origin);
      out.push({ id: href[2], title, cover: coverUrl ? proxyWatchAsset(coverUrl, "novel") : "", subtitle: "哔哩轻小说" });
    }
    return out;
  };

  // 第 1 页带重试
  let page1 = [];
  for (let attempt = 0; attempt < 2 && !page1.length; attempt++) {
    try { page1 = await grabPage(1); } catch { /* 重试 */ }
  }
  for (const c of page1) if (!seen.has(c.id)) { seen.add(c.id); cards.push(c); }

  // 第 1 页底部的「大家都在搜」标签（jsSearchLink）也纳入索引，
  // 覆盖 DxD / 春物 这类老热门书（不在「最新更新」列表里）。
  if (page1.length) {
    try {
      const hotHtml = await fetchWatchHtml(`${origin}/wenku/`, `${origin}/wenku/`);
      const hotRe = /<a[^>]+href=["'](\/novel\/(\d+)\.html)["'][^>]*class=["'][^"']*jsSearchLink[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
      let hm;
      while ((hm = hotRe.exec(hotHtml))) {
        const id = hm[2];
        if (seen.has(id)) continue;
        const title = stripTags(hm[3]);
        if (!title) continue;
        seen.add(id);
        cards.push({ id, title, cover: "", subtitle: "哔哩轻小说" });
      }
    } catch { /* 热门标签抓取失败不致命 */ }
  }

  // 第 2~pages 页串行
  for (let page = 2; page <= pages; page++) {
    try {
      for (const c of await grabPage(page)) if (!seen.has(c.id)) { seen.add(c.id); cards.push(c); }
    } catch { /* 某页失败跳过 */ }
  }

  return { at: Date.now(), cards };
}

/** 繁体转简体（搜索兜底用，常见高频字映射）。 */
function novelT2S(text) {
  const map = {
    轉: "转", 生: "生", 成: "成", 夾: "夹", 在: "在", 百: "百", 合: "合", 中: "中", 間: "间", 的: "的",
    男: "男", 人: "人", 了: "了", 女: "女", 主: "主", 角: "角", 小: "小", 說: "说", 愛: "爱", 戀: "恋",
    後: "后", 宮: "宫", 異: "异", 世: "世", 界: "界", 精: "精", 靈: "灵", 劍: "剑", 舞: "舞", 戰: "战",
    鬥: "斗", 學: "学", 園: "园", 魔: "魔", 王: "王", 勇: "勇", 者: "者", 龍: "龙", 與: "与", 們: "们",
    妹: "妹", 姐: "姐", 哥: "哥", 弟: "弟", 家: "家", 族: "族", 血: "血", 劇: "剧", 情: "情", 紹: "绍",
    天: "天", 使: "使", 惡: "恶", 記: "记", 錄: "录", 傳: "传", 國: "国", 級: "级", 別: "别", 萬: "万",
    無: "无", 雙: "双", 真: "真", 理: "理", 命: "命", 運: "运", 輪: "轮", 回: "回", 復: "复", 華: "华",
    語: "语", 書: "书", 庫: "库", 獻: "献", 愛: "爱", 貝: "贝", 賽: "赛", 爾: "尔", 歐: "欧", 羅: "罗",
  };
  return String(text || "").split("").map((ch) => map[ch] || ch).join("");
}

/** 简繁互相转换（用于搜索兜底：用户输简体，源站是繁体，反之亦然）。
 *  只做常见字符的一对一映射，覆盖轻小说标题高频字。 */
function novelS2T(text) {
  const map = {
    转: "轉", 生: "生", 成: "成", 夹: "夾", 在: "在", 百: "百", 合: "合", 中: "中", 间: "間", 的: "的",
    男: "男", 人: "人", 了: "了", 女: "女", 主: "主", 角: "角", 小: "小", 说: "說", 爱: "愛", 恋: "戀",
    后: "後", 宫: "宮", 异: "異", 世: "世", 界: "界", 精: "精", 灵: "靈", 剑: "劍", 舞: "舞", 战: "戰",
    斗: "鬥", 学: "學", 园: "園", 魔: "魔", 王: "王", 勇: "勇", 者: "者", 龙: "龍", 与: "與", 们: "們",
    妹: "妹", 姐: "姐", 哥: "哥", 弟: "弟", 家: "家", 族: "族", 血: "血", 剧: "劇", 情: "情", 引: "引",
    介: "介", 绍: "紹", 天: "天", 使: "使", 惡: "恶", 恶: "惡", 记: "記", 录: "錄", 传: "傳", 国: "國",
    级: "級", 别: "別", 名: "名", 称: "稱", 万: "萬", 无: "無", 双: "雙", 真: "真", 理: "理", 命: "命",
    运: "運", 轮: "輪", 回: "回", 复: "復", 活: "活", 死: "死", 亡: "亡", 日: "日", 常: "常", 等: "等",
    级: "級", 别: "別", 华: "華", 语: "語", 书: "書", 库: "庫", 文: "文", 献: "獻",
  };
  return String(text || "").split("").map((ch) => map[ch] || ch).join("");
}

function parseNovelCards(html, origin) {
  const cards = [];
  const seen = new Set();
  // 旧版 DOM：<li class="book-li"> 包裹的卡片。
  const re = /<li[^>]*class=["'][^"']*book-li[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi;
  let match;
  while ((match = re.exec(html)) && cards.length < 30) {
    const block = match[1];
    const href = block.match(/href=["'](\/novel\/(\d+)\.html)["']/i);
    if (!href || seen.has(href[2])) continue;
    const title = stripTags(block.match(/class=["']book-title["'][^>]*>([\s\S]*?)<\//i)?.[1] || "");
    const images = [...block.matchAll(/(?:data-src|src)=["']([^"']+)["']/gi)]
      .map((entry) => entry[1]).filter((value) => value && !/book-cover-no|data:image/i.test(value));
    const coverUrl = absoluteWatchUrl(images[0] || "", origin);
    seen.add(href[2]);
    cards.push({
      id: href[2], title: title || `小说 ${href[2]}`,
      cover: coverUrl ? proxyWatchAsset(coverUrl, "novel") : "", subtitle: "哔哩轻小说",
    });
  }
  // 新版搜索 DOM：结果卡片用 <a href="/novel/{id}.html"> + 附近 .book-title + .book-cover 图，
  // 不再用 .book-li 包裹。用通用匹配兜底。
  if (!cards.length) cards.push(...parseNovelSearchCards(html, origin));
  return cards;
}

/** 通用搜索卡片解析：遍历所有 /novel/{id}.html 链接，取链接文本或附近标题 + 附近封面图。 */
function parseNovelSearchCards(html, origin) {
  const cards = [];
  const seen = new Set();
  const linkRe = /<a[^>]+href=["'](\/novel\/(\d+)\.html)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html)) && cards.length < 30) {
    const id = m[2];
    if (seen.has(id)) continue;
    seen.add(id);
    // 标题：同一个 id 可能被封面 <a> 和标题 <a> 引用多次，取文本最长的一次。
    let title = stripTags(m[3]);
    // 再找同 id 的其他链接，取更长的文本
    const idLinkRe = new RegExp(`<a[^>]+href=["']/novel/${id}\\.html["'][^>]*>([\\s\\S]*?)<\\/a>`, "gi");
    let m2;
    while ((m2 = idLinkRe.exec(html))) {
      const t = stripTags(m2[1]);
      if (t.length > title.length) title = t;
    }
    if (!title) {
      const before = html.slice(Math.max(0, m.index - 800), m.index);
      title = stripTags(before.match(/book-title["'][^>]*>([\s\S]*?)$/i)?.[1] || "");
    }
    // 封面：该 id 链接附近 1200 字符内的图片
    const around = html.slice(Math.max(0, m.index - 800), m.index + m[0].length + 1200);
    const imgs = [...around.matchAll(/(?:data-src|data-original|src)=["']([^"']+)["']/gi)]
      .map((e) => e[1]).filter((v) => v && !/book-cover-no|data:image|sloading|logo|icon/i.test(v));
    const coverUrl = absoluteWatchUrl(imgs[0] || "", origin);
    cards.push({
      id, title: title || `小说 ${id}`,
      cover: coverUrl ? proxyWatchAsset(coverUrl, "novel") : "", subtitle: "哔哩轻小说",
    });
  }
  return cards;
}

async function watchNovel(request, url, env) {
  const action = watchText(url.searchParams.get("action") || "list", 24);
  if (action === "list") {
    const q = watchText(url.searchParams.get("q"));
    if (q) {
      // 优先上游搜索（桌面版 /S6/ POST，可能被 CF 拦）；失败回退本地 wenku 索引匹配。
      let items = null;
      try {
        const { html, origin } = await fetchNovelSearch(q);
        items = parseNovelCards(html, origin);
      } catch { /* 上游被 CF 拦，走本地兜底 */ }
      if (!items || !items.length) {
        items = await searchNovelLocal(q);
      }
      return json({ items: items || [] }, request);
    }
    const { html, origin } = await fetchFirstWatchHtml(WATCH_NOVEL_ORIGINS, "/wenku/");
    return json({ items: parseNovelCards(html, origin) }, request);
  }
  const novelId = watchText(url.searchParams.get("novel"), 12);
  if (!/^\d+$/.test(novelId)) return json({ error: "bad novel id" }, request, 400);
  if (action === "detail") {
    const [{ html: detail, origin }, { html: catalog }] = await Promise.all([
      fetchFirstWatchHtml(WATCH_NOVEL_ORIGINS, `/novel/${novelId}.html`),
      fetchFirstWatchHtml(WATCH_NOVEL_ORIGINS, `/novel/${novelId}/catalog`),
    ]);
    const title = decodeEntities(detail.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)/i)?.[1] || `小说 ${novelId}`);
    const coverUrl = absoluteWatchUrl(detail.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)/i)?.[1] || "", origin);
    const cover = coverUrl ? proxyWatchAsset(coverUrl, "novel") : "";
    const description = decodeEntities(detail.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)/i)?.[1] || "");
    const chapters = [];
    const chapterRe = new RegExp(`<a[^>]+href=["'](/novel/${novelId}/(?!vol_)(\\d+)\\.html)["'][^>]*>([\\s\\S]*?)<\\/a>`, "gi");
    let m;
    while ((m = chapterRe.exec(catalog)) && chapters.length < 1000) {
      const chapterTitle = stripTags(m[3]);
      if (!chapters.some((x) => x.id === m[2])) chapters.push({ id: m[2], title: chapterTitle || `章节 ${m[2]}` });
    }
    // 上游目录页可能混入「最新章节」等侧栏链接，DOM 顺序不保证阅读顺序。
    // 按 id 数字升序排列，确保章列表始终从小到大。
    chapters.sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
    return json({ id: novelId, title, cover, description, chapters }, request);
  }
  if (action === "chapter") {
    const chapterId = watchText(url.searchParams.get("chapter"), 12);
    if (!/^\d+$/.test(chapterId)) return json({ error: "bad chapter id" }, request, 400);
    const chapter = await fetchNovelChapterAll(env, novelId, chapterId);
    if (!chapter.blocks.length) return json({ error: "正文为空或被上游保护" }, request, 502);
    return json(chapter, request);
  }
  return json({ error: "unsupported novel action" }, request, 400);
}

function mangaId(value) {
  const text = watchText(value, 20);
  return /^\d{1,18}$/.test(text) ? text : "";
}

/* ---------- 漫画多源 ----------
 *
 * 薄荷梨子 App 里漫画本来就分了好几个源（assets/public.js 里的 MOBILE_*_SOURCE）：
 * 自家的 app/api（crm 系列）、叽叽漫画(manga3r)、GMH(manga4)、拷贝漫画(manga5/6)、
 * mangakakalot(manga5en)。网站这边原来只接了自家的 app/api —— 那三条域名
 * 2026-09 已经全部解析失败，于是整个漫画区就空了。
 *
 * 这里把 App 的取数逻辑照搬到 Worker：每个源一个 handler，统一输出
 * {items} / {detail} / {images} 三种形状，前端不需要知道源之间的差异。
 */

const WATCH_MANGA_SOURCES = [
  { id: "manga3r", label: "叽叽漫画" },
  { id: "manga4", label: "GMH 漫画" },
  { id: "crm", label: "薄荷梨子（原线路）" },
];
const WATCH_MANGA_SOURCE_IDS = WATCH_MANGA_SOURCES.map((item) => item.id);

const WATCH_MOBILE_UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 "
  + "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

// 桌面 UA：linovelib 桌面版 www.linovelib.com 用 mlfy_main_text 容器返回「一页全量」的
// 完整正文（简体、无分页、无每页末尾截断、无「內容加載失敗」标记）。
// 而手机 UA + tw.linovelib.com 是繁体、分页、且每页末尾被反爬截断（"……"）。
// 所以章节正文优先走桌面版，拿不到再回退手机版。
const WATCH_DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
  + "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const WATCH_NOVEL_DESKTOP_ORIGIN = "https://www.linovelib.com";

// 小说章节预热缓存：由本地 Playwright 脚本批量抓取后写入 KV。
// Worker 优先读它，命中就不再打上游（linovelib 反爬会随机截断/乱序纯 HTTP 请求）。
// 绑定名 NOVEL_CACHE，未绑定时自动跳过，不影响其它功能。
// 注意：env 只在 fetch() 内可见，这里不能引用；运行时通过函数参数传入。
const NOVEL_CACHE_BINDING = "NOVEL_CACHE";

const WATCH_R_BASE = "https://www.jjmhw.cc";
const WATCH_GMH_BASE = "https://m.g-mh.org";
const WATCH_GMH_API_FALLBACK = "https://v2.apikk.top";

/** 抓 HTML 页面。上游普遍要求像浏览器，Referer 缺了会 403。 */
async function watchFetchHtml(target, referer = "") {
  const response = await watchFetch(target, { headers: {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "User-Agent": WATCH_MOBILE_UA,
    ...(referer ? { Referer: referer } : {}),
  } }, 20000);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.text();
}

/** 抓 JSON 接口，带上游要求的平台头。 */
async function watchFetchJson(target, referer = "", extraHeaders = {}) {
  const response = await watchFetch(target, { headers: {
    Accept: "application/json,text/plain,*/*",
    "User-Agent": WATCH_MOBILE_UA,
    ...(referer ? { Referer: referer, Origin: referer.replace(/\/$/, "") } : {}),
    ...extraHeaders,
  } }, 20000);
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  try { return JSON.parse(text); } catch { throw new Error("上游返回的不是 JSON"); }
}

/* ---------- 源 1：叽叽漫画（manga3r，jjmhw.cc） ---------- */

function mangaRBookId(value) {
  return String(value || "").match(/\/book\/(\d+)/)?.[1] || "";
}

function mangaRChapterId(value) {
  return String(value || "").match(/\/chapter\/(\d+)/)?.[1] || "";
}

/** 图片子域名（jjmhw6/8.top）会间歇性重置连接，统一改写回主域名的同路径。 */
function mangaRImage(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let target;
  try { target = new URL(raw, WATCH_R_BASE); } catch { return ""; }
  const host = target.hostname.toLowerCase();
  if (!/^(?:[a-z0-9-]+\.)?jjmhw\d*\.(?:cc|top)$/i.test(host) && !/(?:^|\.)jjmhw\d*\.top$/i.test(host)) {
    return "";
  }
  target.protocol = "https:";
  target.host = "www.jjmhw.cc";
  return proxyWatchAsset(target.toString(), "manga");
}

function mangaRText(value) {
  return stripTags(value);
}

/**
 * 首页/搜索页的漫画卡片。
 *
 * 这个站会按 UA 换模板：桌面模板是 `div.mh-item`（封面在独立锚点的
 * background-image 里），移动模板是 `<a href="  /book/N" title="...">`（href 里
 * 还带前导空格）。所以不按容器切块，而是把所有指向 /book/N 的锚点按 id 聚合，
 * 谁先提供标题/封面就用谁的 —— 两种模板都能出结果。
 */
function mangaRComics(html) {
  const found = new Map();
  const anchorRe = /<a\b[^>]*href="([^"]*\/book\/(\d+)[^"]*)"[^>]*>([\s\S]{0,800}?)<\/a>/gi;
  let match;
  while ((match = anchorRe.exec(html))) {
    const id = match[2];
    const attrs = match[0].slice(0, match[0].indexOf(">"));
    const inner = match[3];
    const entry = found.get(id) || { id, title: "", cover: "" };
    if (!entry.title) {
      entry.title = mangaRText(attrs.match(/\btitle="([^"]*)"/i)?.[1] || "")
        || mangaRText(inner.match(/<img[^>]+\balt="([^"]*)"/i)?.[1] || "")
        || mangaRText(inner);
    }
    if (!entry.cover) {
      entry.cover = inner.match(/<img[^>]+(?:data-original|data-src|src)="([^"]+)"/i)?.[1]
        || inner.match(/background-image\s*:\s*url\(\s*['"]?([^'")]+)['"]?\s*\)/i)?.[1]
        || attrs.match(/background-image\s*:\s*url\(\s*['"]?([^'")]+)['"]?\s*\)/i)?.[1]
        || "";
    }
    found.set(id, entry);
  }

  // 桌面模板的封面锚点里没有文字，标题在紧跟的 h2.title 里，单独补一遍。
  for (const block of html.split(/<div class="mh-item"/i).slice(1)) {
    const id = mangaRBookId(block.match(/href="([^"]*\/book\/\d+[^"]*)"/i)?.[1] || "");
    if (!id) continue;
    const entry = found.get(id) || { id, title: "", cover: "" };
    if (!entry.title) entry.title = mangaRText(block.match(/class="title"[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/i)?.[1] || "");
    if (!entry.cover) {
      entry.cover = block.match(/background-image\s*:\s*url\(\s*['"]?([^'")]+)['"]?\s*\)/i)?.[1] || "";
    }
    found.set(id, entry);
  }

  return [...found.values()]
    .filter((entry) => entry.id && entry.title)
    .slice(0, 60)
    .map((entry) => ({
      id: entry.id,
      title: entry.title,
      subtitle: "叽叽漫画",
      cover: mangaRImage(entry.cover),
      description: "",
      chapterCount: 0,
    }));
}

async function manga3rList(q) {
  const path = q ? `/search?keyword=${encodeURIComponent(q)}` : "/";
  const html = await watchFetchHtml(`${WATCH_R_BASE}${path}`, `${WATCH_R_BASE}/`);
  const items = mangaRComics(html);
  if (!items.length) throw new Error(q ? `没有搜到“${q}”` : "首页没有解析到漫画");
  return items;
}

async function manga3rDetail(comicId) {
  const url = `${WATCH_R_BASE}/book/${comicId}`;
  const html = await watchFetchHtml(url, `${WATCH_R_BASE}/`);
  const title = mangaRText(html.match(/class="detail-main-info-title[^"]*"[^>]*>([\s\S]*?)<\//i)?.[1] || "")
    || mangaRText(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || "");
  const description = mangaRText(
    html.match(/<p[^>]*class="detail-desc[^"]*"[^>]*>([\s\S]*?)<\/p>/i)?.[1]
    || html.match(/class="detail-desc[^"]*"[^>]*>([\s\S]*?)<\/p>/i)?.[1] || ""
  );
  const cover = mangaRImage(html.match(/class="detail-main-cover[^"]*"[^>]*>[\s\S]{0,400}?<img[^>]+(?:data-original|data-src|src)="([^"]+)"/i)?.[1]
    || `/static/upload/book/${comicId}/cover.jpg`);
  const chapters = [];
  const seen = new Set();
  const linkRe = /<a\b[^>]*href="([^"]*\/chapter\/(\d+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkRe.exec(html)) && chapters.length < 2000) {
    const id = match[2];
    const name = mangaRText(match[0].slice(0, match[0].indexOf(">")).match(/\btitle="([^"]*)"/i)?.[1] || "")
      || mangaRText(match[3]);
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    chapters.push({ id, title: name });
  }
  if (!chapters.length) throw new Error("没有解析到章节");
  return { id: comicId, title: title || `漫画 ${comicId}`, cover, description, chapters };
}

async function manga3rChapter(chapterId) {
  const url = `${WATCH_R_BASE}/chapter/${chapterId}`;
  const html = await watchFetchHtml(url, `${WATCH_R_BASE}/`);
  const images = [];
  const seen = new Set();
  const imgRe = /<img[^>]+(?:data-original|data-src|data-page-src|src)="([^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/gi;
  let match;
  while ((match = imgRe.exec(html)) && images.length < 300) {
    // 页面上混着站点 logo / 返回按钮图，按文件名排掉。
    if (/logo|view-back|view-top|favicon/i.test(match[1])) continue;
    const src = mangaRImage(match[1]);
    if (!src || seen.has(src)) continue;
    seen.add(src);
    images.push(src);
  }
  if (!images.length) throw new Error("这一话没有解析到图片");
  return { id: chapterId, title: "", images };
}

/* ---------- 源 2：GMH（manga4，m.g-mh.org + v2.apikk.top） ---------- */

/** 图片串是自定义混淆：前缀 J7r / 后缀 nQ，分三段重排 + 逐字符换表 + base64url。 */
function mangaGmhBase64UrlDecode(value) {
  const text = String(value || "");
  const pad = text.length % 4 ? "=".repeat(4 - (text.length % 4)) : "";
  const binary = atob((text + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function mangaGmhDecodeImages(value) {
  const prefix = "J7r", suffix = "nQ", marker = "kD", secret = "W4s", chunkSize = 7;
  const sourceAlphabet = "_-9876543210abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const targetAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const text = String(value || "");
  if (!text.startsWith(prefix) || !text.endsWith(suffix)) throw new Error("图片数据格式异常");

  const body = text.slice(prefix.length, -suffix.length);
  const contentLength = body.length - marker.length - secret.length;
  if (contentLength < 0) throw new Error("图片数据长度异常");
  const tailLength = Math.floor(contentLength / 3);
  const firstLength = Math.floor((contentLength - tailLength) / 2);
  const middleLength = contentLength - tailLength - firstLength;

  const first = body.slice(0, firstLength);
  const markerPart = body.slice(firstLength, firstLength + marker.length);
  const middle = body.slice(firstLength + marker.length, firstLength + marker.length + middleLength);
  const secretPart = body.slice(firstLength + marker.length + middleLength,
    firstLength + marker.length + middleLength + secret.length);
  const tail = body.slice(firstLength + marker.length + middleLength + secret.length);
  if (markerPart !== marker || secretPart !== secret || tail.length !== tailLength) {
    throw new Error("图片数据校验失败");
  }

  let packed = "";
  const joined = tail + first + middle;
  for (let offset = 0, index = 0; offset < joined.length; offset += chunkSize, index += 1) {
    const chunk = joined.slice(offset, offset + chunkSize);
    packed += index % 2 ? chunk.split("").reverse().join("") : chunk;
  }
  let mapped = "";
  for (const char of packed) {
    const index = sourceAlphabet.indexOf(char);
    if (index < 0) throw new Error("图片数据含未知字符");
    mapped += targetAlphabet[index];
  }
  const decoded = JSON.parse(mangaGmhBase64UrlDecode(mapped));
  return Array.isArray(decoded) ? decoded : [];
}

/** 解码结果是 /cp/... 相对路径，要拼到图片域名上；行号 2 走 nd2，其余走 nd3。 */
function mangaGmhImage(value, line) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const base = Number(line) === 2 ? "https://c-nd2-1.6wm.top/" : "https://c-nd3-1.6wm.top/";
  let target;
  try { target = new URL(raw, base); } catch { return ""; }
  if (!/^(?:[ct]-nd[23]-1\.6wm\.top|m\.g-mh\.org|c-nc-1\.6wm\.top)$/i.test(target.hostname)) {
    // 有些条目直接给的就是完整图片地址，只在白名单内才用
    if (!/\.6wm\.top$/i.test(target.hostname)) return "";
  }
  target.protocol = "https:";
  return proxyWatchAsset(target.toString(), "manga");
}

function mangaGmhSlug(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/\/manga\/([^/?#]+)/);
  if (match) return match[1];
  return /^[A-Za-z0-9_-]{1,80}$/.test(raw) ? raw : "";
}

async function manga4List(q) {
  const path = q ? `/?q=${encodeURIComponent(q)}` : "/";
  const html = await watchFetchHtml(`${WATCH_GMH_BASE}${path}`, `${WATCH_GMH_BASE}/`);
  const items = [];
  const seen = new Set();
  const anchorRe = /<a[^>]+href="\/manga\/([^"?#]+)"[^>]*>([\s\S]{0,1200}?)<\/a>/gi;
  let match;
  while ((match = anchorRe.exec(html)) && items.length < 60) {
    const slug = mangaGmhSlug(match[1]);
    if (!slug || seen.has(slug)) continue;
    const inner = match[2];
    // 卡片上有两个标题类：slicardtitlep 是「时间 + 章节」，slicardtitle 才是漫画名。
    // img 的 alt 最稳，优先用它；类名兜底时用 \b 卡住，别让 titlep 被匹配进来。
    const title = stripTags(inner.match(/<img[^>]+alt="([^"]*)"/i)?.[1] || "")
      || stripTags(inner.match(/class="[^"]*\bslicardtitle\b[^"]*"[^>]*>([\s\S]*?)</i)?.[1] || "");
    if (!title) continue;
    const cover = mangaGmhImage(inner.match(/<img[^>]+(?:data-src|src)="([^"]+)"/i)?.[1] || "", 0);
    seen.add(slug);
    items.push({ id: slug, title, subtitle: "GMH 漫画", cover, description: "", chapterCount: 0 });
  }
  if (!items.length) throw new Error(q ? `没有搜到“${q}”` : "首页没有解析到漫画");
  return items;
}

async function manga4Detail(slug) {
  const url = `${WATCH_GMH_BASE}/manga/${encodeURIComponent(slug)}`;
  const html = await watchFetchHtml(url, `${WATCH_GMH_BASE}/`);
  const config = html.match(/id="chapterDrawerConfig"([^>]*)>/i)?.[1] || "";
  const remoteId = config.match(/data-mid="([^"]+)"/i)?.[1] || "";
  const apiHost = (config.match(/data-api-host="([^"]+)"/i)?.[1] || WATCH_GMH_API_FALLBACK).replace(/\/$/, "");
  if (!remoteId) throw new Error("页面里没有章节配置");
  const payload = await watchFetchJson(
    `${apiHost}/api/v2/manga/get?mid=${encodeURIComponent(remoteId)}&mode=all`, `${WATCH_GMH_BASE}/`
  );
  const detail = payload?.data || {};
  const chapters = (Array.isArray(detail.chapters) ? detail.chapters : []).map((chapter, index) => ({
    id: String(chapter?.id || ""),
    title: stripTags(chapter?.attributes?.title) || `第 ${index + 1} 话`,
    slug: String(chapter?.attributes?.slug || ""),
  })).filter((chapter) => chapter.id);
  if (!chapters.length) throw new Error("没有取到章节列表");
  return {
    id: slug,
    title: stripTags(detail.title) || stripTags(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || "") || slug,
    cover: mangaGmhImage(detail.cover || "", 0),
    description: stripTags(detail.desc || ""),
    chapters,
    remoteId,
    apiHost,
  };
}

async function manga4Chapter(chapterId, remoteId, apiHost) {
  if (!remoteId) throw new Error("缺少远端漫画 ID");
  const host = (apiHost || WATCH_GMH_API_FALLBACK).replace(/\/$/, "");
  const payload = await watchFetchJson(
    `${host}/api/v2/chapter/getinfo?m=${encodeURIComponent(remoteId)}&c=${encodeURIComponent(chapterId)}`,
    `${WATCH_GMH_BASE}/`
  );
  const info = payload?.data?.info;
  if (!info) throw new Error("章节信息返回异常");
  const decoded = mangaGmhDecodeImages(info.images?.images || "");
  const images = [];
  const seen = new Set();
  for (const entry of decoded) {
    const src = mangaGmhImage(typeof entry === "string" ? entry : entry?.url, info.images?.line);
    if (!src || seen.has(src)) continue;
    seen.add(src);
    images.push(src);
    if (images.length >= 300) break;
  }
  if (!images.length) throw new Error("这一话没有解析到图片");
  return { id: String(chapterId), title: stripTags(info.title || ""), images };
}

/* ---------- 源 3：薄荷梨子自家 app/api（原线路，域名可能已失效） ---------- */

/** 按 source 参数把线路收敛成一家；没有有效 source 就保留全部，逐个回落。 */
function mangaOrigins(source) {
  const key = watchText(source, 24).toLowerCase();
  const index = WATCH_MANGA_SOURCE_KEYS.indexOf(key);
  if (index < 0) return WATCH_MANGA_API_ORIGINS;
  const origin = WATCH_MANGA_API_ORIGINS[index];
  return origin ? [origin] : WATCH_MANGA_API_ORIGINS;
}

async function fetchMangaJson(path, params = new URLSearchParams(), source = "") {
  const errors = [];
  for (const origin of mangaOrigins(source)) {
    const url = new URL(`app/api/${path.replace(/^\/+/, "")}`, `${origin}/`);
    params.forEach((value, key) => url.searchParams.set(key, value));
    try {
      const response = await watchFetch(url, { headers: {
        Accept: "application/json,text/plain,*/*", "User-Agent": "Bohe-Lizi-Web/1.0",
      } }, 15000);
      const data = await response.json();
      if (!response.ok || ![200, 201].includes(Number(data?.code))) {
        throw new Error(data?.msg || data?.message || `HTTP ${response.status}`);
      }
      return data;
    } catch (error) { errors.push(`${new URL(origin).hostname}: ${error.message}`); }
  }
  throw new Error(errors.join("; ") || "manga upstream unavailable");
}

async function mangaCrmList(q) {
  const data = q
    ? await fetchMangaJson("search/suggest", new URLSearchParams({ q }))
    : await fetchMangaJson("home/data");
  const source = q
    ? data?.data?.search_suggest
    : (data?.data?.home_content_list || []).flatMap((block) => block?.comic_list || []);
  const items = collectMangaComics(source);
  if (!items.length) throw new Error(q ? `没有搜到“${q}”` : "首页没有返回漫画");
  return items;
}

async function mangaCrmDetail(comicId) {
  const data = await fetchMangaJson(`detail/${comicId}`);
  const raw = data?.data || {};
  const comic = mangaComic(raw) || { id: comicId, title: `漫画 ${comicId}`, subtitle: "漫画", cover: "" };
  const direct = (Array.isArray(raw.chapters) ? raw.chapters : []).map((item, index) => ({
    id: mangaId(item?.id || item?.chapter_id || item?.chapterId),
    title: stripTags(item?.name || item?.title) || `第 ${index + 1} 章`,
  })).filter((item) => item.id);
  const chapters = direct.length ? direct : mangaGroups(raw).map((id, index) => ({
    id, title: `第 ${index + 1} 章`,
  }));
  if (!chapters.length) throw new Error("没有取到章节列表");
  return { ...comic, description: stripTags(raw.content || comic.description || ""), chapters };
}

async function mangaCrmChapter(chapterId) {
  const params = new URLSearchParams({ packname: WATCH_MANGA_PACK, appsign256: WATCH_MANGA_SIGN });
  const data = await fetchMangaJson(`chapter/v2/${chapterId}`, params);
  const images = (Array.isArray(data?.data?.pics) ? data.data.pics : [])
    .map(mangaImageUrl).filter(Boolean).slice(0, 300);
  if (!images.length) throw new Error("章节没有可用图片");
  return { id: chapterId, title: stripTags(data?.data?.name || ""), images };
}

/* ---------- 源调度 ---------- */

const WATCH_MANGA_HANDLERS = {
  manga3r: {
    list: (q) => manga3rList(q),
    detail: (id) => manga3rDetail(id),
    chapter: (id) => manga3rChapter(id),
  },
  manga4: {
    list: (q) => manga4List(q),
    detail: (id) => manga4Detail(id),
    chapter: (id, params) => manga4Chapter(id, params.get("remoteId") || "", params.get("apiHost") || ""),
  },
  crm: {
    list: (q) => mangaCrmList(q),
    detail: (id) => mangaCrmDetail(id),
    chapter: (id) => mangaCrmChapter(id),
  },
};

/** 没指定 source 就按注册顺序依次尝试，全失败才报错。 */
async function mangaDispatch(action, payload, source) {
  const key = watchText(source, 24).toLowerCase();
  const candidates = WATCH_MANGA_SOURCE_IDS.includes(key) ? [key] : WATCH_MANGA_SOURCE_IDS;
  const errors = [];
  for (const id of candidates) {
    const label = WATCH_MANGA_SOURCES.find((item) => item.id === id)?.label || id;
    try {
      const value = await WATCH_MANGA_HANDLERS[id][action](payload.id, payload.params);
      // 把「实际是哪条线出的内容」带回前端 —— 自动模式下用户看不到这个。
      return { value, source: id, sourceLabel: label };
    } catch (error) {
      errors.push(`${label}: ${error.message}`);
    }
  }
  throw new Error(errors.join("; ") || "所有漫画线路都不可用");
}


function mangaImageUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const absolute = absoluteWatchUrl(raw, WATCH_MANGA_IMAGE_ORIGIN);
  if (!absolute) return "";
  const url = new URL(absolute);
  if (!mangaImageHostAllowed(url.hostname)) return "";
  url.protocol = "https:";
  return proxyWatchAsset(url.toString(), "manga");
}

function mangaComic(value) {
  const raw = value || {};
  const id = mangaId(raw.id || raw.comic_id || raw.comicID);
  const title = stripTags(raw.name || raw.comic_name || raw.title || "");
  if (!id || !title) return null;
  const subtitle = stripTags(raw.tags || raw.author || raw.alias) || "漫画";
  return {
    id, title, subtitle, cover: mangaImageUrl(raw.picY || raw.picX || raw.pic || ""),
    description: stripTags(raw.content || ""), chapterCount: Number(raw.nums || raw.chapter_count || 0) || 0,
  };
}

function collectMangaComics(value) {
  const source = Array.isArray(value) ? value : [];
  const result = [], seen = new Set();
  for (const raw of source) {
    const comic = mangaComic(raw);
    if (comic && !seen.has(comic.id)) { seen.add(comic.id); result.push(comic); }
  }
  return result.slice(0, 36);
}

function mangaGroups(value) {
  const groups = [];
  const visit = (node, depth = 0) => {
    if (!node || depth > 4) return;
    if (Array.isArray(node)) return node.forEach((item) => visit(item, depth + 1));
    if (typeof node !== "object") return;
    const hasChapterId = Object.prototype.hasOwnProperty.call(node, "chapter_id")
      || Object.prototype.hasOwnProperty.call(node, "chapterId");
    const insideChapterTree = depth > 1;
    const looksLikeChapter = hasChapterId || (insideChapterTree
      && Object.prototype.hasOwnProperty.call(node, "id"));
    const id = looksLikeChapter ? mangaId(node.chapter_id || node.chapterId || node.id) : "";
    if (id && !groups.includes(id)) groups.push(id);
    Object.entries(node).forEach(([key, child]) => { if (/group|chapter/i.test(key)) visit(child, depth + 1); });
  };
  visit(value);
  return groups;
}

async function watchManga(request, url) {
  const action = watchText(url.searchParams.get("action") || "list", 24);
  const source = watchText(url.searchParams.get("source"), 24);
  const params = url.searchParams;

  // 上游随时可能整批挂掉（换域名 / 被墙）。把「试了哪几条、各自什么错」回给前端，
  // 界面上才能说清是线路问题，而不是一句 internal error。
  const fail = (error) => json({
    error: error.message,
    tried: WATCH_MANGA_SOURCE_IDS.includes(source.toLowerCase())
      ? [source]
      : WATCH_MANGA_SOURCES.map((item) => item.label),
  }, request, 502);

  try {
    if (action === "list") {
      const { value } = await mangaDispatch("list", { id: watchText(params.get("q")) }, source);
      return json({ items: value }, request);
    }

    if (action === "detail") {
      const comicId = watchText(params.get("comic"), 80);
      if (!comicId) return json({ error: "bad comic id" }, request, 400);
      const { value, source: used, sourceLabel: usedLabel } =
        await mangaDispatch("detail", { id: comicId, params }, source);
      // GMH 的章节要带远端 id 和接口域名才能取图，详情里一并回给前端。
      return json({ ...value, source: used, sourceLabel: usedLabel }, request);
    }

    if (action === "chapter") {
      const chapterId = watchText(params.get("chapter"), 80);
      if (!chapterId) return json({ error: "bad chapter id" }, request, 400);
      const { value } = await mangaDispatch("chapter", { id: chapterId, params }, source);
      return json(value, request);
    }

    return json({ error: "unsupported manga action" }, request, 400);
  } catch (error) {
    return fail(error);
  }
}

function parseNovelChapter(html, origin, novelId, chapterId) {
  return parseNovelChapterPage(html, origin, novelId, chapterId);
}

/** 提取 ReadParams 里的关键字段：url_next（分页/下一章）、url_previous、page、subid。 */
function extractNovelReadParams(html) {
  const raw = html.match(/ReadParams\s*=\s*\{([\s\S]*?)\}/)?.[1] || "";
  const pick = (key) => {
    const m = raw.match(new RegExp(`${key}\\s*:\\s*['"]([^'"]*)['"]`));
    return m ? decodeEntities(m[1]) : "";
  };
  return {
    urlNext: pick("url_next"),
    urlPrev: pick("url_previous"),
    page: pick("page"),
    chapterid: pick("chapterid"),
    subid: pick("subid"),
  };
}

/** 解析单页正文（blocks 提取），供 parseNovelChapter 与分页合并共用。 */
function parseNovelChapterPage(html, origin, novelId, chapterId) {
  const title = stripTags(html.match(/<(?:h1|div)[^>]*class=["'][^"']*(?:chapter-title|read-h1)[^"']*["'][^>]*>([\s\S]*?)<\//i)?.[1]
    || html.match(/chaptername\s*:\s*["']([^"']+)/i)?.[1] || `章节 ${chapterId}`);
  const raw = html.match(/<(?:div|article)[^>]*(?:id=["'](?:acontent|TextContent)["']|class=["'][^"']*(?:acontent|TextContent|read-content|chapter-content)[^"']*["'])[^>]*>([\s\S]*?)<\/(?:div|article)>/i)?.[1] || "";
  const blocks = [];
  // 正文里常有未闭合的 <p>（源站 HTML 不规范，段落到页尾才被 </div> 截断），
  // 用「标签起点」分段：每个 <img> 是图，每个 <p> 到下一个 <p>/<img>/容器尾 之间的内容是段落，
  // 而不是死等 </p>，否则每页末尾那段残缺正文会被整体丢掉。
  const tagRe = /<img[^>]+(?:data-src|src)=["']([^"']+)["'][^>]*>|<p[^>]*>/gi;
  const marks = [];
  let tm;
  while ((tm = tagRe.exec(raw))) {
    marks.push({ kind: tm[1] ? "img" : "p", src: tm[1] || "", at: tm.index, end: tagRe.lastIndex });
  }
  for (let i = 0; i < marks.length && blocks.length < 2000; i++) {
    const mark = marks[i];
    if (mark.kind === "img") {
      const imageUrl = absoluteWatchUrl(mark.src, origin);
      // 只按「路径 + 文件名」判广告/图标，绝不能拿整条 URL 判：
      // readpai.com 里的 "re-ad-pai" 含 "ad"，裸子串匹配会把所有插图误杀。
      if (imageUrl && !isNovelDecorationImage(imageUrl)) {
        blocks.push({ type: "image", src: proxyWatchAsset(imageUrl, "novel") });
      }
      continue;
    }
    // 段落内容：从当前 <p> 结束，到下一个 <p>/<img> 的起点（或容器末尾）之间
    const nextMark = marks[i + 1];
    const sliceEnd = nextMark ? nextMark.at : raw.length;
    const segRaw = raw.slice(mark.end, sliceEnd);
    const text = stripTags(segRaw);
    if (text) blocks.push({ type: "text", text });
  }
  if (!blocks.length) {
    const text = stripTags(raw);
    if (text) blocks.push({ type: "text", text });
  }
  return { id: chapterId, novelId, title, blocks };
}

/** 解析桌面版 www.linovelib.com 的完整正文（mlfy_main_text 容器，一页全量）。
 *  桌面版结构：<div id="mlfy_main_text"><h1>标题</h1><div id="TextContent">广告</div>
 *  <p data-k...>正文段落</p> ...（中间穿插 google 广告 div）。
 *  桌面版正文是简体、完整（无分页、无每页截断），但段落是 <p data-k...> 带随机属性，
 *  且混有广告块，需要过滤。 */
function parseNovelDesktopChapter(html, origin, novelId, chapterId) {
  const title = stripTags(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]
    || html.match(/chaptername\s*:\s*["']([^"']+)/i)?.[1] || `章节 ${chapterId}`);
  // 桌面版正文在 id="mlfy_main_text" 里；没有就退回 TextContent。
  // 注意：mlfy_main_text 中的 <p data-k...> 是完整正确顺序的正文段落；
  // #TextContent 是纯 HTTP 抓取的截断/乱序数据，不能作为正文来源。
  let raw = html.match(/id=["']mlfy_main_text["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*</i)?.[1]
    || html.match(/id=["']mlfy_main_text["'][^>]*>([\s\S]*?)<\/body>/i)?.[1]
    || "";
  if (!raw) {
    const idx = html.indexOf('id="mlfy_main_text"');
    if (idx >= 0) raw = html.slice(idx);
  }
  const blocks = [];
  // 桌面版段落是闭合的 <p data-k...>...</p>，但中间会插入广告 div，用起点分段同样兼容。
  const tagRe = /<img[^>]+(?:data-src|data-original|src)=["']([^"']+)["'][^>]*>|<p[^>]*>/gi;
  const marks = [];
  let tm;
  while ((tm = tagRe.exec(raw))) {
    marks.push({ kind: tm[1] ? "img" : "p", src: tm[1] || "", at: tm.index, end: tagRe.lastIndex });
  }
  for (let i = 0; i < marks.length && blocks.length < 3000; i++) {
    const mark = marks[i];
    if (mark.kind === "img") {
      const imageUrl = absoluteWatchUrl(mark.src, origin);
      if (imageUrl && !isNovelDecorationImage(imageUrl)) {
        blocks.push({ type: "image", src: proxyWatchAsset(imageUrl, "novel") });
      }
      continue;
    }
    const nextMark = marks[i + 1];
    const sliceEnd = nextMark ? nextMark.at : raw.length;
    const segRaw = raw.slice(mark.end, sliceEnd);
    const text = stripTags(segRaw);
    if (text) blocks.push({ type: "text", text });
  }
  // 过滤广告残留（google ads / 广告 iframe 文本）
  const cleaned = blocks.filter((block) => {
    if (block.type !== "text") return true;
    const t = block.text;
    return !/^Advertisement$/i.test(t) && !/pagead|googlesyndication|adsbygoogle|googleads/i.test(t);
  });
  return { id: chapterId, novelId, title, blocks: cleaned };
}

/**
 * 抓取某一章的全部正文（含所有分页）并合并成一个 { blocks }。
 *
 * linovelib 每章约 40 段就拆一页，URL 规律：
 *   第 1 页  /novel/{novelId}/{chapterId}.html
 *   第 2 页  /novel/{novelId}/{chapterId}_2.html
 *   第 3 页  /novel/{novelId}/{chapterId}_3.html
 *   …直到页面的 ReadParams.url_next 变成下一个章节（无 _N 后缀）为止。
 *
 * 之前只抓第 1 页，导致"一话只有半话/三分之一内容"。
 */

// 章节内容内存缓存：同一 Worker 实例内重复请求同一章直接命中，避免连续翻章时
// 反复打上游（linovelib 对短时间大量请求会 429 限流，导致某章空白）。
const novelChapterCache = new Map(); // key = `${novelId}/${chapterId}` -> { at, value }

async function fetchNovelChapterAll(env, novelId, chapterId) {
  const cacheKey = `${novelId}/${chapterId}`;
  const cached = novelChapterCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 30 * 60 * 1000) return cached.value; // 30 分钟内存缓存

  // 优先读取 KV 预热缓存（本地 Playwright 批量抓取写入），命中直接返回，不再打上游。
  try {
    const cache = env && env.NOVEL_CACHE; if (!cache) throw new Error('NOVEL_CACHE'); const kvValue = await cache.get(cacheKey);
    if (kvValue) {
      const parsed = JSON.parse(kvValue);
      if (parsed && parsed.blocks && parsed.blocks.length) {
        // 统一格式：KV 缓存可能存为字符串数组或对象数组，均转为 {type:"text",text:...}
        const blocks = parsed.blocks.map(b => typeof b === 'string' ? {type: 'text', text: b} : b);
        const result = {
          id: parsed.id || chapterId,
          novelId: parsed.novelId || novelId,
          title: parsed.title || '',
          blocks,
          pages: parsed.pages || 1
        };
        novelChapterCache.set(cacheKey, { at: Date.now(), value: result });
        return result;
      }
    }
  } catch { /* KV 读取失败不影响主流程 */ }

  // 优先桌面版 www.linovelib.com（桌面 UA + mlfy_main_text 容器）：简体、每页末尾无「內容加載失敗」截断。
  // 桌面版同样分页，但分页信息在 HTML 里的「下一页」链接（_N.html），不在 ReadParams.url_next。
  // 纯 HTTP 可能被反爬返回截断/乱序，此时回退到本地 Playwright 渲染服务。
  try {
    const desktopPages = [];
    let desktopPath = `/novel/${novelId}/${chapterId}.html`;
    for (let i = 0; i < 200; i++) {
      const html = await fetchNovelDesktopHtml(desktopPath);
      desktopPages.push(html);
      // 桌面版「下一页」链接：<a href="/novel/{id}/{chapterId}_N.html">下一页</a>
      const nextMatch = html.match(new RegExp(`href=["'](/novel/${novelId}/${chapterId}_(\\d+)\\.html)["'][^>]*>[^<]*(?:下一頁|下一页|下一章)`));
      if (!nextMatch) break;
      desktopPath = nextMatch[1];
    }
    const desktopBlocks = [];
    for (const pageHtml of desktopPages) {
      const part = parseNovelDesktopChapter(pageHtml, WATCH_NOVEL_DESKTOP_ORIGIN, novelId, chapterId);
      desktopBlocks.push(...part.blocks);
    }
    if (desktopBlocks.length >= 4) {
      const firstPart = parseNovelDesktopChapter(desktopPages[0], WATCH_NOVEL_DESKTOP_ORIGIN, novelId, chapterId);
      const result = { id: chapterId, novelId, title: firstPart.title, blocks: desktopBlocks, pages: desktopPages.length };
      novelChapterCache.set(cacheKey, { at: Date.now(), value: result });
      return result;
    }
  } catch { /* 桌面版拿不到（403/CF），回退手机版 */ }

  const pages = [];
  let path = `/novel/${novelId}/${chapterId}.html`;
  let origin = "";
  // 分页安全阀：单章最多 200 页，防死循环。
  for (let i = 0; i < 200; i++) {
    // 单页抓取也带重试：某页撞上 429/5xx 就重试整页，而不是让整章直接失败。
    let page = null;
    for (let attempt = 0; attempt < 3 && !page; attempt++) {
      try {
        page = await fetchFirstWatchHtml(WATCH_NOVEL_ORIGINS, path);
      } catch (error) {
        if (attempt === 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
      }
    }
    origin = page.origin;
    pages.push(page.html);
    const rp = extractNovelReadParams(page.html);
    // 下一页仍是本章的分页（/novel/{id}/{chapterId}_N.html）→ 继续抓；
    // 否则（变成下一章 /novel/{id}/{other}.html 或为空）→ 结束。
    let nextPagePath = null;
    if (rp.urlNext) {
      // url_next 优先
      const nextMatch = rp.urlNext.match(new RegExp(`/novel/${novelId}/${chapterId}_(\\d+)\\.html$`));
      if (!nextMatch) break; // 是下一章或格式不对 → 结束
      nextPagePath = rp.urlNext;
    } else {
      // url_next 为空时的回退：直接在 HTML 里找分页链接
      // 源站分页链接形如：<a href="/novel/{id}/{chapterId}_2.html">下一页</a>
      // 直接搜 href，比靠 subid/page 推导可靠。
      const pageLinkMatch = page.html.match(
        new RegExp(`href=["'](/novel/${novelId}/${chapterId}_(\\d+)\\.html)["']`)
      );
      if (pageLinkMatch) {
        nextPagePath = pageLinkMatch[1];
      }
    }
    if (!nextPagePath) break;
    path = nextPagePath;
  }
  // 合并所有页的 blocks，剥离分页间那句「內容加載失敗！請重載/刷新或更換瀏覽器」占位。
  // 注意：这个标记常拼接在正常正文末尾（如「……其他同學隨意在接下來的位……（內容加載失敗！請重載或更換瀏覽器）」），
  // 不能整段删除 —— 否则会把标记前面的正常正文一并丢掉，导致每页末尾都缺一句。
  // 正确做法：只剥离标记本身 + 手机版警告；若剥离后整段只剩标点/空白，才丢弃。
  // 另外不做相邻段落去重 —— 正文里可能存在合法的连续相同段落（如两个「……」），去重会导致内容错位。
  // 标记变体（不同镜像源用词不同，实测 4 种以上）：
  //   （內容加載失敗！請重載或更換瀏覽器）  tw 源
  //   （內容加載失敗！請刷新或更換瀏覽器）  bilinovel / www 源
  //   （内容加载失败！请重载/刷新或更换浏览器）  简体镜像
  // 用「加载失败 + 请 + 重载/刷新 + … + 浏览器」的宽松结构匹配，避免漏掉或/更换等中间词。
  const LOAD_FAIL_MARK = /[（(]?(?:內容加載失敗|内容加载失败)[！!]?(?:請|请)?(?:重載|重载|刷新)[^\n]{0,12}?(?:瀏覽器|浏览器)[)）]?/g;
  const MOBILE_WARN = /【手機版頁面由於相容性問題暫不支持電腦端閱讀，請使用手機閱讀。】|【手机版页面由于兼容性问题暂不支持电脑端阅读，请使用手机阅读。】/g;
  const merged = [];
  for (const pageHtml of pages) {
    const part = parseNovelChapterPage(pageHtml, origin, novelId, chapterId);
    for (const block of part.blocks) {
      if (block.type === "text") {
        let text = String(block.text || "");
        if (!text) continue;
        // 整段就是加载失败占位 → 丢弃
        if (/^(?:內容加載失敗|内容加载失败|加載失敗|加载失败)[！!]?/.test(text.trim())) continue;
        // 剥离拼接在正文末尾的加载失败标记 + 手机版警告
        text = text.replace(LOAD_FAIL_MARK, "").replace(MOBILE_WARN, "").trim();
        if (text && !/^[……。、，．\s]*$/.test(text)) merged.push({ type: "text", text });
      } else {
        merged.push(block);
      }
    }
  }
  const first = pages.length ? parseNovelChapterPage(pages[0], origin, novelId, chapterId) : { title: `章节 ${chapterId}` };
  const result = { id: chapterId, novelId, title: first.title, blocks: merged, pages: pages.length };
  // 只有抓到内容才缓存；空结果不缓存（下次重试还能再抓一次）。
  if (result.blocks.length) {
    if (novelChapterCache.size > 200) {
      // 简单淘汰：清掉最旧的一半，避免内存无限增长。
      const keys = [...novelChapterCache.keys()];
      for (const k of keys.slice(0, 100)) novelChapterCache.delete(k);
    }
    novelChapterCache.set(cacheKey, { at: Date.now(), value: result });
  }
  return result;
}

function animationPath(value, pattern) {
  try {
    const parsed = new URL(decodeEntities(value), WATCH_ANIME_ORIGINS[0]);
    if (!WATCH_ANIME_ORIGINS.some((origin) => new URL(origin).hostname === parsed.hostname)) return "";
    return pattern.test(parsed.pathname) ? parsed.pathname : "";
  } catch { return ""; }
}

function parseAnimeCards(html, origin) {
  const items = [], seen = new Set();
  for (const link of html.matchAll(/<a[^>]+href=["'](\/detail\/(\d+)\.html)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    if (seen.has(link[2])) continue;
    const start = Math.max(0, link.index - 500);
    const end = Math.min(html.length, link.index + link[0].length + 1000);
    const block = html.slice(start, end);
    const title = stripTags(block.match(/class=["']title["'][^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)?.[1]
      || link[3] || link[0].match(/title=["']([^"']+)/i)?.[1]);
    const image = block.match(/(?:data-src|data-original)=["']([^"']+)["']/i)?.[1]
      || block.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1] || "";
    let coverUrl = absoluteWatchUrl(image, origin);
    if (coverUrl && coverUrl.startsWith("http:")) {
      // 上游图片是 http://p.qpic.cn/...（腾讯图床），代理只收 https，
      // 不升级的话封面一律 403，动画区全是有图无封面的占位卡。
      coverUrl = coverUrl.replace(/^http:/, "https:");
    }
    if (!title || !coverUrl || /placeholder/i.test(coverUrl)) continue;
    seen.add(link[2]);
    items.push({ id: link[2], title, subtitle: "在线动画", cover: proxyWatchAsset(coverUrl, "anime") });
    if (items.length >= 36) break;
  }
  return items;
}

function animeEmbedUrl(value, origin = WATCH_ANIME_ORIGINS[0]) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const absolute = absoluteWatchUrl(raw, origin);
  if (!absolute) return "";
  const target = new URL(absolute);
  if (target.protocol === "http:") target.protocol = "https:";
  if (target.protocol !== "https:") return "";
  const host = target.hostname.toLowerCase();
  const allowed = WATCH_VIDEO_HOSTS.test(host)
    || WATCH_ANIME_ORIGINS.some((item) => host === new URL(item).hostname);
  return allowed ? target.toString() : "";
}

function parseAnimeEpisodes(html) {
  const episodes = [], seen = new Set();
  for (const match of html.matchAll(/<a[^>]+href=["'](\/play\/(\d+_\d+_\d+)\.html)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    if (seen.has(match[2])) continue;
    seen.add(match[2]);
    episodes.push({
      id: match[2],
      title: stripTags(match[3]) || `第 ${episodes.length + 1} 集`,
    });
  }
  return episodes.slice(0, 2000);
}

function parseAnimePlayer(html, origin, episode) {
  const iframe = html.match(/<iframe[^>]+src=["']([^"']+)["']/i)?.[1] || "";
  let embedUrl = animeEmbedUrl(iframe, origin);
  if (embedUrl) return embedUrl;
  const raw = html.match(/var\s+player_aaaa\s*=\s*(\{[\s\S]*?\})\s*(?:<\/script>|;)/i)?.[1];
  let player = null;
  try { player = raw ? JSON.parse(raw) : null; } catch { player = null; }
  const referer = `${origin}/play/${episode}.html`;
  if (player?.from === "vxdev" && player.url) {
    embedUrl = `https://yun.92cj.com/yunbox/?type=vxdev&vid=${encodeURIComponent(player.url)}&referer=${encodeURIComponent(referer)}`;
  } else if (player?.from === "xgvxcd" && player.url) {
    embedUrl = `https://yun.92cj.com/yunbox/?type=vxcd&vid=${encodeURIComponent(player.url)}&referer=${encodeURIComponent(referer)}`;
  } else if (player?.url) {
    embedUrl = animeEmbedUrl(player.url, origin);
  }
  return animeEmbedUrl(embedUrl, origin);
}

/* ---------- 动画区：量子资源 API（cj.lziapi.com） ----------
 *
 * 之前上游是 lmm85（路漫漫）网页抓取 + yun.92cj 播放器代理。lmm85 对
 * Worker 数据中心 IP 恒定挂 Cloudflare challenge（403/520），且其手机站
 * 现在把播放强推到 APK，网页端基本播不了。现换成资源站 JSON API：
 * 这是专门给聚合站用的开放接口，无 CF 挑战、直接返回每集 m3u8（lzm3u8
 * 线路），CORS ACAO=*，浏览器 hls.js 可直连，Worker 只透传 JSON。
 */
const WATCH_ANIME_API = "https://cj.lziapi.com/api.php/provide/vod/";
const WATCH_ANIME_TYPE = "30"; // 日韩动漫（量子把子类挂细分 id，父类 4 只有 1 部）

async function watchAnimeJson(params) {
  const target = new URL(WATCH_ANIME_API);
  target.search = new URLSearchParams(params);
  const response = await watchFetch(target, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } }, 20000);
  if (!response.ok) throw new Error(`anime upstream HTTP ${response.status}`);
  return await response.json();
}

/** vod_play_url 形如 "线路1$$$线路2"，每段内 "第01集$url#第02集$url"。
 *  只保留直连 m3u8 的线路（lzm3u8），share 页线路（liangzi）前端播不了，丢弃。 */
function parseAnimeLines(entry) {
  const froms = String(entry?.vod_play_from || "").split("$$$");
  const chunks = String(entry?.vod_play_url || "").split("$$$");
  const lines = [];
  froms.forEach((label, i) => {
    const eps = (chunks[i] || "").split("#").filter(Boolean).map((pair) => {
      const idx = pair.indexOf("$");
      if (idx < 0) return null;
      return { ep: watchText(pair.slice(0, idx), 60), url: watchText(pair.slice(idx + 1), 600) };
    }).filter((e) => e && /^https?:\/\/.+\.m3u8/i.test(e.url)).slice(0, 2000);
    if (eps.length) lines.push({ label: stripTags(label) || `线路${i + 1}`, eps });
  });
  return lines;
}

async function watchAnime(request, url) {
  const action = watchText(url.searchParams.get("action") || "list", 24);
  if (action === "list") {
    const q = watchText(url.searchParams.get("q"));
    const page = Math.min(Math.max(parseInt(url.searchParams.get("page") || "1", 10) || 1, 1), 500);
    const data = q
      ? await watchAnimeJson({ ac: "videolist", wd: q, pg: String(page) })
      : await watchAnimeJson({ ac: "videolist", t: WATCH_ANIME_TYPE, pg: String(page) });
    const totalPages = Math.min(Number(data?.pagecount) || page, 500);
    const items = (data?.list || []).map((entry) => ({
      id: watchText(entry?.vod_id, 20),
      title: stripTags(entry?.vod_name) || `动画 ${entry?.vod_id}`,
      subtitle: stripTags(entry?.vod_remarks) || stripTags(entry?.vod_class) || "在线动画",
      cover: watchText(entry?.vod_pic, 500),
      year: watchText(entry?.vod_year, 16),
      description: stripTags(entry?.vod_blurb).slice(0, 160),
    })).filter((item) => /^\d+$/.test(item.id));
    return json({ items, page, totalPages, hasPrev: page > 1, hasNext: page < totalPages }, request);
  }
  if (action === "detail") {
    const animeId = watchText(url.searchParams.get("anime"), 20);
    if (!/^\d+$/.test(animeId)) return json({ error: "bad anime id" }, request, 400);
    const data = await watchAnimeJson({ ac: "videolist", ids: animeId });
    const entry = data?.list?.[0];
    if (!entry) return json({ error: "动画不存在或已下架" }, request, 404);
    return json({
      id: animeId,
      title: stripTags(entry.vod_name) || `动画 ${animeId}`,
      cover: watchText(entry.vod_pic, 500),
      year: watchText(entry.vod_year, 16),
      description: stripTags(entry.vod_content).slice(0, 600),
      lines: parseAnimeLines(entry),
      sourceSite: "https://www.lmm85.com",
    }, request);
  }
  return json({ error: "unsupported anime action" }, request, 400);
}

/* ---------- 动画播放器代理 ----------
 *
 * 播放器（yun.92cj.com/yunbox）校验 Referer：来自动画站（lmm85.com）才给
 * 真页面，来自 xrzka.github.io 只回 3 字节 "pir"。iframe 没法带上游 Referer，
 * 所以由 Worker 代取播放器 HTML 原样返回，页面里的相对请求 vxdev.php
 * 也经 /api/watch/vxdev.php 代理回播放器（带同样的 Referer）。页面内部的
 * token 计算是混淆 JS，在用户浏览器里原样执行，Worker 不碰。
 */

const WATCH_PLAYER_ORIGIN = "https://yun.92cj.com";
const WATCH_PLAYER_REFERER = "https://www.lmm85.com/";
// 播放器页引用的第三方资源（DPlayer/hls/jQuery 等），按路径转发。
const WATCH_PLAYER_ASSET_HOSTS = new Set([
  "registry.npmmirror.com", "work-order.b0.upaiyun.com",
]);

/** 校验代理目标必须是播放器域，防止变成开放代理。 */
function playerProxyTarget(value) {
  let target;
  try { target = new URL(String(value || "")); } catch { return null; }
  if (target.protocol !== "https:" || target.hostname !== new URL(WATCH_PLAYER_ORIGIN).hostname) return null;
  return target;
}

/** 播放器页 HTML 代理：改写相对的 vxdev.php 成同域代理路由。 */
async function watchPlayerFrame(request, url) {
  const target = playerProxyTarget(url.searchParams.get("src"));
  if (!target) return json({ error: "bad player url" }, request, 400);
  const response = await watchFetch(target, { headers: {
    "User-Agent": "Mozilla/5.0", Referer: WATCH_PLAYER_REFERER, Accept: "text/html,*/*",
  } }, 25000);
  if (!response.ok) return json({ error: `player HTTP ${response.status}` }, request, 502);
  let html = await response.text();
  // 相对请求 vxdev.php / vxcd.php 改写成绝对代理地址
  html = html.replace(/(["'(=])(vxdev|vxcd)\.php/g,
    `$1/api/watch/$2.php?src=${encodeURIComponent(WATCH_PLAYER_ORIGIN + "/yunbox/")}`);
  return new Response(html, { status: 200, headers: {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    ...corsHeaders(request).headers,
  } });
}

/** vxdev.php / vxcd.php 的 POST 代理（表单字段原样透传）。 */
async function watchPlayerApi(request, url) {
  const base = url.searchParams.get("src") || `${WATCH_PLAYER_ORIGIN}/yunbox/`;
  const api = url.pathname.endsWith("vxcd.php") ? "vxcd.php" : "vxdev.php";
  const form = await request.formData().catch(() => new FormData());
  const body = new URLSearchParams();
  form.forEach((value, key) => body.set(key, String(value)));
  const response = await watchFetch(`${base}${api}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0", Referer: WATCH_PLAYER_REFERER,
      Origin: WATCH_PLAYER_ORIGIN,
    },
    body: body.toString(),
  }, 25000);
  const text = await response.text();
  return new Response(text, { status: response.status, headers: {
    "Content-Type": response.headers.get("Content-Type") || "application/json",
    "Cache-Control": "no-store",
    ...corsHeaders(request).headers,
  } });
}

async function watchAsset(request, url) {
  const kind = watchText(url.searchParams.get("kind"), 12);
  let target;
  try { target = new URL(url.searchParams.get("url") || ""); } catch { return json({ error: "bad asset url" }, request, 400); }
  const host = target.hostname.toLowerCase();
  const allowed = target.protocol === "https:" && (
    (kind === "novel" && novelImageHostAllowed(host))
    || (kind === "manga" && mangaImageHostAllowed(host))
    || (kind === "anime" && (WATCH_VIDEO_HOSTS.test(host) || WATCH_ANIME_ORIGINS.some((origin) => host === new URL(origin).hostname)))
  );
  if (!allowed) return json({ error: "asset host not allowed" }, request, 403);
  const response = await watchFetch(target, { headers: { Referer: kind === "novel" ? `${WATCH_NOVEL_ORIGINS[0]}/` : "", "User-Agent": "Mozilla/5.0" } }, 25000);
  if (!response.ok) return json({ error: `asset upstream HTTP ${response.status}` }, request, 502);
  const headers = new Headers(corsHeaders(request).headers);
  headers.set("Content-Type", response.headers.get("Content-Type") || "application/octet-stream");
  headers.set("Cache-Control", "public, max-age=3600");
  return new Response(response.body, { status: 200, headers });
}

/**
 * 按 IP 限流。计数放 KV（env.RATE），没绑 KV 就跳过限流。
 * 用 KV 而不是 D1：这里丢几次计数无所谓，但不想给 D1 加写压力。
 */
async function rateLimited(env, ip) {
  if (!env.RATE || !ip) return false;
  const key = `rl:${ip}:${Math.floor(Date.now() / 60000)}`;
  const cur = Number((await env.RATE.get(key)) || 0);
  if (cur >= RATE_LIMIT) return true;
  await env.RATE.put(key, String(cur + 1), { expirationTtl: 120 });
  return false;
}

/** 点击 +1。五个周期各写一行，batch 走一次往返。 */
async function recordHit(env, id) {
  const b = buckets();
  const stmt = env.DB.prepare(
    `INSERT INTO clicks (period, bucket, item, n) VALUES (?, ?, ?, 1)
     ON CONFLICT (period, bucket, item) DO UPDATE SET n = n + 1`
  );
  await env.DB.batch(PERIODS.map((p) => stmt.bind(p, b[p], id)));
}

/**
 * 访问人数 +1。先往 seen 表 INSERT OR IGNORE 访客指纹，
 * meta.changes === 1 说明这个桶里第一次见到他，才给 visits 加数。
 * 所以 visits 是「人数」不是「次数」。
 */
async function recordVisit(env, request) {
  const b = buckets();
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const ua = request.headers.get("User-Agent") || "";
  // 指纹带上当天日期，跨天的记录无法互相关联
  const fp = (await sha256Hex(`${ip}|${ua}|${b.day}`)).slice(0, 32);

  const insertSeen = env.DB.prepare("INSERT OR IGNORE INTO seen (k, day) VALUES (?, ?)");
  const bumpVisit = env.DB.prepare(
    `INSERT INTO visits (period, bucket, n) VALUES (?, ?, 1)
     ON CONFLICT (period, bucket) DO UPDATE SET n = n + 1`
  );

  for (const p of PERIODS) {
    const r = await insertSeen.bind(`${p}|${b[p]}|${fp}`, b.day).run();
    if (r.meta && r.meta.changes === 1) await bumpVisit.bind(p, b[p]).run();
  }
}

/** 各周期 Top N 点击 + 访问人数。 */
async function readStats(env) {
  const b = buckets();
  const clicks = {};
  const visitors = {};

  const rank = env.DB.prepare(
    "SELECT item, n FROM clicks WHERE period = ? AND bucket = ? ORDER BY n DESC LIMIT ?"
  );
  const vis = env.DB.prepare("SELECT n FROM visits WHERE period = ? AND bucket = ?");

  for (const p of PERIODS) {
    const { results } = await rank.bind(p, b[p], RANK_LIMIT).all();
    clicks[p] = Object.fromEntries((results || []).map((r) => [r.item, r.n]));
    const v = await vis.bind(p, b[p]).first();
    visitors[p] = v ? v.n : 0;
  }
  return { clicks, visitors, buckets: b };
}

/* ---------- 资源帮找 ---------- */

/**
 * 清洗用户提交的文本。
 * - 去掉控制字符与零宽字符（零宽字符能用来伪造「不同」的重复标题）
 * - 折叠连续空白，首尾裁剪
 * - 按字符数截断（不是字节，中文不该被腰斩）
 * 不做 HTML 转义：前端全部走 textContent，转义反而会显示成乱码。
 */
function sanitizeText(raw, max) {
  if (typeof raw !== "string") return "";
  // 必须用 \u 转义写法：把控制字符原样写进源码会破坏正则字面量。
  //
  // 两类字符处理方式不同，不能合并：
  // - 控制字符（换行、制表等）是词的分隔，替换成空格
  // - 零宽字符本身不可见，必须整个删掉。若也换成空格，「咒<ZWSP>术」会变成
  //   「咒 术」，去重键仍与「咒术」不同，绕过去重的口子就没堵上。
  const CTRL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
  const ZERO_WIDTH = /[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g;
  const cleaned = raw
    .replace(ZERO_WIDTH, "")
    .replace(CTRL, " ")
    .replace(/\s+/g, " ")
    .trim();
  return [...cleaned].slice(0, max).join("");
}

/** 去重键：小写 + 只保留数字、拉丁字母与中日韩文字，让「进击的巨人」和
 *  「进击的巨人！！」算同一条。
 *
 *  字符范围用 \u 转义而不是直接写汉字。之前一度以为「线上中文提交失败」是
 *  部署破坏了源码编码，实际原因是我用 bash + curl 发的测试请求 —— Git Bash
 *  的 GBK 控制台在到达 curl 之前就把中文改坏了。用 Python 显式编码 UTF-8
 *  重发即通过。转义写法仍然保留：它不依赖整条工具链的编码行为。 */
function normalizeTitle(title) {
  const KEEP = /[\u0030-\u0039\u0061-\u007a\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af\u3400-\u4dbf\uf900-\ufaff]/;
  return [...title.toLowerCase()].filter((ch) => KEEP.test(ch)).join("");
}

/** 当天访客指纹。和访问统计同一套算法：日期当盐，无法反查 IP。 */
async function visitorFp(request) {
  const b = buckets();
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const ua = request.headers.get("User-Agent") || "";
  return (await sha256Hex(`${ip}|${ua}|${b.day}`)).slice(0, 32);
}

/** 列出请求。kind / status 可过滤；按票数降序，同票数按新的在前。 */
async function listRequests(env, url) {
  const kind = url.searchParams.get("kind") || "";
  const status = url.searchParams.get("status") || "";
  const limit = Math.min(
    Math.max(parseInt(url.searchParams.get("limit") || "60", 10) || 60, 1),
    REQ_PAGE_MAX
  );

  const where = [];
  const args = [];
  if (REQ_KINDS.includes(kind)) {
    where.push("kind = ?");
    args.push(kind);
  }
  if (["open", "found", "closed"].includes(status)) {
    where.push("status = ?");
    args.push(status);
  }
  const clause = where.length ? "WHERE " + where.join(" AND ") : "";

  const sql =
    `SELECT id, kind, item_id, display AS title, note, status, votes, reply, created ` +
    `FROM requests ${clause} ORDER BY votes DESC, id DESC LIMIT ?`;
  const { results } = await env.DB.prepare(sql).bind(...args, limit).all();

  // 汇总按 kind 分开算，前端两块面板各显示自己的计数
  const counts = await env.DB
    .prepare("SELECT kind, status, COUNT(*) c FROM requests GROUP BY kind, status")
    .all();
  const blank = () => ({ open: 0, found: 0, closed: 0 });
  const summary = { want: blank(), broken: blank() };
  (counts.results || []).forEach((r) => {
    if (summary[r.kind] && r.status in summary[r.kind]) summary[r.kind][r.status] = r.c;
  });

  return { items: results || [], summary };
}

/**
 * 新建请求。两种 kind：
 *   want   访客想要站里没有的资源，title 是作品名
 *   broken 访客报告站内某条资源失效，item_id 指向那条资源
 *
 * 重复提交不插新行，而是给已有的那条 +1 票 —— 同一部作品多人想要、
 * 同一条资源多人报失效，票数才有意义，分散成多条反而看不出热度。
 */
async function createRequest(env, request, body) {
  const kind = REQ_KINDS.includes(body.kind) ? body.kind : "want";
  const broken = kind === "broken";

  const title = sanitizeText(body.title, REQ_TITLE_MAX);
  const note = sanitizeText(body.note, REQ_NOTE_MAX);
  // item_id 是精确匹配的键，只能校验不能清洗 —— 用 sanitizeText 截断到 64
  // 会让超长 id 变成另一个合法 id，可能撞上真实条目，把反馈记到错误的资源上。
  const itemId = broken ? String(body.item_id ?? "").trim() : "";

  if (broken) {
    if (!ID_RE.test(itemId)) {
      return { status: 400, body: { error: "缺少有效的资源 id" } };
    }
  } else if (!title) {
    return { status: 400, body: { error: "作品名不能为空" } };
  }

  // 去重键：want 用标准化后的作品名，broken 用 item: 前缀 + 条目 id。
  // 两种 kind 的键空间不同，唯一索引建在 (kind, title) 上，互不干扰。
  const norm = broken ? "item:" + itemId : normalizeTitle(title);
  if (!norm || norm === "item:") {
    return { status: 400, body: { error: "作品名需要包含有效文字" } };
  }

  const fp = await visitorFp(request);
  const b = buckets();

  // 每日提交条数上限，按指纹与 kind 分别算 —— 报失效和求资源是两件事，
  // 报了 5 条失效就不能再求资源，那样太苛刻
  const mine = await env.DB
    .prepare("SELECT COUNT(*) c FROM requests WHERE fp = ? AND kind = ? AND created LIKE ?")
    .bind(fp, kind, b.day + "%")
    .first();
  if (mine && mine.c >= REQ_PER_DAY) {
    return { status: 429, body: { error: `今天已提交 ${REQ_PER_DAY} 条，明天再来吧` } };
  }

  const dup = await env.DB
    .prepare("SELECT id FROM requests WHERE kind = ? AND title = ?")
    .bind(kind, norm)
    .first();
  if (dup) {
    const voted = await voteRequest(env, request, dup.id);
    return {
      status: 200,
      body: { ok: true, id: dup.id, merged: true, voted: voted.body.ok === true },
    };
  }

  const open = await env.DB
    .prepare("SELECT COUNT(*) c FROM requests WHERE status = 'open'")
    .first();
  if (open && open.c >= REQ_OPEN_MAX) {
    return { status: 503, body: { error: "待处理的反馈太多了，等清理一批后再提交" } };
  }

  // display 存展示用的原文。broken 没填标题时用条目 id 兜底，
  // 列表上至少能看出是哪条资源。
  const display = title || itemId;
  const created = new Date().toISOString();
  const res = await env.DB
    .prepare(
      `INSERT INTO requests (kind, item_id, title, display, note, status, votes, reply, created, fp)
       VALUES (?, ?, ?, ?, ?, 'open', 1, '', ?, ?)`
    )
    .bind(kind, itemId, norm, display, note, created, fp)
    .run();

  // 提交者自己那一票也要记进去重表，否则他能再点一次 +1
  await env.DB
    .prepare("INSERT OR IGNORE INTO request_votes (k, day) VALUES (?, ?)")
    .bind(`${res.meta.last_row_id}|${fp}`, b.day)
    .run();

  return { status: 200, body: { ok: true, id: res.meta.last_row_id } };
}

/** +1（想看 / 我也遇到失效）。同一指纹对同一条只能投一次。 */
async function voteRequest(env, request, rawId) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return { status: 400, body: { error: "bad id" } };
  }

  const row = await env.DB.prepare("SELECT id FROM requests WHERE id = ?").bind(id).first();
  if (!row) return { status: 404, body: { error: "反馈不存在" } };

  const fp = await visitorFp(request);
  const b = buckets();
  const ins = await env.DB
    .prepare("INSERT OR IGNORE INTO request_votes (k, day) VALUES (?, ?)")
    .bind(`${id}|${fp}`, b.day)
    .run();

  // changes === 0 说明这个指纹已经投过了，不重复加票
  if (!ins.meta || ins.meta.changes !== 1) {
    return { status: 200, body: { ok: false, reason: "already voted" } };
  }

  await env.DB.prepare("UPDATE requests SET votes = votes + 1 WHERE id = ?").bind(id).run();
  return { status: 200, body: { ok: true } };
}

/* ---------- 反馈运维（需要管理员登录） ---------- */

/** 允许的状态流转目标。open 待处理 / found 已处理 / closed 关闭。 */
const REQ_STATUSES = ["open", "found", "closed"];

/**
 * 改一条反馈的状态与回复。
 *
 * 之前只能在 D1 里手敲 UPDATE，站长看到「已补档」也没法在页面上标掉，
 * 待补档那个数字会一直挂着。现在后台登录后可以直接点。
 */
async function updateRequest(env, body) {
  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) {
    return { status: 400, body: { error: "缺少有效的反馈 id" } };
  }

  const row = await env.DB.prepare("SELECT id FROM requests WHERE id = ?").bind(id).first();
  if (!row) return { status: 404, body: { error: "反馈不存在" } };

  const sets = [];
  const args = [];

  if (body.status !== undefined) {
    const status = String(body.status ?? "").trim();
    if (!REQ_STATUSES.includes(status)) {
      return { status: 400, body: { error: `未知状态：${status}` } };
    }
    sets.push("status = ?");
    args.push(status);
  }

  if (body.reply !== undefined) {
    // 回复会显示在访客能看到的卡片上，所以和访客提交的文本同样清洗
    sets.push("reply = ?");
    args.push(sanitizeText(body.reply, REQ_NOTE_MAX));
  }

  if (!sets.length) return { status: 400, body: { error: "没有要改的字段" } };

  await env.DB
    .prepare(`UPDATE requests SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...args, id)
    .run();
  return { status: 200, body: { ok: true, id } };
}

/**
 * 删除一条反馈。连带删掉它的投票去重键 —— 不删的话，同一个访客以后
 * 再报同一条资源会被当成「已投过」而静默失败。
 */
async function deleteRequest(env, rawId) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return { status: 400, body: { error: "缺少有效的反馈 id" } };
  }
  const res = await env.DB.prepare("DELETE FROM requests WHERE id = ?").bind(id).run();
  if (!res.meta || res.meta.changes !== 1) {
    return { status: 404, body: { error: "反馈不存在" } };
  }
  await env.DB.prepare("DELETE FROM request_votes WHERE k LIKE ?").bind(`${id}|%`).run();
  return { status: 200, body: { ok: true, id } };
}

/**
 * 批量清理已处理完的反馈。默认清 found + closed —— 那些是站长自己标过的，
 * 留着只是占列表。open 不在默认范围里：还没处理的东西不该被一键抹掉。
 *
 * @param kind  只清某一类（want / broken），不传则两类都清
 * @param statuses 要清的状态，默认 ['found','closed']
 */
async function purgeRequests(env, body) {
  const kind = REQ_KINDS.includes(body.kind) ? body.kind : "";
  const raw = Array.isArray(body.statuses) ? body.statuses : ["found", "closed"];
  const statuses = raw.filter((s) => REQ_STATUSES.includes(s));
  if (!statuses.length) return { status: 400, body: { error: "没有有效的状态" } };

  const where = [`status IN (${statuses.map(() => "?").join(",")})`];
  const args = [...statuses];
  if (kind) {
    where.push("kind = ?");
    args.push(kind);
  }
  const clause = where.join(" AND ");

  // 先取出要删的 id，才能连带清掉它们的投票去重键
  const { results } = await env.DB
    .prepare(`SELECT id FROM requests WHERE ${clause}`)
    .bind(...args)
    .all();
  const ids = (results || []).map((r) => r.id);
  if (!ids.length) return { status: 200, body: { ok: true, deleted: 0 } };

  await env.DB.prepare(`DELETE FROM requests WHERE ${clause}`).bind(...args).run();
  // LIKE 一条条删。id 数量是站长手动标出来的，不会多到需要优化
  for (const id of ids) {
    await env.DB.prepare("DELETE FROM request_votes WHERE k LIKE ?").bind(`${id}|%`).run();
  }
  return { status: 200, body: { ok: true, deleted: ids.length } };
}

/* ---------- 管理员编辑 ---------- */

/** 随机 hex 串，用于 session token。crypto.getRandomValues 是 CSPRNG。 */
function randomHex(bytes = 32) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * PBKDF2-SHA256 派生。存的哈希格式是 `pbkdf2$迭代次数$盐hex$派生hex`，
 * 自带参数，以后调迭代次数不会让旧哈希失效。
 */
async function pbkdf2Hex(password, saltHex, iter = PBKDF2_ITER) {
  const salt = new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 定长比较。逐字符异或累加，不提前 return —— 避免按耗时逐位猜出正确值。 */
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 校验密码。ADMIN_PASSWORD_HASH 是 Cloudflare secret，不进 git 也不进前端。 */
async function checkPassword(env, password) {
  const stored = env.ADMIN_PASSWORD_HASH || "";
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iter = parseInt(parts[1], 10);
  if (!Number.isInteger(iter) || iter < 1000) return false;
  const got = await pbkdf2Hex(password, parts[2], iter);
  return timingSafeEqual(got, parts[3]);
}

/** 登录限流。按 IP + 分钟窗计数，只在密码错时才加，避免正常登录被自己挡住。 */
async function loginThrottled(env, ip) {
  if (!ip) return false;
  const win = String(Math.floor(Date.now() / 60000));
  const row = await env.DB
    .prepare("SELECT n, window FROM admin_throttle WHERE k = ?").bind(ip).first();
  if (!row || row.window !== win) return false;
  return row.n >= LOGIN_TRIES;
}

async function bumpLoginFail(env, ip) {
  if (!ip) return;
  const win = String(Math.floor(Date.now() / 60000));
  await env.DB.prepare(
    `INSERT INTO admin_throttle (k, n, window) VALUES (?, 1, ?)
     ON CONFLICT (k) DO UPDATE SET
       n = CASE WHEN admin_throttle.window = excluded.window THEN admin_throttle.n + 1 ELSE 1 END,
       window = excluded.window`
  ).bind(ip, win).run();
}

/** 登录，成功则发一个 12 小时有效的 session token。 */
async function adminLogin(env, request, body) {
  const ip = request.headers.get("CF-Connecting-IP") || "";
  if (!env.ADMIN_PASSWORD_HASH) {
    return { status: 503, body: { error: "后台未启用（未设置 ADMIN_PASSWORD_HASH）" } };
  }
  if (await loginThrottled(env, ip)) {
    return { status: 429, body: { error: "尝试太频繁，等一分钟再试" } };
  }
  const password = typeof body.password === "string" ? body.password : "";
  if (!password || !(await checkPassword(env, password))) {
    await bumpLoginFail(env, ip);
    // 不区分「没这个用户」和「密码错」，少给一点探测信息
    return { status: 401, body: { error: "密码不对" } };
  }

  const token = randomHex(32);
  const now = new Date();
  const exp = new Date(now.getTime() + SESSION_HOURS * 3600000);
  await env.DB.prepare(
    "INSERT INTO admin_sessions (token, created, expires, ip) VALUES (?, ?, ?, ?)"
  ).bind(token, now.toISOString(), exp.toISOString(), ip).run();

  return { status: 200, body: { ok: true, token, expires: exp.toISOString() } };
}

/** 从 Authorization: Bearer 取 token 并校验。过期的顺手删掉。 */
async function adminAuth(env, request) {
  const raw = request.headers.get("Authorization") || "";
  const m = raw.match(/^Bearer\s+([0-9a-f]{64})$/i);
  if (!m) return null;
  const token = m[1].toLowerCase();
  const row = await env.DB
    .prepare("SELECT token, expires FROM admin_sessions WHERE token = ?").bind(token).first();
  if (!row) return null;
  if (new Date(row.expires).getTime() <= Date.now()) {
    await env.DB.prepare("DELETE FROM admin_sessions WHERE token = ?").bind(token).run();
    return null;
  }
  return token;
}

async function adminLogout(env, token) {
  await env.DB.prepare("DELETE FROM admin_sessions WHERE token = ?").bind(token).run();
  return { status: 200, body: { ok: true } };
}

/** 读全部覆盖。前端加载 items.json 后用它盖住原值，所以要一次全给。 */
async function listOverrides(env) {
  const cols = OVERRIDE_FIELDS.join(", ");
  const { results } = await env.DB
    .prepare(`SELECT item_id, ${cols}, updated FROM overrides ORDER BY updated DESC`)
    .all();
  const map = {};
  (results || []).forEach((r) => {
    const o = {};
    OVERRIDE_FIELDS.forEach((f) => {
      // null 表示这个字段没被覆盖，别塞进去 —— 否则前端会把原值盖成 null
      if (r[f] !== null && r[f] !== undefined) {
        o[f] = f === "deleted" ? r[f] === 1 : r[f];
      }
    });
    o.updated = r.updated;
    map[r.item_id] = o;
  });
  return { overrides: map, count: Object.keys(map).length };
}

/**
 * 保存一条覆盖。body: { item_id, fields: {name?, description?, url?, password?, note?} }
 *
 * 语义约定：
 *   字段给了字符串 -> 覆盖成这个值（空串就是「显示为空」）
 *   字段给 null    -> 撤销这一项的覆盖，回到 items.json 的原值
 *   字段没出现     -> 保持现状，不动
 */
async function saveOverride(env, body) {
  const itemId = String(body.item_id ?? "").trim();
  // 和失效反馈同一个理由：id 只校验不清洗，截断超长 id 会撞上另一条真实条目
  if (!ID_RE.test(itemId)) return { status: 400, body: { error: "缺少有效的资源 id" } };

  const fields = body.fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    return { status: 400, body: { error: "fields 必须是对象" } };
  }

  const unknown = Object.keys(fields).filter((k) => !OVERRIDE_FIELDS.includes(k));
  if (unknown.length) {
    // 明确报错而不是静默忽略 —— 静默会让人以为改了 id/section 却没生效
    return { status: 400, body: { error: `不可编辑的字段：${unknown.join(", ")}` } };
  }

  // 读现有覆盖，做增量更新
  const cur = await env.DB
    .prepare(`SELECT ${OVERRIDE_FIELDS.join(", ")} FROM overrides WHERE item_id = ?`)
    .bind(itemId).first();

  const next = {};
  for (const f of OVERRIDE_FIELDS) {
    if (!(f in fields)) {
      next[f] = cur ? cur[f] : null;   // 没提到就保持现状
      continue;
    }
    const v = fields[f];
    if (v === null) {
      next[f] = null;                  // 显式撤销这一项
      continue;
    }
    // deleted 在 D1 中是 INTEGER；其他覆盖字段都是 TEXT。
    if (f === "deleted") {
      if (v !== true && v !== false && v !== 1 && v !== 0) {
        return { status: 400, body: { error: "deleted 必须是布尔值或 null" } };
      }
      next[f] = v === true || v === 1 ? 1 : 0;
      continue;
    }
    if (typeof v !== "string") {
      return { status: 400, body: { error: `${f} 必须是字符串或 null` } };
    }
    const clean = sanitizeText(v, OVERRIDE_MAX[f]);
    // url 额外校验：只收 http(s)，否则可能被塞 javascript: 这类伪协议
    if (f === "url" && clean && !/^https?:\/\//i.test(clean)) {
      return { status: 400, body: { error: "链接必须以 http:// 或 https:// 开头" } };
    }
    // 分区必须在白名单里。放行未知值的话前端 normalize() 会把它当无效丢弃，
    // 表现为「保存成功但分区没变」，比直接报错更难查。
    if (f === "section" && clean && !(clean in SECTION_SUBS)) {
      return { status: 400, body: { error: `未知分区：${clean}` } };
    }
    // placements 是多分区归属，格式与白名单都在 parsePlacements 里校验
    if (f === "placements" && clean) {
      const p = parsePlacements(clean);
      if (!p.ok) return { status: 400, body: { error: p.error } };
      next[f] = p.value;
      continue;
    }
    next[f] = clean;
  }

  // 小分区必须属于最终生效的那个分区。只改了 section 没改 subsection 时，
  // 老的小分区往新分区里往往不存在（漫画的 wechat 放到小说下就是无效值），
  // 这时清掉它，让条目落在新分区的「全部」里，而不是变成一个查不到的组合。
  const finalSection = next.section || (cur && cur.section) || "";
  if (finalSection) {
    const allowed = SECTION_SUBS[finalSection] || [];
    if (next.subsection && !allowed.includes(next.subsection)) {
      if ("subsection" in fields) {
        // 用户明确指定了一个不合法的小分区，报错而不是悄悄改掉他的输入
        return {
          status: 400,
          body: { error: `「${finalSection}」下没有小分区「${next.subsection}」` },
        };
      }
      next.subsection = "";
    }
  }

  // placements 一旦给了值，就把单值的 section/subsection 清掉 ——
  // 两套并存时前端得猜听谁的，留一套语义才清楚。
  if (next.placements) {
    next.section = null;
    next.subsection = null;
  }

  // 全部字段都撤销了就删掉整行，别留一行空覆盖
  if (OVERRIDE_FIELDS.every((f) => next[f] === null)) {
    await env.DB.prepare("DELETE FROM overrides WHERE item_id = ?").bind(itemId).run();
    return { status: 200, body: { ok: true, cleared: true } };
  }

  const cols = OVERRIDE_FIELDS.join(", ");
  const marks = OVERRIDE_FIELDS.map(() => "?").join(", ");
  const sets = OVERRIDE_FIELDS.map((f) => `${f} = excluded.${f}`).join(", ");
  await env.DB.prepare(
    `INSERT INTO overrides (item_id, ${cols}, updated, by_who)
     VALUES (?, ${marks}, ?, 'admin')
     ON CONFLICT (item_id) DO UPDATE SET ${sets}, updated = excluded.updated`
  ).bind(itemId, ...OVERRIDE_FIELDS.map((f) => next[f]), new Date().toISOString()).run();

  return { status: 200, body: { ok: true, item_id: itemId } };
}

/* ---------- 管理员新增条目 ---------- */

/** 新增条目的字段上限。与覆盖层共用 name/description 等，另加 tags/kind。 */
const CUSTOM_MAX = { ...OVERRIDE_MAX, tags: 200, kind: 40 };

/** 读全部后台新增的条目，转成和 items.json 同构的形状供前端直接用。 */
async function listCustomItems(env) {
  const { results } = await env.DB
    .prepare(
      `SELECT id, name, description, url, password, note, section, subsection,
              placements, tags, kind, adult, created, updated
       FROM custom_items ORDER BY created DESC`
    )
    .all();
  const items = (results || []).map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    url: r.url,
    password: r.password,
    note: r.note,
    section: r.section,
    subsection: r.subsection || undefined,
    // 多分区归属。老行没有这一列，用 section/subsection 兜底拼一个出来，
    // 前端就只需要认 placements 一种形式。
    placements: r.placements || (r.subsection ? `${r.section}:${r.subsection}` : r.section),
    // D1 没有数组类型，tags 存的是逗号分隔串，这里拆回数组
    tags: r.tags ? r.tags.split(",").filter(Boolean) : [],
    kind: r.kind || undefined,
    adult: r.adult === 1,
    update_info: "后台添加",
    created: r.created,
  }));
  return { items, count: items.length };
}

/**
 * 新增一条资源。body 就是各字段，id 由后端生成。
 *
 * 不让前端指定 id：撞上 items.json 里已有的 id 会把那条顶掉，
 * 而且 id 是点击数与失效反馈的键，被覆盖等于两条资源的数据混在一起。
 */
async function createCustomItem(env, body) {
  const name = sanitizeText(body.name, CUSTOM_MAX.name);
  if (!name) return { status: 400, body: { error: "资源名不能为空" } };

  // 分区归属：新前端传 placements（可多选），老形式是 section+subsection。
  // 两种都收，统一成 placements 存库。
  let placements = "";
  if (body.placements !== undefined && body.placements !== null && body.placements !== "") {
    const p = parsePlacements(sanitizeText(body.placements, CUSTOM_MAX.placements));
    if (!p.ok) return { status: 400, body: { error: p.error } };
    placements = p.value;
  } else {
    const section = sanitizeText(body.section, CUSTOM_MAX.section);
    if (!section || !(section in SECTION_SUBS)) {
      return { status: 400, body: { error: "请选择有效的分区" } };
    }
    const subsection = sanitizeText(body.subsection, CUSTOM_MAX.subsection);
    if (subsection && !(SECTION_SUBS[section] || []).includes(subsection)) {
      return { status: 400, body: { error: `「${section}」下没有小分区「${subsection}」` } };
    }
    placements = subsection ? `${section}:${subsection}` : section;
  }

  // 第一个归属当主分区存进 section/subsection 两列，方便直接按分区查库；
  // 完整归属存 placements。前端优先读 placements。
  const [firstSec, firstSub = ""] = placements.split(",")[0].split(":");

  const url = sanitizeText(body.url, CUSTOM_MAX.url);
  if (url && !/^https?:\/\//i.test(url)) {
    return { status: 400, body: { error: "链接必须以 http:// 或 https:// 开头" } };
  }

  const total = await env.DB.prepare("SELECT COUNT(*) c FROM custom_items").first();
  if (total && total.c >= CUSTOM_MAX_ITEMS) {
    return {
      status: 503,
      body: { error: `后台新增已达 ${CUSTOM_MAX_ITEMS} 条上限，先把数据折回 items.json` },
    };
  }

  // 标签按逗号/空格拆开，各自清洗，最多留 6 个（前端也只显示 6 个）
  const tags = sanitizeText(body.tags, CUSTOM_MAX.tags)
    .split(/[,，\s]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 6)
    .join(",");

  // id 里带时间戳便于排序，带随机后缀避免同一毫秒内撞车
  const id = CUSTOM_PREFIX + Date.now().toString(36) + "-" + randomHex(4);
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO custom_items
       (id, name, description, url, password, note, section, subsection,
        placements, tags, kind, adult, created, updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, name,
    sanitizeText(body.description, CUSTOM_MAX.description),
    url,
    sanitizeText(body.password, CUSTOM_MAX.password),
    sanitizeText(body.note, CUSTOM_MAX.note),
    firstSec, firstSub, placements, tags,
    sanitizeText(body.kind, CUSTOM_MAX.kind),
    body.adult === true ? 1 : 0,
    now, now
  ).run();

  return { status: 200, body: { ok: true, id } };
}

/** 删除后台新增的条目。只能删 custom- 前缀的 —— items.json 里的条目
 *  不属于这张表，删不掉也不该从这里删（那得改仓库文件）。 */
async function deleteCustomItem(env, rawId) {
  const id = String(rawId ?? "").trim();
  if (!ID_RE.test(id) || !id.startsWith(CUSTOM_PREFIX)) {
    return { status: 400, body: { error: "只能删除后台新增的条目" } };
  }
  const res = await env.DB.prepare("DELETE FROM custom_items WHERE id = ?").bind(id).run();
  if (!res.meta || res.meta.changes !== 1) {
    return { status: 404, body: { error: "条目不存在" } };
  }
  // 顺手清掉它的覆盖，否则删了条目却留下一行孤儿覆盖
  await env.DB.prepare("DELETE FROM overrides WHERE item_id = ?").bind(id).run();
  return { status: 200, body: { ok: true, id } };
}

async function cleanup(env) {
  const cutoff = new Date(Date.now() - 400 * 86400000);
  const day = `${cutoff.getUTCFullYear()}-${pad2(cutoff.getUTCMonth() + 1)}-${pad2(cutoff.getUTCDate())}`;
  await env.DB.prepare("DELETE FROM seen WHERE day < ?").bind(day).run();
  // 投票去重键同样会累积。注意只清去重键，requests 里的票数不动 ——
  // 票数是历史累计值，清了会让老求助凭空掉票。
  await env.DB.prepare("DELETE FROM request_votes WHERE day < ?").bind(day).run();
  // 过期会话与登录失败计数也顺手清掉，两张表都只有短期意义
  await env.DB.prepare("DELETE FROM admin_sessions WHERE expires < ?")
    .bind(new Date().toISOString()).run();
  await env.DB.prepare("DELETE FROM admin_throttle WHERE window < ?")
    .bind(String(Math.floor(Date.now() / 60000) - 60)).run();
  await env.DB.prepare("DELETE FROM board_admin_sessions WHERE expires < ?")
    .bind(new Date().toISOString()).run();
  await env.DB.prepare("DELETE FROM board_admin_throttle WHERE window < ?")
    .bind(String(Math.floor(Date.now() / 60000) - 60)).run();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors.headers });
    }
    if (!env.DB) {
      return json({ error: "D1 未绑定，请检查 wrangler.toml 的 [[d1_databases]]" }, request, 500);
    }

      // 预热缓存写入接口（内部接口，跳过 CORS origin 白名单）。
      if (url.pathname === "/api/admin/novel-cache" && request.method === "POST") {
        const ip = request.headers.get("CF-Connecting-IP") || "";
        if (await rateLimited(env, ip)) return json({ error: "too many requests" }, request, 429);
        if (!env.NOVEL_CACHE) return json({ error: "NOVEL_CACHE KV 未绑定" }, request, 500);
        const body = await request.json().catch(() => ({}));
        const key = typeof body.key === "string" ? body.key.trim() : "";
        const blocks = Array.isArray(body.blocks) ? body.blocks : null;
        if (!key || !blocks || !blocks.length) {
          return json({ error: "需要 key 和非空 blocks 数组" }, request, 400);
        }
        const payload = JSON.stringify({
          key,
          blocks,
          pages: body.pages || 1,
          ts: Date.now(),
        });
        await env.NOVEL_CACHE.put(key, payload, { expirationTtl: 86400 });
        return json({ ok: true, key, count: blocks.length, pages: body.pages || 1 }, request);
      }

      // 预热缓存删除接口（内部接口，跳过 CORS origin 白名单）——用于清除被污染的缓存。
      if (url.pathname === "/api/admin/novel-cache" && request.method === "DELETE") {
        const ip = request.headers.get("CF-Connecting-IP") || "";
        if (await rateLimited(env, ip)) return json({ error: "too many requests" }, request, 429);
        if (!env.NOVEL_CACHE) return json({ error: "NOVEL_CACHE KV 未绑定" }, request, 500);
        const body = await request.json().catch(() => ({}));
        const key = typeof body.key === "string" ? body.key.trim() : "";
        if (!key) return json({ error: "需要 key" }, request, 400);
        await env.NOVEL_CACHE.delete(key);
        return json({ ok: true, key, deleted: true }, request);
      }

    // 写接口必须来自白名单站点；读接口放开，方便你直接在浏览器里查
    if (request.method === "POST" && !cors.allowed) {
      return json({ error: "origin not allowed" }, request, 403);
    }

    try {
      if (url.pathname.startsWith("/api/board/")) {
        const boardResponse = await handleBoardAdmin(request, env);
        if (boardResponse) return boardResponse;
      }

      if (url.pathname === "/api/watch/music" && request.method === "GET") {
        const ip = request.headers.get("CF-Connecting-IP") || "";
        if (await rateLimited(env, ip)) return json({ error: "too many requests" }, request, 429);
        return await watchMusic(request, url);
      }

      if (url.pathname === "/api/watch/audio" && request.method === "GET") {
        const ip = request.headers.get("CF-Connecting-IP") || "";
        if (await rateLimited(env, ip)) return json({ error: "too many requests" }, request, 429);
        return await watchAudio(request, url);
      }

      if (url.pathname === "/api/watch/novel" && request.method === "GET") {
        const ip = request.headers.get("CF-Connecting-IP") || "";
        if (await rateLimited(env, ip)) return json({ error: "too many requests" }, request, 429);
        return await watchNovel(request, url, env);
      }

      if (url.pathname === "/api/watch/manga" && request.method === "GET") {
        const ip = request.headers.get("CF-Connecting-IP") || "";
        if (await rateLimited(env, ip)) return json({ error: "too many requests" }, request, 429);
        return await watchManga(request, url);
      }

      if (url.pathname === "/api/watch/anime" && request.method === "GET") {
        const ip = request.headers.get("CF-Connecting-IP") || "";
        if (await rateLimited(env, ip)) return json({ error: "too many requests" }, request, 429);
        return await watchAnime(request, url);
      }

      if (url.pathname === "/api/watch/asset" && request.method === "GET") {
        return await watchAsset(request, url);
      }

      // 动画播放器页 / 播放器内部接口的代理（解决 iframe Referer 被拒）
      if (url.pathname === "/api/watch/frame" && request.method === "GET") {
        return await watchPlayerFrame(request, url);
      }
      if ((url.pathname === "/api/watch/vxdev.php" || url.pathname === "/api/watch/vxcd.php")
          && request.method === "POST") {
        return await watchPlayerApi(request, url);
      }

      if (url.pathname === "/api/stats" && request.method === "GET") {
        return json(await readStats(env), request);
      }

      if (url.pathname === "/api/hit" && request.method === "POST") {
        const ip = request.headers.get("CF-Connecting-IP") || "";
        if (await rateLimited(env, ip)) return json({ error: "too many requests" }, request, 429);

        const body = await request.json().catch(() => ({}));
        const id = typeof body.id === "string" ? body.id : "";
        if (!ID_RE.test(id)) return json({ error: "bad id" }, request, 400);

        await recordHit(env, id);
        return json({ ok: true }, request);
      }

      if (url.pathname === "/api/visit" && request.method === "POST") {
        const ip = request.headers.get("CF-Connecting-IP") || "";
        if (await rateLimited(env, ip)) return json({ error: "too many requests" }, request, 429);

        await recordVisit(env, request);
        return json({ ok: true }, request);
      }

      /* ---------- 资源帮找 / 失效反馈 ---------- */

      if (url.pathname === "/api/requests" && request.method === "GET") {
        return json(await listRequests(env, url), request);
      }

      if (url.pathname === "/api/requests" && request.method === "POST") {
        const ip = request.headers.get("CF-Connecting-IP") || "";
        if (await rateLimited(env, ip)) return json({ error: "too many requests" }, request, 429);

        const body = await request.json().catch(() => null);
        if (!body || typeof body !== "object") {
          return json({ error: "bad request body" }, request, 400);
        }
        const r = await createRequest(env, request, body);
        return json(r.body, request, r.status);
      }

      if (url.pathname === "/api/requests/vote" && request.method === "POST") {
        const ip = request.headers.get("CF-Connecting-IP") || "";
        if (await rateLimited(env, ip)) return json({ error: "too many requests" }, request, 429);

        const body = await request.json().catch(() => ({}));
        const r = await voteRequest(env, request, body.id);
        return json(r.body, request, r.status);
      }

      /* ---------- 管理员编辑 ---------- */

      // 覆盖层是公开读的：每个访客都要用它盖住 items.json 的原值。
      // 里面只有站长自己写的展示文本，没有隐私。
      if (url.pathname === "/api/overrides" && request.method === "GET") {
        return json(await listOverrides(env), request);
      }

      if (url.pathname === "/api/admin/login" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const r = await adminLogin(env, request, body || {});
        return json(r.body, request, r.status);
      }

      // 以下都要带有效 token
      if (url.pathname === "/api/admin/logout" && request.method === "POST") {
        const token = await adminAuth(env, request);
        if (!token) return json({ error: "未登录或登录已过期" }, request, 401);
        const r = await adminLogout(env, token);
        return json(r.body, request, r.status);
      }

      if (url.pathname === "/api/admin/session" && request.method === "GET") {
        const token = await adminAuth(env, request);
        return json({ ok: !!token }, request, token ? 200 : 401);
      }

      if (url.pathname === "/api/admin/override" && request.method === "POST") {
        const token = await adminAuth(env, request);
        if (!token) return json({ error: "未登录或登录已过期" }, request, 401);
        const body = await request.json().catch(() => null);
        if (!body || typeof body !== "object") {
          return json({ error: "bad request body" }, request, 400);
        }
        const r = await saveOverride(env, body);
        return json(r.body, request, r.status);
      }

      // 后台新增的条目。和覆盖层一样公开读 —— 访客要看到这些资源。
      if (url.pathname === "/api/items" && request.method === "GET") {
        return json(await listCustomItems(env), request);
      }

      if (url.pathname === "/api/admin/item" && request.method === "POST") {
        const token = await adminAuth(env, request);
        if (!token) return json({ error: "未登录或登录已过期" }, request, 401);
        const body = await request.json().catch(() => null);
        if (!body || typeof body !== "object") {
          return json({ error: "bad request body" }, request, 400);
        }
        const r = await createCustomItem(env, body);
        return json(r.body, request, r.status);
      }

      if (url.pathname === "/api/admin/item/delete" && request.method === "POST") {
        const token = await adminAuth(env, request);
        if (!token) return json({ error: "未登录或登录已过期" }, request, 401);
        const body = await request.json().catch(() => ({}));
        const r = await deleteCustomItem(env, body.id);
        return json(r.body, request, r.status);
      }

      /* ---------- 反馈运维 ---------- */

      if (url.pathname === "/api/admin/request" && request.method === "POST") {
        const token = await adminAuth(env, request);
        if (!token) return json({ error: "未登录或登录已过期" }, request, 401);
        const body = await request.json().catch(() => null);
        if (!body || typeof body !== "object") {
          return json({ error: "bad request body" }, request, 400);
        }
        const r = await updateRequest(env, body);
        return json(r.body, request, r.status);
      }

      if (url.pathname === "/api/admin/request/delete" && request.method === "POST") {
        const token = await adminAuth(env, request);
        if (!token) return json({ error: "未登录或登录已过期" }, request, 401);
        const body = await request.json().catch(() => ({}));
        const r = await deleteRequest(env, body.id);
        return json(r.body, request, r.status);
      }

      if (url.pathname === "/api/admin/requests/purge" && request.method === "POST") {
        const token = await adminAuth(env, request);
        if (!token) return json({ error: "未登录或登录已过期" }, request, 401);
        const body = await request.json().catch(() => ({}));
        const r = await purgeRequests(env, body || {});
        return json(r.body, request, r.status);
      }

      return json({ error: "not found" }, request, 404);
    } catch (err) {
      // 不把内部堆栈回给前端
      console.error(err);
      return json({ error: "internal error" }, request, 500);
    }
  },

  /** cron 触发的清理，见 wrangler.toml 的 [triggers]。 */
  async scheduled(event, env) {
    if (env.DB) await cleanup(env);
  },
};

// 供本地测试导入（Worker 运行时不受影响）
export const _internal = {
  isoWeek,
  buckets,
  PERIODS,
  ID_RE,
  sanitizeText,
  normalizeTitle,
  REQ_TITLE_MAX,
  REQ_NOTE_MAX,
  REQ_PER_DAY,
  REQ_OPEN_MAX,
  REQ_KINDS,
  REQ_STATUSES,
  OVERRIDE_FIELDS,
  OVERRIDE_MAX,
  SECTION_SUBS,
  PLACEMENT_MAX,
  parsePlacements,
  CUSTOM_PREFIX,
  CUSTOM_MAX_ITEMS,
  SESSION_HOURS,
  LOGIN_TRIES,
  PBKDF2_ITER,
  pbkdf2Hex,
  timingSafeEqual,
  randomHex,
  watchText,
  mangaGroups,
  mangaImageUrl,
  parseNovelCards,
  parseNovelSearchCards,
  fetchNovelSearch,
  searchNovelLocal,
  buildNovelLocalIndex,
  novelS2T,
  novelT2S,
  parseNovelChapter,
  parseNovelChapterPage,
  extractNovelReadParams,
  fetchNovelChapterAll,
  isNovelDecorationImage,
  novelImageHostAllowed,
  collectMangaComics,
  parseAnimeCards,
  parseAnimeEpisodes,
  parseAnimePlayer,
  animeEmbedUrl,
};
