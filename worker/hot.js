/**
 * 求资源热榜聚合（第一站 /qiu 页面用）。
 *
 * 四个平台：B站、抖音、快手、小红书。
 * 每个平台一条「上游链」，按顺序试，第一个成功的就用；全失败就回退到
 * D1 里上一次成功的快照（stale-while-error），页面侧只会看到「数据偏旧」。
 *
 *   GET /api/hot                四个平台一起返回（页面默认走这个）
 *   GET /api/hot?src=xhs        只返回一个平台
 *   GET /api/hot?refresh=1      请求强制刷新（60s 内只允许一次，否则直接给缓存）
 *   GET /api/hot?debug=1        带上每次上游尝试的状态，排查用
 *
 * 为什么要在 Worker 里聚合、不让页面直连：
 *   - 官方接口基本都没有 CORS 头，浏览器直连会被拦；
 *   - uapis 这类聚合站有「每月 1500 次访客额度」，访问量一大就被打爆，
 *     必须在服务端做 10 分钟缓存把调用量压到几十次/天；
 *   - 上游改结构时只要改这一处，页面不用动。
 */

/** 每个平台允许最多返回多少条。 */
const HOT_LIMIT = 50;

/** 快照缓存时长：上游本身也就几分钟更新一次，10 分钟足够「准实时」。 */
const HOT_TTL_MS = 10 * 60 * 1000;

/** 手动刷新最短间隔，防止有人狂点刷新把上游额度打光。 */
const HOT_MIN_REFRESH_MS = 60 * 1000;

/** 单次上游请求超时。 */
const HOT_TIMEOUT_MS = 12000;

const HOT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** 页面里展示的四个平台。key 是站内短名，type 是 uapis 的榜单名。 */
const HOT_SRC = {
  bili: {
    label: "B站",
    type: "bilibili",
    home: "https://search.bilibili.com/all?keyword=",
  },
  douyin: {
    label: "抖音",
    type: "douyin",
    home: "https://www.douyin.com/search/",
  },
  ks: {
    label: "快手",
    type: "kuaishou",
    home: "https://www.kuaishou.com/search/video?searchKey=",
  },
  xhs: {
    label: "小红书",
    type: "xiaohongshu",
    home: "https://www.xiaohongshu.com/search_result?keyword=",
  },
};

/* ---------------- 小工具 ---------------- */

function hotCleanText(value, max = 200) {
  return String(value == null ? "" : value)
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** 只放行 http(s) 链接；站内渲染时还会再过一次白名单。 */
function hotSafeUrl(value) {
  const raw = String(value || "").trim().replace(/^\/\//, "https://");
  if (!/^https?:\/\//i.test(raw)) return "";
  return raw.slice(0, 500);
}

function hotKeywordUrl(src, keyword) {
  return `${HOT_SRC[src].home}${encodeURIComponent(keyword)}`;
}

/** 上游返回里的热度值，可能是数字也可能是「1321.4万」这种带单位的字符串。 */
function hotHeat(value) {
  if (value == null) return "";
  const s = hotCleanText(value, 24);
  return s;
}

function hotNormalize(list, src) {
  const out = [];
  for (const raw of list || []) {
    const title = hotCleanText(raw && raw.title, 120);
    if (!title) continue;
    const url = hotSafeUrl(raw.url) || hotKeywordUrl(src, title);
    out.push({
      rank: out.length + 1,
      title,
      hot: hotHeat(raw.hot),
      url,
      cover: hotSafeUrl(raw.cover),
    });
    if (out.length >= HOT_LIMIT) break;
  }
  return out;
}

async function hotFetchJson(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HOT_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": HOT_UA,
        Accept: "application/json,text/plain,*/*",
        ...headers,
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function hotFetchText(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HOT_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": HOT_UA,
        Accept: "text/html,application/xhtml+xml,*/*",
        ...headers,
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- 上游 1：uapis 全网热榜聚合 ---------------- */
/* 返回已经归一化好的 list，四个平台共用一个形状：
   {type, update_time, list:[{index,title,url,cover,hot_value,extra}]}
   实测这是唯一一个「四个平台都有、还不用签名」的稳定源，所以放第一位。
   它的访客额度是按月算的，靠上面 10 分钟缓存压调用量。 */

async function hotFromUapis(src) {
  const type = HOT_SRC[src].type;
  const data = await hotFetchJson(
    `https://uapis.cn/api/v1/misc/hotboard?type=${encodeURIComponent(type)}`,
    { Origin: "https://uapis.cn" }
  );
  if (data && data.error) throw new Error(String(data.error).slice(0, 60));
  const list = Array.isArray(data && data.list) ? data.list : [];
  if (!list.length) throw new Error("empty list");
  const mapped = list.map((item) => {
    const extra = item && item.extra && typeof item.extra === "object" ? item.extra : {};
    return {
      title: item && item.title,
      url: item && item.url,
      hot: item && item.hot_value,
      cover: (item && item.cover) || extra.cover || "",
    };
  });
  return {
    items: hotNormalize(mapped, src),
    updated: hotCleanText(data.update_time, 40),
    provider: "uapis.cn",
  };
}

/* ---------------- 上游 2：各平台官方接口（无签名的那几个） ---------------- */

/* ---------------- 上游 2.5：60s API（Cloudflare 托管，Worker 一定够得着） ----------------
   60s（https://60s.viki.moe，开源项目 vikiboss/60s）自己就在 Cloudflare 上，
   从 Worker 打不会被拦，这是「小红书热搜词」目前唯一稳定的一路 ——
   uapis 对 Cloudflare 出口 IP 返 502，小红书官方接口又要 x-s 签名。
     /v2/rednote → 小红书热搜 [{rank,title,score,word_type,work_type_icon,link}]
     /v2/douyin  → 抖音热搜   [{title,hot_value,cover,link,...}]
   /v2/bili 上游解析挂了（返 code 500），所以 B站不走它。 */

const SIXTY_PATHS = { douyin: "douyin", xhs: "rednote" };

async function hotFrom60s(src) {
  const path = SIXTY_PATHS[src];
  if (!path) throw new Error("no 60s endpoint");
  const data = await hotFetchJson(`https://60s.viki.moe/v2/${path}`);
  if (!data || Number(data.code) !== 200) {
    throw new Error(`code ${data && data.code}`);
  }
  const list = Array.isArray(data.data) ? data.data : [];
  if (!list.length) throw new Error("empty list");
  return {
    items: hotNormalize(
      list.map((item) => ({
        title: item && item.title,
        url: item && item.link,
        hot: item && (item.hot_value == null ? item.score : item.hot_value),
        cover: (item && item.cover) || (item && item.work_type_icon) || "",
      })),
      src
    ),
    updated: hotCleanText(list[0] && list[0].active_time, 40),
    provider: "60s.viki.moe",
  };
}

/** B站热搜词：s.search.bilibili.com 的 hotword。
 * 和 api.bilibili.com 是两台不同的机器 —— 实测 api 那边对 Cloudflare 的出口 IP
 * 返 412（风控），这台不会，所以在 Worker 里它能用，放最前面。
 */
async function hotFromBilibiliHotword() {
  const data = await hotFetchJson(
    "https://s.search.bilibili.com/main/hotword?limit=50",
    { Referer: "https://www.bilibili.com/" }
  );
  const list = (data && data.list) || [];
  if (!list.length) throw new Error("empty list");
  return {
    items: hotNormalize(
      list.map((item) => ({
        title: (item && (item.show_name || item.keyword)) || "",
        url: hotKeywordUrl("bili", (item && item.keyword) || ""),
        hot: item && item.heat_score,
        cover: item && item.icon,
      })),
      "bili"
    ),
    updated: "",
    provider: "bilibili.hotword",
  };
}

/** B站热搜：优先 web 搜索广场（带 heat_score），退回 app 端 trending/ranking
 *  （那份没有热度值，只拿来补条数）。两个都是「用户正在搜什么」的热搜词。 */
async function hotFromBilibili() {
  try {
    const data = await hotFetchJson(
      "https://api.bilibili.com/x/web-interface/search/square?limit=50",
      { Referer: "https://www.bilibili.com/" }
    );
    const list =
      (data && data.data && data.data.trending && data.data.trending.list) || [];
    if (!list.length) throw new Error("empty list");
    return {
      items: hotNormalize(
        list.map((item) => ({
          title: (item && (item.show_name || item.keyword)) || "",
          url: hotKeywordUrl("bili", (item && item.keyword) || ""),
          hot: item && item.heat_score,
          cover: item && item.icon,
        })),
        "bili"
      ),
      updated: "",
      provider: "bilibili.search.square",
    };
  } catch (err) {
    const data = await hotFetchJson(
      "https://app.bilibili.com/x/v2/search/trending/ranking?limit=50",
      { Referer: "https://www.bilibili.com/" }
    );
    const list = (data && data.data && data.data.list) || [];
    if (!list.length) throw new Error("empty list");
    return {
      items: hotNormalize(
        list.map((item) => ({
          title: (item && (item.show_name || item.keyword)) || "",
          url: hotKeywordUrl("bili", (item && item.keyword) || ""),
          hot: item && item.heat_score,
          cover: item && item.icon,
        })),
        "bili"
      ),
      updated: "",
      provider: "bilibili.app.trending",
    };
  }
}

/** 抖音热搜：iesdouyin 的 word 榜，不需要签名和 cookie。 */
async function hotFromDouyin() {
  const data = await hotFetchJson(
    "https://www.iesdouyin.com/web/api/v2/hotsearch/billboard/word/",
    { Referer: "https://www.douyin.com/" }
  );
  const list = (data && data.word_list) || [];
  if (!list.length) throw new Error("empty list");
  return {
    items: hotNormalize(
      list.map((item) => ({
        title: item && item.word,
        url: hotKeywordUrl("douyin", (item && item.word) || ""),
        hot: item && item.hot_value,
        cover: "",
      })),
      "douyin"
    ),
    updated: hotCleanText(data && data.active_time, 40),
    provider: "iesdouyin.billboard",
  };
}

/** 快手热榜：首页 SSR 里带 window.__APOLLO_STATE__，解析里面的 visionHotRank。 */
async function hotFromKuaishou() {
  const html = await hotFetchText("https://www.kuaishou.com/?isHome=1", {
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
  });
  const prefix = "window.__APOLLO_STATE__=";
  const start = html.indexOf(prefix);
  if (start === -1) throw new Error("no APOLLO_STATE");
  const scriptSlice = html.slice(start + prefix.length);
  // 这份 JSON 后面直接跟着一段自删脚本 `;(function(){...})()`，只截到
  // `</script>` 会把那段也吃进来，JSON.parse 报「末尾有多余字符」。
  // 两个哨兵谁在前用谁，都找不到才算页面结构变了。
  const sentinelA = scriptSlice.indexOf(";(function(");
  const sentinelB = scriptSlice.indexOf("</script>");
  const cutIndex =
    sentinelA !== -1 && sentinelB !== -1
      ? Math.min(sentinelA, sentinelB)
      : Math.max(sentinelA, sentinelB);
  if (cutIndex === -1) throw new Error("no APOLLO_STATE end marker");
  let slice = scriptSlice.slice(0, cutIndex).trim().replace(/;$/, "");
  // 快手这份 JSON 末尾还常跟 undefined/null 之类的脏尾巴，截到最后一个 } 为止
  const lastBrace = slice.lastIndexOf("}");
  if (lastBrace !== -1) slice = slice.slice(0, lastBrace + 1);
  const state = (JSON.parse(slice) || {}).defaultClient || {};
  const rankKey = Object.keys(state).find((key) =>
    key.startsWith("$ROOT_QUERY.visionHotRank")
  );
  const refs = (rankKey && state[rankKey] && state[rankKey].items) || [];
  const list = [];
  for (const ref of refs) {
    const node = ref && state[ref.id];
    if (!node || !node.name) continue;
    list.push({
      title: node.name,
      url: hotKeywordUrl("ks", node.name),
      hot: node.hotValue,
      cover: node.poster ? decodeURIComponent(node.poster) : "",
    });
  }
  if (!list.length) throw new Error("empty list");
  return { items: hotNormalize(list, "ks"), updated: "", provider: "kuaishou.apollo" };
}

/* ---------------- 上游 3：rebang.today 兜底（SSR 列表） ---------------- */
/* 小红书官方热搜要 x-s 签名，Worker 里没法可靠地算，所以主源交给 uapis；
   rebang.today 是「今日热榜」类站点，服务端已经把 B站 / 抖音 / 小红书 的
   榜单渲染进 HTML 了，直接正则扒就能拿到。代价：
     - 每条只有排名 + 标题 + 原链接，没有热度值；
     - 小红书那份是「热门笔记」不是「热搜词」，标题还可能被截成「小狗如奶油般融化…」。
   所以它排在各平台官方源和 uapis 之后，只在这一路也挂了的时候顶上。
   （rebang 没有快手 tab，快手兜底只有 uapis。） */

const REBANG_TABS = { bili: "bilibili", douyin: "douyin", xhs: "xiaohongshu" };

async function hotFromRebang(src) {
  const tab = REBANG_TABS[src];
  if (!tab) throw new Error("no rebang tab");
  const html = await hotFetchText(`https://rebang.today/?tab=${tab}`, {
    "Accept-Language": "zh-CN,zh;q=0.9",
  });
  const blocks = html.split('data-latest-list-item-key="').slice(1);
  const list = [];
  for (const block of blocks) {
    const urlMatch = block.match(/data-item-primary-link="true"[^>]*href="([^"]+)"/);
    if (!urlMatch) continue;
    const titleMatch = block.match(
      /data-item-title-link="true"[^>]*href="[^"]*"[^>]*>([^<]{2,120})<\/a>/
    );
    if (!titleMatch) continue;
    const rankMatch = block.match(/data-testid="item-layout-1002-rank">(\d+)</);
    list.push({
      rank: rankMatch ? Number(rankMatch[1]) : list.length + 1,
      title: titleMatch[1],
      hot: "",
      url: urlMatch[1].replace(/&amp;/g, "&"),
      cover: "",
    });
    if (list.length >= HOT_LIMIT) break;
  }
  if (!list.length) throw new Error("empty list");
  return {
    items: hotNormalize(list, src),
    updated: "",
    provider: `rebang.today/${tab}`,
  };
}

/** 每个平台的上游链：按顺序试，前一个抛错就试下一个。
 *  顺序原则「官方无签名接口 > Cloudflare 够得着的聚合 > 兜底聚合」。
 *  Cloudflare 出口 IP 的实测结论（2026-10 实测，会变，所以链上留全）：
 *   - B站 s.search / api.bilibili.com 都返 412（风控）→ 实际落到 rebang；
 *   - 抖音 iesdouyin 通，60s 也通；
 *   - 快手首页 Apollo 通（偶尔超时，重试即可）；
 *   - 小红书官方要 x-s 签名，uapis 对 CF 出口返 502 → 靠 60s /v2/rednote；
 *   - uapis 从本机出口是好的，所以仍然留在链上（换出口/换平台都能用）。
 *  链尾的 rebang.today 只有排名/标题/链接，没有热度值，标题可能被截断，
 *  而且没有快手 tab。 */
const HOT_CHAIN = {
  bili: [hotFromBilibiliHotword, hotFromBilibili, hotFromUapis, hotFromRebang],
  douyin: [hotFromDouyin, hotFrom60s, hotFromUapis, hotFromRebang],
  ks: [hotFromKuaishou, hotFromUapis],
  xhs: [hotFrom60s, hotFromUapis, hotFromRebang],
};

/* ---------------- D1 快照缓存 ---------------- */

async function hotReadCache(env, src) {
  try {
    const row = await env.DB.prepare(
      "SELECT payload, provider, fetched_at FROM hot_rank WHERE src = ?"
    )
      .bind(src)
      .first();
    if (!row) return null;
    return {
      items: JSON.parse(row.payload),
      provider: row.provider || "",
      fetched_at: Number(row.fetched_at) || 0,
    };
  } catch (err) {
    // 表还没建 / JSON 坏了都不该让接口 500，直接当没缓存
    return null;
  }
}

async function hotWriteCache(env, src, snapshot) {
  try {
    await env.DB.prepare(
      "INSERT INTO hot_rank (src, payload, provider, fetched_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(src) DO UPDATE SET payload = excluded.payload, " +
        "provider = excluded.provider, fetched_at = excluded.fetched_at"
    )
      .bind(src, JSON.stringify(snapshot.items), snapshot.provider, Date.now())
      .run();
  } catch (err) {
    /* 缓存写失败不影响本次返回 */
  }
}

/* ---------------- 主入口 ---------------- */

/**
 * @returns {Promise<{status:number, body:object}|null>} 只处理 /api/hot；
 *   返回 null 表示不归这个模块管（目前不会发生，路由是精确匹配的）。
 */
export async function handleHot(request, url, env) {
  const want = (url.searchParams.get("src") || "all").toLowerCase();
  const debug = url.searchParams.get("debug") === "1";
  const force = url.searchParams.get("refresh") === "1";
  const srcs = want === "all" ? Object.keys(HOT_SRC) : [want];
  const bad = srcs.filter((src) => !HOT_SRC[src]);
  if (bad.length) {
    return {
      status: 400,
      body: { error: "unknown src", allowed: Object.keys(HOT_SRC) },
    };
  }

  const now = Date.now();
  const result = {};
  const attempts = {};

  await Promise.all(
    srcs.map(async (src) => {
      const chain = HOT_CHAIN[src] || [];
      const tries = [];
      let snapshot = null;
      const cached = await hotReadCache(env, src);

      // 没带 refresh：10 分钟内的缓存直接用。
      // 带了 refresh：绕过 TTL 去上游重拉，但 60s 内拉过还是给缓存 ——
      // 否则狂点刷新会把第三方额度打光。
      const withinTtl = cached && now - cached.fetched_at < HOT_TTL_MS;
      const tooSoon = cached && now - cached.fetched_at < HOT_MIN_REFRESH_MS;
      if (cached && (force ? tooSoon : withinTtl)) {
        result[src] = {
          src,
          label: HOT_SRC[src].label,
          ok: true,
          cached: true,
          stale: false,
          provider: cached.provider,
          fetched_at: cached.fetched_at,
          updated: "",
          items: cached.items,
        };
        if (debug) attempts[src] = [{ provider: cached.provider, ok: true, note: "cache" }];
        return;
      }

      for (const fn of chain) {
        const name = fn.name || "upstream";
        try {
          snapshot = await fn(src);
          tries.push({ provider: name, ok: true, provider_name: snapshot.provider });
          break;
        } catch (err) {
          tries.push({
            provider: name,
            ok: false,
            error: hotCleanText(err && err.message ? err.message : err, 80),
          });
          snapshot = null;
        }
      }

      if (snapshot && snapshot.items.length) {
        await hotWriteCache(env, src, snapshot);
        result[src] = {
          src,
          label: HOT_SRC[src].label,
          ok: true,
          cached: false,
          stale: false,
          provider: snapshot.provider,
          fetched_at: now,
          updated: snapshot.updated || "",
          items: snapshot.items,
        };
      } else if (cached && cached.items.length) {
        // 全部上游都挂了：拿旧快照顶上，标记 stale，页面会提示「数据偏旧」
        result[src] = {
          src,
          label: HOT_SRC[src].label,
          ok: true,
          cached: true,
          stale: true,
          provider: cached.provider,
          fetched_at: cached.fetched_at,
          updated: "",
          items: cached.items,
        };
      } else {
        result[src] = {
          src,
          label: HOT_SRC[src].label,
          ok: false,
          cached: false,
          stale: false,
          provider: "",
          fetched_at: 0,
          updated: "",
          items: [],
        };
      }
      if (debug) attempts[src] = tries;
    })
  );

  const oldest = Math.min(
    ...srcs.map((src) => (result[src] && result[src].fetched_at) || now)
  );
  const body = {
    generated_at: now,
    refreshed_at: oldest || now,
    ttl_seconds: Math.round(HOT_TTL_MS / 1000),
    limit: HOT_LIMIT,
    labels: Object.fromEntries(
      Object.entries(HOT_SRC).map(([key, cfg]) => [key, cfg.label])
    ),
    data: result,
  };
  if (debug) body.attempts = attempts;
  return { status: 200, body };
}
