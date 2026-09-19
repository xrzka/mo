/**
 * 墨小说漫画 —— 纯静态资源导航。
 * 数据来源：同目录 data/items.json。
 * 无框架、无依赖、无后端，可直接部署到 GitHub Pages。
 */
(() => {
  "use strict";

  const DATA_URL = "data/items.json";

  /** 分区定义。新增分区在这里加一项，data/items.json 里 section 用对应 id。
   *  subs 为可选的小分区；卡片的 subsection 字段对应这里的 id。 */
  const SECTIONS = [
    { id: "all", label: "全部", icon: "◆" },
    {
      id: "novel",
      label: "小说",
      icon: "📖",
      subs: [
        { id: "site", label: "网站" },
        { id: "app", label: "软件" },
        { id: "download", label: "下载" },
        { id: "kr", label: "韩轻" },
        { id: "jp", label: "日轻" },
      ],
    },
    {
      id: "manga",
      label: "漫画",
      icon: "🎨",
      subs: [
        { id: "site", label: "网站" },
        { id: "app", label: "软件" },
        { id: "wechat", label: "公众号" },
        { id: "download", label: "下载" },
        { id: "kr", label: "韩漫" },
        { id: "jp", label: "日漫" },
      ],
    },
    {
      id: "anime",
      label: "动画",
      icon: "🎬",
      subs: [
        { id: "site", label: "网站" },
        { id: "app", label: "软件" },
      ],
    },
    {
      id: "watch",
      label: "观看",
      icon: "▶",
      subs: [
        { id: "music", label: "音乐" },
        { id: "manga", label: "漫画" },
        { id: "anime", label: "动画" },
        { id: "novel", label: "小说" },
      ],
    },
    {
      id: "game",
      label: "游戏",
      icon: "🎮",
      subs: [
        { id: "site", label: "网站" },
        { id: "app", label: "软件" },
        { id: "gal", label: "Galgame" },
      ],
    },
    { id: "music", label: "音乐", icon: "🎵",
      subs: [
        { id: "site", label: "网站" },
        { id: "app", label: "软件" },
        { id: "download", label: "下载" },
      ],
    },
    { id: "study", label: "学习", icon: "📚",
      subs: [
        { id: "course", label: "课程" },
        { id: "video", label: "视频" },
        { id: "doc", label: "资料" },
      ],
    },
    { id: "tool", label: "工具", icon: "🔧" },
    { id: "ai", label: "AI", icon: "✦",
      subs: [
        { id: "relay", label: "中转站" },
        { id: "image", label: "生图" },
        { id: "tool", label: "工具" },
      ],
    },
    { id: "forum", label: "论坛", icon: "💬" },
    { id: "guide", label: "教程 / 问题", icon: "💡" },
    { id: "collection", label: "收录 / 杂类", icon: "🗂",
      subs: [
        { id: "site", label: "网站" },
        { id: "app", label: "软件" },
        { id: "cloud", label: "云手机" },
        { id: "doc", label: "文档" },
        { id: "guide", label: "教程" },
      ],
    },
    // CS 区：以图片为主（只展示发布过的图）。条目里带 image 字段时，
    // 卡片主体直接展示那张图，不做链接型卡片。
    { id: "cs", label: "CS", icon: "🩹" },
  ];

  const SECTION_MAP = new Map(SECTIONS.map((s) => [s.id, s]));

  /** 分区填错或留空时的归属。放「收录 / 杂类」而不是小说 ——
   *  分不清归哪儿的资源本来就该落在杂类里，塞进小说会污染那个分区。 */
  const FALLBACK_SECTION = "collection";

  const PAGE_SIZES = [10, 20, 30, 50, 100];
  const DEFAULT_PAGE_SIZE = 20;

  /* ---------- 点击统计 ---------- */

  /** 统计周期。id 同时用作接口字段名和本地分桶前缀。 */
  const PERIODS = [
    { id: "day", label: "今日" },
    { id: "week", label: "本周" },
    { id: "month", label: "本月" },
    { id: "year", label: "本年" },
    { id: "all", label: "累计" },
  ];

  /** 本地各周期保留的历史桶数，防止 localStorage 无限增长。 */
  const KEEP_BUCKETS = { day: 14, week: 8, month: 12, year: 3, all: 1 };

  const STATS_KEY = "mo-hits-v1";
  // 键名带 utc 是有意的：旧键 mo-visit-day 存的是**本地日期**，新逻辑存的是
  // 后端的 UTC 日期。两者格式一样、值还常常相同，没法区分谁是谁 ——
  // 复用旧键的话，本地凌晨那批访客的旧值恰好等于新值，会让整个 UTC 日
  // 都判定成「今天已报过」，人数卡在 0。换个键名等于一次性作废旧值。
  //
  // 换键不会让人数虚高：后端 seen 表按 IP+UA+当天 的指纹去重才是真去重，
  // 这个键只是省掉重复请求。多报一次后端也只算一个人。
  const VISIT_KEY = "mo-visit-utc-day";
  const VISIT_KEY_LEGACY = "mo-visit-day";
  const RANK_LIMIT = 10;

  const pad2 = (n) => String(n).padStart(2, "0");

  /** ISO 8601 周编号。跨年那几天按 ISO 规则归属，12-31 可能算下一年第 1 周。 */
  function isoWeek(d) {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const dow = t.getUTCDay() || 7; // 周一=1 … 周日=7
    t.setUTCDate(t.getUTCDate() + 4 - dow); // 移到本周周四，ISO 年份由它决定
    const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
    return `${t.getUTCFullYear()}-W${pad2(week)}`;
  }

  /** 当前时间对应的各周期桶名。用本地时区，"今日" 才符合用户直觉。 */
  function bucketKeys(now = new Date()) {
    return {
      day: `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`,
      week: isoWeek(now),
      month: `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`,
      year: String(now.getFullYear()),
      all: "all",
    };
  }

  const emptyCounts = () => {
    const o = {};
    PERIODS.forEach((p) => (o[p.id] = {}));
    return o;
  };

  /**
   * 统计模块。两种模式：
   * - local：数据只存本机 localStorage，排行榜只反映本设备的点击，访问人数无法统计
   * - site：配置了 statsApi 时走远端汇总，所有访客共享一份数据
   * 远端不可用时自动退回 local，页面功能不受影响。
   */
  const stats = {
    mode: "local",
    counts: emptyCounts(),
    visitors: null,
    api: "",
    // 后端返回的桶名（UTC）。访问去重必须用它，不能用本地时区算的日期，
    // 否则 UTC+8 的凌晨时段前后端对不上，见 reportVisit()。
    buckets: null,

    init() {
      const cfg = window.MO_CONFIG || {};
      // 支持配多个接口地址：按顺序试，第一个通的就用。
      // 需要这个是因为 *.workers.dev 在国内被墙，得挂个 *.pages.dev 兜底。
      const list = Array.isArray(cfg.statsApi)
        ? cfg.statsApi
        : cfg.statsApi
          ? [cfg.statsApi]
          : [];
      this.candidates = list
        .filter((s) => typeof s === "string" && s.trim())
        .map((s) => s.trim().replace(/\/+$/, ""));
      this.api = this.candidates[0] || "";
      this.loadLocal();
    },

    /* --- 本机模式 --- */

    loadLocal() {
      let raw = null;
      try {
        raw = JSON.parse(localStorage.getItem(STATS_KEY) || "null");
      } catch {
        raw = null; // 数据损坏就当空的重来，不影响页面
      }
      this.store = raw && typeof raw === "object" ? raw : {};
      this.pruneLocal();
      this.counts = this.collapseLocal();
    },

    saveLocal() {
      try {
        localStorage.setItem(STATS_KEY, JSON.stringify(this.store));
      } catch {
        /* 隐私模式或配额满时静默失败，统计不重要到需要打断用户 */
      }
    },

    /** 只保留近若干个桶，老的丢掉。 */
    pruneLocal() {
      Object.keys(KEEP_BUCKETS).forEach((period) => {
        const g = this.store[period];
        if (!g) return;
        const keys = Object.keys(g).sort();
        const drop = keys.length - KEEP_BUCKETS[period];
        if (drop > 0) keys.slice(0, drop).forEach((k) => delete g[k]);
      });
    },

    /** 把「周期 → 桶 → 计数」压成当前生效的「周期 → 计数」。 */
    collapseLocal() {
      const now = bucketKeys();
      const out = emptyCounts();
      PERIODS.forEach((p) => {
        out[p.id] = { ...((this.store[p.id] || {})[now[p.id]] || {}) };
      });
      return out;
    },

    bumpLocal(id) {
      const now = bucketKeys();
      PERIODS.forEach((p) => {
        const g = (this.store[p.id] = this.store[p.id] || {});
        const bucket = (g[now[p.id]] = g[now[p.id]] || {});
        bucket[id] = (bucket[id] || 0) + 1;
        this.counts[p.id][id] = bucket[id];
      });
      this.pruneLocal();
      this.saveLocal();
    },

    /* --- 全站模式 --- */

    /** 拉取远端汇总。依次试各个候选地址，第一个通的就定为 this.api。 */
    async pull() {
      const list = this.candidates || [];
      // 国内直连 pages.dev 的 TLS 握手偶发超时（实测约 20% 首次失败），
      // 所以整轮候选跑完还失败时再重试一轮。两轮都不行才退回本机模式。
      for (let round = 0; round < 2; round++) {
        for (const base of list) {
          try {
            // 单个地址最多等 10 秒。被墙的地址会一直挂到 TCP 超时（十几秒），
            // 不设上限的话首屏统计要等很久。
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 10000);
            let res;
            try {
              res = await fetch(`${base}/api/stats`, {
                cache: "no-store",
                signal: ctrl.signal,
              });
            } finally {
              clearTimeout(timer);
            }
            if (!res.ok) throw new Error("HTTP " + res.status);
            const data = await res.json();
            const counts = emptyCounts();
            PERIODS.forEach((p) => {
              const t = (data.clicks || {})[p.id];
              if (t && typeof t === "object") counts[p.id] = t;
            });
            this.counts = counts;
            this.visitors =
              data.visitors && typeof data.visitors === "object" ? data.visitors : null;
            // 后端的桶名是 UTC 的，记下来给 reportVisit 去重用
            this.buckets = data.buckets && typeof data.buckets === "object" ? data.buckets : null;
            this.api = base; // 后续上报都发这个地址
            this.mode = "site";
            return true;
          } catch {
            // 这个地址不通，试下一个
          }
        }
        if (round === 0 && list.length) await new Promise((r) => setTimeout(r, 800));
      }
      this.mode = "local";
      return false;
    },

    /** 记录一次点击。本机先加，远端异步上报，不阻塞跳转。 */
    record(id) {
      if (!id) return;
      if (this.mode === "site") {
        PERIODS.forEach((p) => {
          this.counts[p.id][id] = (this.counts[p.id][id] || 0) + 1;
        });
        this.post("/api/hit", { id });
      } else {
        this.bumpLocal(id);
        // 本机模式可能是首次拉取时网络抖动导致的降级。这里补一次上报，
        // 通了就不会丢这次点击 —— 计数只增不减，多报一次也不会算错。
        this.retryPost("/api/hit", { id });
      }
    },

    /** 每天首次打开时上报一次访问，靠 localStorage 去重，避免刷新灌水。
     *
     *  去重键必须用**后端返回的 UTC 日期**，不能用 bucketKeys().day（本地时区）。
     *  这台机器是 UTC+8：本地 09-04 00:00~08:00 时，后端还在 09-03 桶里。
     *  用本地日期的话，那 8 小时内来的访客会把 mo-visit-day 写成 09-04，
     *  等后端跨到 09-04 桶时，他们已经「今天报过了」，于是当天访问人数一直是 0
     *  —— 正是排行榜显示「今日 0 人」而本周/本月有数的原因。
     */
    reportVisit() {
      if (this.mode !== "site") return;
      // 拿不到后端桶名时退回本地日期，总比不报好
      const today = (this.buckets && this.buckets.day) || bucketKeys().day;
      let last = null;
      try {
        last = localStorage.getItem(VISIT_KEY);
        // 顺手清掉旧键，免得一直占着 localStorage
        if (localStorage.getItem(VISIT_KEY_LEGACY) !== null) {
          localStorage.removeItem(VISIT_KEY_LEGACY);
        }
      } catch {
        last = null;
      }
      if (last === today) return;
      this.post("/api/visit", {});
      try {
        localStorage.setItem(VISIT_KEY, today);
      } catch {
        /* 存不下就下次再报，最多重复计一次 */
      }
    },

    post(path, body) {
      if (!this.api) return;
      // keepalive 让请求在页面跳转后仍能发出；失败无所谓，不重试
      fetch(this.api + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        keepalive: true,
      }).catch(() => {});
    },

    /** 降级状态下的补报：按顺序试候选地址，成功一个就停。
     *  必须串行 —— 两个地址写的是同一个库，并行发会把一次点击算成两次。 */
    async retryPost(path, body) {
      for (const base of this.candidates || []) {
        try {
          const res = await fetch(base + path, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            keepalive: true,
          });
          if (res.ok) return;
        } catch {
          // 这个地址不通，试下一个
        }
      }
    },

    table(period) {
      return this.counts[period] || {};
    },

    hits(id, period = "all") {
      return this.table(period)[id] || 0;
    },
  };

  const state = {
    items: [],
    // 观看区由 APK 的网页逻辑适配；数据通过同源 Worker 白名单接口读取。
    watchKind: "music",
    watchQuery: "",
    watchItems: [],
    watchLoading: false,
    watchError: "",
    watchRequest: 0,
    watchViewRequest: 0,
    watchViewerOpen: false,
    watchLimit: 20,
    watchSource: "", // 漫画线路，空字符串 = 自动
    // 动画区按上游页翻页（上游有 306 页，每页 20 部），本地不再累加。
    animePage: 1,
    animeTotalPages: 1,
    // items.json 的原始数据。改完覆盖层要用它重建 items，不必重新发请求。
    rawItems: [],
    // 后台新增的条目（来自 /api/items）。和 rawItems 拼起来才是完整数据源。
    customItems: [],
    generatedAt: null,
    section: "all",
    sub: "all",
    q: "",
    adultMode: false, // 默认未成年模式，成人向内容不显示
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    sort: "default", // default | hits-<period>
    statsPeriod: "day", // 排行榜当前展示的周期
    statsOpen: false,
    wantedOpen: false,
    wantedStatus: "open", // open | found | closed
    wantedKind: "want", // want 想要资源 | broken 失效反馈
    // 后端是否已部署认识 kind 的那版。老后端会把失效反馈当成「想要资源」
    // 记成一条以资源名为标题的求助，所以探测不到就整块不给用。
    brokenReady: false,
    wantedItems: [],
    wantedSummary: { want: { open: 0, found: 0, closed: 0 }, broken: { open: 0, found: 0, closed: 0 } },
    wantedLoaded: false,
  };

  // 本机已反馈过失效的条目 id。init() 里赋值，用于让按钮在刷新后仍是完成态。
  let reportedSet = new Set();

  // 后台编辑的覆盖层：{ itemId: {name?, description?, url?, ..., deleted?, updated} }
  // deleted=true 是静态 items.json 卡片的软删除标记；访客侧加载后直接过滤。
  let overrides = {};

  // 管理员登录态。token 只放内存，不落 localStorage ——
  // 存起来省事，但 XSS 一旦发生就等于把写权限也交出去了。
  // 代价是刷新页面要重新登录，改几条内容而已，可以接受。
  let adminToken = "";

  // 保存/撤销后整页重渲染会把卡片换成新节点，编辑器和提示随之消失，
  // 看着像什么都没发生。这里记住「哪张卡刚操作过、要显示什么提示」，
  // 新卡片建好时自动恢复成展开态。
  let adminFlash = null;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const fmtDate = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d)) return "—";
    return d.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
  };
  /** 复制到剪贴板，并在按钮上给出反馈。 */
  async function copyText(text, btn) {
    const original = "复制";
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = "已复制";
    } catch {
      btn.textContent = "请手动复制";
    }
    setTimeout(() => (btn.textContent = original), 1500);
  }

  /** 百分比加载进度图片：小说插图 / 漫画页 / CS 封面与截图共用。
   *
   *  为什么要 fetch 流式读：<img> 只有 onload/onerror，没有进度事件；要拿到
   *  「已下载/总大小」只能自己 fetch + ReadableStream 累加 chunk。两条路各有代价：
   *   - 图床给了 Content-Length 且 CORS 放行 → 精确百分比；
   *   - 不给长度 / 不给 CORS → 拿不到字节数，退化成「不确定态」进度条（照样转圈），
   *     并且在 fetch 失败时**直接回落给 <img> 自己加载**（可能是跨域没放开，
   *     但 <img> 不吃 CORS，能正常显示），保证图一定显示得出来。
   *
   *  行为按需求：到 100% 或加载失败才「完整展示」（淡入），中途只显示进度。
   */
  function loadImageWithProgress(src, opts = {}) {
    const {
      alt = "", className = "", wrapClass = "img-progress-wrap",
      onDone = null, retryOnFail = false, lazy = false,
    } = opts;
    const wrap = document.createElement("div");
    wrap.className = wrapClass;

    const bar = document.createElement("div");
    bar.className = "img-progress";
    const fill = document.createElement("i");
    fill.className = "img-progress-fill";
    const pct = document.createElement("span");
    pct.className = "img-progress-pct";
    pct.textContent = "0%";
    bar.append(fill, pct);

    const img = document.createElement("img");
    img.className = className;
    img.alt = alt;
    img.decoding = "async";
    img.referrerPolicy = "no-referrer";   // 图床（linovelib 等）认 referer，浏览器直载也要挡
    img.hidden = true;                    // 没到 100% 不显示（避免半张图闪）
    wrap.append(bar, img);

    let settled = true;                   // 先 true：lazy 未 arm 前不会被 12s 兜底误判
    let idleTimer = 0;
    let failBox = null;
    let observer = null;

    const setPct = (p) => {
      const v = Math.max(0, Math.min(100, Math.round(p)));
      fill.style.width = v + "%";
      pct.textContent = v + "%";
    };
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      bar.remove();
      if (ok) {
        img.hidden = false;
      } else if (retryOnFail) {
        // 失败态也算「完整展示」：占位 + 点击重试，不给半张图
        failBox = document.createElement("button");
        failBox.type = "button";
        failBox.className = "img-progress-fail";
        failBox.textContent = "图片加载失败 · 点击重试";
        failBox.addEventListener("click", () => retry());
        wrap.appendChild(failBox);
      }
      wrap.classList.add(ok ? "is-loaded" : "is-failed");
      onDone && onDone(ok);
    };

    function loadDirect() {
      if (img.getAttribute("src")) return;
      img.src = src;
      img.addEventListener("load", () => finish(true), { once: true });
      img.addEventListener("error", () => finish(false), { once: true });
    }

    function begin() {
      if (typeof fetch !== "function" || !window.ReadableStream) { loadDirect(); return; }
      (async () => {
        let res;
        try {
          res = await fetch(src, { mode: "cors", credentials: "omit", referrerPolicy: "no-referrer" });
        } catch { loadDirect(); return; }
        if (!res.ok || !res.body || !res.body.getReader) { loadDirect(); return; }
        const total = Number(res.headers.get("content-length")) || 0;
        try {
          const reader = res.body.getReader();
          const chunks = [];
          let got = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            got += value.length;
            if (total) setPct((got / total) * 100);
            else setPct(Math.min(95, (got / 262144) * 100)); // 无长度：按 256KB 估一个渐进值，封顶 95%
          }
          setPct(100);
          const blob = new Blob(chunks, { type: res.headers.get("content-type") || "image/*" });
          img.src = URL.createObjectURL(blob);
          img.addEventListener("load", () => finish(true), { once: true });
          img.addEventListener("error", () => finish(false), { once: true });
        } catch { loadDirect(); }
      })();
      // 兜底：流式读卡住不动时，交给 <img> 自己加载，别让图永远不出现
      idleTimer = setTimeout(() => { if (!settled && !img.getAttribute("src")) loadDirect(); }, 12000);
    }

    function retry() {
      settled = false;
      wrap.classList.remove("is-loaded", "is-failed");
      if (failBox) { failBox.remove(); failBox = null; }
      img.removeAttribute("src");
      img.hidden = true;
      if (!bar.isConnected) wrap.prepend(bar);
      setPct(0);
      begin();
    }

    // lazy：一章漫画二三十张图，别把流量一次性打满；滚到视口附近才开始计进度
    if (lazy && typeof IntersectionObserver === "function") {
      observer = new IntersectionObserver((entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        observer.disconnect();
        observer = null;
        settled = false;
        begin();
      }, { rootMargin: "250% 0px" });
      observer.observe(wrap);
    } else {
      settled = false;
      begin();
    }

    return wrap;
  }

  /** 图片大图查看：CS 截图在窄列里看不清，点图放大。
   *  点图=下一张，点背景/按 Esc=关闭。遮罩盖住一切但只由本组件创建。 */
  function openLightbox(srcs, start) {
    let box = document.getElementById("lightbox");
    if (!box) {
      box = document.createElement("div");
      box.id = "lightbox";
      box.className = "lightbox";
      const img = document.createElement("img");
      img.className = "lightbox-img";
      box.appendChild(img);
      box.addEventListener("click", (e) => {
        e.stopPropagation();
        if (e.target === box) { box.remove(); document.body.classList.remove("no-scroll"); return; }
        const list = (box._srcs || []).slice();
        if (!list.length) return;
        box._i = ((box._i || 0) + 1) % list.length;
        img.src = list[box._i];
      });
      document.body.appendChild(box);
    }
    box._srcs = srcs;
    box._i = start;
    box.querySelector("img").src = srcs[start];
    document.body.classList.add("no-scroll");
    const onKey = (e) => {
      if (e.key === "Escape") { box.remove(); document.body.classList.remove("no-scroll"); document.removeEventListener("keydown", onKey); }
    };
    document.removeEventListener("keydown", openLightbox._onKey || (() => {}));
    openLightbox._onKey = onKey;
    document.addEventListener("keydown", onKey);
  }

  /** 收敛原始数据，缺字段给安全默认值；未知分区归到「收录 / 杂类」以免丢卡片。
   *
   *  ov 是后台编辑的覆盖层（来自 /api/overrides）。站点是纯静态的，浏览器改不了
   *  items.json，所以后台编辑存在 D1 里，渲染前在这里合并进来。
   *  **id 不在覆盖范围**（点击数与失效反馈都以它为键），但分区可以覆盖 ——
   *  换区不动 id，统计和反馈都跟着走。见 worker 的 OVERRIDE_FIELDS。
   */
  function normalize(raw, index, ov) {
    // 覆盖值优先。用 in 判断而不是真值判断：空串是有意义的覆盖（显示为空），
    // 而 `ov.password || raw.password` 会把空串当成「没改」退回原值。
    const pick = (field, fallback) =>
      ov && field in ov && typeof ov[field] === "string" ? ov[field] : fallback;

    const subOf = (secId, subId) => {
      const subs = (SECTION_MAP.get(secId) || {}).subs || [];
      return subs.some((s) => s.id === subId) ? subId : null;
    };

    /** 解析 'novel:download,novel:jp,manga:kr' 这种归属串成 [{id, sub}]。
     *  未知分区丢掉而不是回落 —— 回落会把它塞进兜底区，一条资源莫名出现在
     *  「收录 / 杂类」里比少一个归属更难解释。
     *
     *  去重键是完整的「分区:小分区」对，不是分区本身 —— 同一分区挂多个小分区
     *  （小说/下载 + 小说/日轻）是合法组合，按分区去重会把第二个吃掉。 */
    const parsePlacements = (text) => {
      const out = [];
      const seen = new Set();
      String(text || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((part) => {
          const [secId, subId = ""] = part.split(":").map((s) => s.trim());
          if (!SECTION_MAP.has(secId) || secId === "all") return;
          const sub = subOf(secId, subId);
          const key = `${secId}:${sub || ""}`;
          if (seen.has(key)) return;
          seen.add(key);
          out.push({ id: secId, sub });
        });
      // 同区「不指定小分区」与具体小分区并存时丢掉前者：它是后者的超集，
      // 两个都留会让这条资源在该区列表里出现两次。后端也做同样处理。
      const withSub = new Set(out.filter((p) => p.sub).map((p) => p.id));
      return out.filter((p) => p.sub || !withSub.has(p.id));
    };

    // 分区归属。优先级：后台的 placements > 后台的 section > items.json 的
    // section + also_in。前端仍做白名单校验 —— 覆盖层的值理论上后端校验过，
    // 但不该信任远端数据。
    //
    // 一份资源可能同时属于多个分区：网盘包里既有小说又有漫画，只挂在小说区的话
    // 逛漫画区的人根本看不见它。第一个归属是主分区（卡片默认显示它的标签）。
    // 不做成多条独立条目：那样点击数、失效反馈都会被拆开。
    let sections = [];
    if (ov && typeof ov.placements === "string" && ov.placements) {
      sections = parsePlacements(ov.placements);
    } else if (ov && typeof ov.section === "string" && ov.section) {
      // 老形式的单值覆盖。改过分区就不带 also_in ——
      // 用户明确指定了归属，再挂回原来的附加分区会让「移走了却还在」。
      const secId = SECTION_MAP.has(ov.section) ? ov.section : FALLBACK_SECTION;
      sections = [{ id: secId, sub: subOf(secId, pick("subsection", raw.subsection)) }];
    } else if (typeof raw.placements === "string" && raw.placements) {
      // 后台新增的条目自带 placements
      sections = parsePlacements(raw.placements);
    } else {
      const secId =
        SECTION_MAP.has(raw.section) && raw.section !== "all" ? raw.section : FALLBACK_SECTION;
      sections = [{ id: secId, sub: subOf(secId, raw.subsection) }];
      (Array.isArray(raw.also_in) ? raw.also_in : []).forEach((extra) => {
        const id = extra && extra.section;
        if (!SECTION_MAP.has(id) || id === "all") return;
        if (sections.some((s) => s.id === id)) return;
        sections.push({ id, sub: subOf(id, extra.subsection) });
      });
    }
    // 解析后一个都不剩（数据坏了）时兜一个，别让卡片没有归属而消失
    if (!sections.length) sections = [{ id: FALLBACK_SECTION, sub: null }];

    const section = sections[0].id;
    const sub = sections[0].sub;

    const url = pick("url", raw.url || "");
    const password = pick("password", raw.password || "");
    // links 里的主源要跟着改后的 url / 提取码走，否则「打开」按钮还指向旧地址
    const rawLinks = Array.isArray(raw.links) && raw.links.length
      ? raw.links.filter((l) => l && /^https?:\/\//i.test(l.url))
      : url
        ? [{ name: "打开", url, password }]
        : [];
    const links = rawLinks.map((l, i) =>
      i === 0 ? { ...l, url: url || l.url, password: password || l.password } : l
    );

    return {
      id: raw.id || "item-" + index,
      name: pick("name", raw.name || "未命名资源"),
      description: pick("description", raw.description || "暂无简介"),
      url,
      section,
      sub,
      sections,
      icon: raw.icon || SECTION_MAP.get(section).icon,
      image: pick("image", raw.image || ""),
      // 多图条目（CS 挂人记录这类，一次发几张截图 = 一张卡）：归一化裁掉坏值，最多 12 张。
      images: Array.isArray(raw.images)
        ? raw.images.filter((s) => typeof s === "string" && s).slice(0, 12)
        : [],
      tags: Array.isArray(raw.tags) ? raw.tags.slice(0, 6) : [],
      kind: raw.kind || "网站",
      needLogin: raw.need_login === true,
      updateInfo: raw.update_info || "未标注",
      note: pick("note", raw.note || ""),
      password,
      adult: raw.adult === true,
      // 后台是否改过这条，卡片上给个小标记，方便自己核对
      edited: !!(ov && Object.keys(ov).some((k) => k !== "updated")),
      links,
    };
  }

  function matchesQuery(item, q) {
    if (!q) return true;
    const n = q.toLowerCase();
    return (
      item.name.toLowerCase().includes(n) ||
      item.description.toLowerCase().includes(n) ||
      item.tags.some((t) => String(t).toLowerCase().includes(n))
    );
  }

  /** 分区匹配；小分区只在选中主分区时生效。
   *  走 item.sections 而不是 item.section —— 跨区资源（如小说+漫画的网盘包）
   *  在它列出的每个分区里都该出现。 */
  const inSection = (item, sectionId, subId = "all") => {
    if (sectionId === "all") return true;
    return (item.sections || [{ id: item.section, sub: item.sub }]).some(
      (s) => s.id === sectionId && (subId === "all" || s.sub === subId)
    );
  };

  /** 当前分区下该显示哪个小分区标签（跨区资源在不同区归属不同）。 */
  const subInSection = (item, sectionId) => {
    const hit = (item.sections || []).find((s) => s.id === sectionId);
    return hit ? hit.sub : item.sub;
  };

  /** 未成年模式下过滤掉成人向条目。所有计数与列表都必须经过这一层。 */
  const allowedItems = () => state.items.filter((it) => state.adultMode || !it.adult);

  /** 按点击数排序时用的周期；非点击排序返回 null。 */
  const sortPeriod = () =>
    state.sort.startsWith("hits-") ? state.sort.slice("hits-".length) : null;

  const visibleItems = () => {
    const list = allowedItems().filter(
      (it) => inSection(it, state.section, state.sub) && matchesQuery(it, state.q)
    );
    const period = sortPeriod();
    if (!period) return list;
    // 点击数相同时按名称排，否则每次渲染顺序会飘（数据里大量 0 次）
    return list.slice().sort((a, b) => {
      const d = stats.hits(b.id, period) - stats.hits(a.id, period);
      return d !== 0 ? d : a.name.localeCompare(b.name, "zh-CN");
    });
  };

  const totalPages = (total) => Math.max(1, Math.ceil(total / state.pageSize));

  /** 当前页的条目。页码越界时自动收敛到最后一页。 */
  function pagedItems(list) {
    const pages = totalPages(list.length);
    if (state.page > pages) state.page = pages;
    if (state.page < 1) state.page = 1;
    const start = (state.page - 1) * state.pageSize;
    return list.slice(start, start + state.pageSize);
  }

  /* ---------- 渲染 ---------- */

  function renderTabs() {
    const bar = $("[data-tabs]");
    bar.textContent = "";
    const pool = allowedItems();
    SECTIONS.forEach((s) => {
      // 计数只受搜索词影响，不受当前分区影响，这样切换分区时数字稳定
      const n = pool.filter((it) => inSection(it, s.id) && matchesQuery(it, state.q)).length;

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tab-btn";
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", String(state.section === s.id));
      btn.textContent = s.label;

      // 观看区数据来自实时上游，不属于 items.json；显示 0 会让人误以为入口是空的。
      if (s.id !== "watch") {
        const cnt = document.createElement("span");
        cnt.className = "tab-count";
        cnt.textContent = n;
        btn.appendChild(cnt);
      }

      btn.addEventListener("click", () => {
        if (state.section === "watch" && s.id !== "watch") closeWatchViewer();
        state.section = s.id;
        state.sub = s.id === "watch" ? state.watchKind : "all";
        state.page = 1;
        render();
        if (s.id === "watch" && !state.watchItems.length) loadWatch();
      });
      bar.appendChild(btn);
    });
  }

  /** 小分区标签栏：只在当前主分区定义了 subs 时显示。 */
  function renderSubTabs() {
    const bar = $("[data-subtabs]");
    bar.textContent = "";
    const subs = (SECTION_MAP.get(state.section) || {}).subs;
    if (!subs) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;

    // 用 inSection 而不是 it.section === ——否则跨区资源不进小分区计数
    const inCurrent = allowedItems().filter(
      (it) => inSection(it, state.section) && matchesQuery(it, state.q)
    );
    const options = [{ id: "all", label: "全部" }, ...subs];

    options.forEach((o) => {
      // 一条资源可能在同一分区下挂了多个小分区（如「小说/下载」+「小说/日轻」），
      // 所以要看它在这个区的所有归属里有没有命中，不能只看第一个。
      const n = inCurrent.filter((it) => o.id === "all" || inSection(it, state.section, o.id))
        .length;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "subtab-btn";
      btn.setAttribute("aria-selected", String(state.sub === o.id));
      btn.textContent = o.label;

      if (state.section !== "watch") {
        const cnt = document.createElement("span");
        cnt.className = "tab-count";
        cnt.textContent = n;
        btn.appendChild(cnt);
      }

      btn.addEventListener("click", () => {
        state.sub = o.id;
        state.page = 1;
        if (state.section === "watch") {
          if (o.id === "all") state.sub = state.watchKind;
          else {
            closeWatchViewer();
            state.watchKind = o.id;
            state.watchItems = [];
            state.watchError = "";
            state.watchQuery = "";
            state.animePage = 1;
            state.animeTotalPages = 1;
            const input = $("[data-watch-query]");
            if (input) input.value = "";
          }
        }
        render();
        if (state.section === "watch" && o.id !== "all") loadWatch();
      });
      bar.appendChild(btn);
    });
  }
  /** 全部文本走 textContent，数据内容不会被当 HTML 执行。 */
  function buildCard(item) {
    const node = $("[data-card-template]").content.firstElementChild.cloneNode(true);
    const field = (name) => node.querySelector(`[data-field="${name}"]`);
    node.dataset.itemId = item.id; // 排行榜定位时靠它找卡片

    field("icon").textContent = item.icon;
    field("name").textContent = item.name;
    field("description").textContent = item.description;

    // CS 区以图片为主：条目带 image 字段时，把该图作为卡片主视觉（图下方
    // 仍是名称/简介）。带百分比进度，加载失败或留空就回落成普通图标卡片。
    if (item.image) {
      node.classList.add("has-image");
      const holder = loadImageWithProgress(item.image, {
        alt: item.name || "图片",
        className: "cs-image",
        onDone: (ok) => {
          if (!ok) { holder.remove(); node.classList.remove("has-image"); }
        },
      });
      node.prepend(holder);
    }

    // 多图（CS 挂人记录：四张截图 = 一张卡）。点开可看大图，再点任意处关闭。
    if (item.images.length) {
      node.classList.add("has-image");
      const gal = document.createElement("div");
      gal.className = "cs-gallery";
      item.images.forEach((src, gi) => {
        const holder = loadImageWithProgress(src, {
          alt: (item.name || "图片") + " " + (gi + 1),
          wrapClass: "img-progress-wrap cs-gallery-cell",
          onDone: (ok) => {
            if (!ok) holder.remove();
          },
        });
        holder.addEventListener("click", (e) => {
          if (e.target.closest(".img-progress")) return; // 还在加载中，点了不放大
          e.stopPropagation();
          openLightbox(item.images, gi);
        });
        gal.appendChild(holder);
      });
      node.prepend(gal);
    }

    // 标签跟着当前所在分区走：同一份「小说+漫画」资源，在小说区显示「韩轻」，
    // 在漫画区显示「韩漫」，比永远显示主分区更符合用户此刻的语境。
    const shownSec = state.section !== "all" && inSection(item, state.section)
      ? state.section
      : item.section;
    const secDef = SECTION_MAP.get(shownSec);
    // 当前区的小分区标签。一条资源可能在同一区挂了多个小分区
    // （「小说/下载」+「小说/日轻」），此刻正在看哪个小分区就显示哪个。
    const shownSub =
      state.section === shownSec && state.sub !== "all" &&
      inSection(item, shownSec, state.sub)
        ? state.sub
        : subInSection(item, shownSec);
    const subDef = (secDef.subs || []).find((s) => s.id === shownSub);
    // 有小分区就显示小分区名，更具体
    field("section").textContent = subDef ? subDef.label : secDef.label;

    // 挂在多处的资源额外标一下其余位置，让人知道这一份里还有别的内容。
    // 同区的另一个小分区也算 —— 「也在 日轻」和「也在 漫画」同样有用。
    if ((item.sections || []).length > 1) {
      const others = [];
      item.sections.forEach((s) => {
        if (s.id === shownSec && s.sub === shownSub) return;   // 当前这个位置
        const secLabel = (SECTION_MAP.get(s.id) || {}).label;
        if (!secLabel) return;
        const subLabel = ((SECTION_MAP.get(s.id) || {}).subs || [])
          .find((x) => x.id === s.sub);
        // 同区内的另一个小分区只写小分区名，不必重复大区名
        const text = s.id === shownSec
          ? (subLabel ? subLabel.label : secLabel)
          : (subLabel ? `${secLabel} · ${subLabel.label}` : secLabel);
        if (!others.includes(text)) others.push(text);
      });
      if (others.length) {
        const pill = document.createElement("span");
        // also-in 这个类是给测试与样式用的：「后台已改」标记长得一样，
        // 只按 .alt 找会拿到先插入的那个（after 插在参考节点紧后面）。
        pill.className = "section-pill alt also-in";
        pill.textContent = "也在 " + others.join(" / ");
        field("section").after(pill);
      }
    }

    const tagList = field("tags");
    item.tags.forEach((t) => {
      const li = document.createElement("li");
      li.textContent = t;
      tagList.appendChild(li);
    });

    field("kind").textContent = item.kind;
    field("login").textContent = item.needLogin ? "需要" : "不需要";
    field("updateInfo").textContent = item.updateInfo;
    field("note").textContent = item.note;
    // CS 文字记录这类多行 note：pre-wrap 保住换行，普通单行 note 不受影响。
    field("note").classList.toggle("cs-note-text", item.note.includes("\n"));

    // 后台改过的条目给个标记 —— 只对已登录的自己显示，访客看不到，
    // 免得让人以为站里的内容被人动过手脚。
    if (item.edited && adminToken) {
      const mark = document.createElement("span");
      mark.className = "section-pill alt";
      mark.textContent = "后台已改";
      field("section").after(mark);
    }

    // 点击数角标：按当前排序周期显示，0 次不显示以免整页都是「0 次」
    const paintHits = () => {
      const hitsPill = field("hits");
      const period = sortPeriod() || "all";
      const n = stats.hits(item.id, period);
      if (n > 0) {
        const label = (PERIODS.find((p) => p.id === period) || {}).label || "";
        hitsPill.hidden = false;
        hitsPill.textContent = `${label} ${n} 次`;
      } else {
        hitsPill.hidden = true;
      }
    };
    paintHits();

    // 提取码：多个网盘源可能各有各的码，所以放在每个源的按钮旁边
    const pwWrap = field("passwordWrap");
    const singlePw = item.links.length === 1 ? item.links[0].password : "";
    if (singlePw) {
      field("password").textContent = singlePw;
      const btn = field("copyPw");
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        copyText(singlePw, btn);
      });
    } else {
      pwWrap.remove();
    }

    // 网盘源按钮：一个源一个按钮，各自带提取码
    const linkBox = field("links");
    if (item.links.length) {
      item.links.forEach((lk) => {
        const row = document.createElement("div");
        row.className = "link-row";

        const a = document.createElement("a");
        a.className = "visit-link";
        a.href = lk.url;
        a.target = "_blank";
        a.rel = "noreferrer noopener";
        a.textContent = (lk.label ? `${lk.name} · ${lk.label}` : lk.name) + " ↗";
        // 计一次点击。不 preventDefault，跳转照常走浏览器默认行为。
        // 只刷新这张卡的角标和排行榜，不整页重渲染 —— 重渲染会把用户
        // 展开的卡片收回去，正在点的这一行会从脚下消失。
        a.addEventListener("click", () => {
          stats.record(item.id);
          paintHits();
          renderStats();
        });
        row.appendChild(a);

        // 多源时每个源的提取码单独给一个复制按钮
        if (lk.password && item.links.length > 1) {
          const code = document.createElement("code");
          code.className = "pw-code";
          code.textContent = lk.password;
          row.appendChild(code);

          const cp = document.createElement("button");
          cp.type = "button";
          cp.className = "pw-copy";
          cp.textContent = "复制";
          cp.addEventListener("click", (e) => {
            e.stopPropagation();
            copyText(lk.password, cp);
          });
          row.appendChild(cp);
        }
        linkBox.appendChild(row);
      });
    } else {
      linkBox.remove();
    }

    // 失效反馈按钮：所有条目都给，不按「有没有链接」筛。
    // 链接能打开不代表内容还在 —— 教程文档打得开、里面的网盘链接照样会死；
    // 反过来，压根没给链接的条目是最彻底的拿不到。该判断的是「用户能不能拿到
    // 资源」，那件事光看 links 字段判断不了，所以交给用户来报。
    // 唯一的门禁是后端得认识 kind —— 老后端会把它存成一条以资源名为标题的求助。
    // 放在卡片里而不是做成独立表单，是为了自动带上这条的 id ——
    // 让用户手打资源名的话，收到的反馈往往对不上具体条目。
    const reportWrap = field("reportWrap");
    if (state.brokenReady) {
      reportWrap.hidden = false;
      const btn = field("reportBtn");
      const msg = field("reportMsg");
      // 没给链接的条目说「链接失效」不通 —— 它压根没有链接，文案换成「求补档」
      const label = item.links.length ? "链接失效？点这里反馈" : "没有链接？点这里求补档";
      btn.textContent = label;
      // 已反馈过的条目直接显示成完成态，刷新页面后按钮状态仍然正确
      if (reportedSet.has(item.id)) {
        btn.disabled = true;
        btn.textContent = "已反馈过，等待补档";
        btn.classList.add("done");
      }
      btn.addEventListener("click", (e) => {
        e.stopPropagation();   // 别让点击冒泡去折叠卡片
        reportBroken(item, btn, msg);
      });
    } else {
      reportWrap.remove();
    }

    // 后台编辑入口：只有登录后才存在。没登录时整块 remove 掉，
    // 而不是 hidden —— DOM 里压根不留，免得看着像藏了个入口。
    const adminWrap = field("adminWrap");
    if (adminToken) {
      adminWrap.hidden = false;
      const btn = field("adminBtn");
      const msg = field("adminMsg");
      const box = field("adminForm");
      const openEditor = () => {
        box.hidden = false;
        btn.textContent = "收起编辑";
        buildAdminEditor(item, node, box, msg);
      };
      btn.addEventListener("click", (e) => {
        e.stopPropagation();   // 别让点击冒泡把卡片折起来
        if (box.hidden) {
          openEditor();
        } else {
          box.hidden = true;
          btn.textContent = "编辑这条";
        }
      });
      // 保存后这张卡会被整块换掉。adminFlash 让新卡片自动回到「编辑器展开 +
      // 显示上一步结果」的状态 —— 否则点了保存表单就收起、提示也没了，
      // 看着像什么都没发生。
      if (adminFlash && adminFlash.id === item.id) {
        openEditor();
        msg.textContent = adminFlash.text;
        msg.className = "card-admin-msg" + (adminFlash.kind ? " " + adminFlash.kind : "");
      }
    } else {
      adminWrap.remove();
    }

    const detail = node.querySelector("[data-detail]");
    const toggle = () => {
      const open = node.getAttribute("aria-expanded") === "true";
      node.setAttribute("aria-expanded", String(!open));
      detail.hidden = open;
    };

    // 整张卡片可点来展开/收起，但卡片里的可交互元素不能触发它。
    // 早先只排除了 <a>，于是点后台编辑的输入框会冒泡上来把卡片收起 ——
    // 光靠给每个控件加 stopPropagation 容易漏，这里按元素类型统一判断。
    const INTERACTIVE = "a, button, input, textarea, select, label, code";
    const fromControl = (e) => !!(e.target.closest && e.target.closest(INTERACTIVE));

    node.addEventListener("click", (e) => {
      if (fromControl(e)) return;
      toggle();
    });
    node.addEventListener("keydown", (e) => {
      // 只有焦点在卡片本身时才响应 Enter/空格。不判断的话，在输入框里
      // 敲空格会被 preventDefault 吃掉 —— 连空格都打不出来。
      if (e.target !== node) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
      }
    });

    return node;
  }

  function renderFeed() {
    const list = visibleItems();
    const page = pagedItems(list);
    const feed = $("[data-feed]");
    feed.textContent = "";
    const frag = document.createDocumentFragment();
    page.forEach((it) => frag.appendChild(buildCard(it)));
    feed.appendChild(frag);

    $("[data-empty]").hidden = list.length > 0;
    const secDef = SECTION_MAP.get(state.section);
    const subDef = (secDef.subs || []).find((s) => s.id === state.sub);
    const label = subDef ? `${secDef.label} · ${subDef.label}` : secDef.label;
    $("[data-result-count]").textContent = list.length
      ? `${label} · 共 ${list.length} 个资源`
      : "";

    renderPager(list.length);
  }

  /** 页码按钮序列：首尾各留 1 个，当前页左右各留 1 个，其余用省略号。 */
  function pageNumbers(current, total) {
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    const out = new Set([1, total, current]);
    if (current - 1 > 1) out.add(current - 1);
    if (current + 1 < total) out.add(current + 1);
    const nums = [...out].sort((a, b) => a - b);
    const withGaps = [];
    nums.forEach((n, i) => {
      if (i && n - nums[i - 1] > 1) withGaps.push("gap");
      withGaps.push(n);
    });
    return withGaps;
  }

  /** 翻页条：共 N 条、每页条数、上/下一页、页码、跳转框。 */
  function renderPager(total) {
    const box = $("[data-pager]");
    if (!box) return;
    box.textContent = "";

    // 一页就装得下且用的是默认页长时不显示，避免白占一行
    if (total <= state.pageSize && state.pageSize === DEFAULT_PAGE_SIZE) {
      box.hidden = true;
      return;
    }
    box.hidden = false;

    const pages = totalPages(total);
    const goto = (p) => {
      state.page = Math.min(Math.max(1, p), pages);
      renderFeed();
      $("#feed").scrollIntoView({ behavior: "smooth", block: "start" });
    };

    const info = document.createElement("span");
    info.className = "pager-info";
    info.textContent = `共 ${total} 条`;
    box.appendChild(info);

    const sizeSel = document.createElement("select");
    sizeSel.className = "pager-size";
    sizeSel.setAttribute("aria-label", "每页显示条数");
    PAGE_SIZES.forEach((n) => {
      const o = document.createElement("option");
      o.value = String(n);
      o.textContent = `${n} 条/页`;
      if (n === state.pageSize) o.selected = true;
      sizeSel.appendChild(o);
    });
    sizeSel.addEventListener("change", () => {
      state.pageSize = Number(sizeSel.value) || DEFAULT_PAGE_SIZE;
      state.page = 1;
      renderFeed();
    });
    box.appendChild(sizeSel);
    const prev = document.createElement("button");
    prev.type = "button";
    prev.className = "pager-btn";
    prev.textContent = "‹";
    prev.setAttribute("aria-label", "上一页");
    prev.disabled = state.page <= 1;
    prev.addEventListener("click", () => goto(state.page - 1));
    box.appendChild(prev);

    pageNumbers(state.page, pages).forEach((n) => {
      if (n === "gap") {
        const g = document.createElement("span");
        g.className = "pager-gap";
        g.textContent = "…";
        box.appendChild(g);
        return;
      }
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pager-btn";
      b.textContent = String(n);
      if (n === state.page) {
        b.classList.add("current");
        b.setAttribute("aria-current", "page");
      }
      b.addEventListener("click", () => goto(n));
      box.appendChild(b);
    });

    const next = document.createElement("button");
    next.type = "button";
    next.className = "pager-btn";
    next.textContent = "›";
    next.setAttribute("aria-label", "下一页");
    next.disabled = state.page >= pages;
    next.addEventListener("click", () => goto(state.page + 1));
    box.appendChild(next);

    // 页数多时才给跳转框，少的时候直接点页码更快
    if (pages > 3) {
      const label = document.createElement("label");
      label.className = "pager-jump";
      label.appendChild(document.createTextNode("前往"));
      const inp = document.createElement("input");
      inp.type = "number";
      inp.min = "1";
      inp.max = String(pages);
      inp.value = String(state.page);
      inp.setAttribute("aria-label", `跳转页码，共 ${pages} 页`);
      const jump = () => {
        const v = Number(inp.value);
        if (Number.isFinite(v) && v >= 1) goto(v);
      };
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          jump();
        }
      });
      inp.addEventListener("change", jump);
      label.appendChild(inp);
      label.appendChild(document.createTextNode("页"));
      box.appendChild(label);
    }
  }

  // 由 bindScrollDock() 赋值，用于内容变化后重算悬浮按钮显隐
  let refreshScrollDock = () => {};

  /* ---------- 热门排行 ---------- */

  /** 排行榜周期切换按钮。 */
  function renderStatsTabs() {
    const bar = $("[data-stats-tabs]");
    if (!bar) return;
    bar.textContent = "";
    PERIODS.forEach((p) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "stats-tab";
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", String(state.statsPeriod === p.id));
      btn.textContent = p.label;
      btn.addEventListener("click", () => {
        state.statsPeriod = p.id;
        // 必须重画标签栏，否则高亮还留在原来那个周期上 ——
        // 榜单数据其实换了，但看起来像是点了没反应。
        renderStatsTabs();
        renderStats();
      });
      bar.appendChild(btn);
    });
  }

  /** 排行榜正文：Top 10 + 访问人数。点条目直接跳到对应卡片。 */
  function renderStats() {
    const scope = $("[data-stats-scope]");
    if (scope) {
      scope.textContent =
        stats.mode === "site"
          ? "全站统计 · 所有访客点击汇总"
          : "本机统计 · 只记录你在这台设备上的点击";
    }

    const box = $("[data-stats-rank]");
    if (!box) return;
    box.textContent = "";

    const table = stats.table(state.statsPeriod);
    const pool = allowedItems(); // 未成年模式下不能从排行榜漏出成人向条目
    const ranked = pool
      .map((it) => ({ item: it, n: table[it.id] || 0 }))
      .filter((r) => r.n > 0)
      .sort((a, b) => b.n - a.n || a.item.name.localeCompare(b.item.name, "zh-CN"))
      .slice(0, RANK_LIMIT);

    $("[data-stats-empty]").hidden = ranked.length > 0;
    if (!ranked.length) {
      // 带上周期名，否则切到空周期时看不出是「这个周期没数据」还是「坏了」
      const label = (PERIODS.find((p) => p.id === state.statsPeriod) || {}).label || "";
      $("[data-stats-empty]").textContent = `${label}还没有点击记录。`;
    }

    const top = ranked.length ? ranked[0].n : 0;
    ranked.forEach((r, i) => {
      const li = document.createElement("li");
      li.className = "rank-row";

      const no = document.createElement("span");
      no.className = "rank-no";
      if (i < 3) no.classList.add("top" + (i + 1));
      no.textContent = String(i + 1);
      li.appendChild(no);

      const name = document.createElement("button");
      name.type = "button";
      name.className = "rank-name";
      name.textContent = r.item.name;
      name.title = "在列表中定位这个资源";
      name.addEventListener("click", () => jumpToItem(r.item));
      li.appendChild(name);

      const bar = document.createElement("span");
      bar.className = "rank-bar";
      const fill = document.createElement("span");
      fill.className = "rank-fill";
      fill.style.width = top ? Math.max(4, Math.round((r.n / top) * 100)) + "%" : "0";
      bar.appendChild(fill);
      li.appendChild(bar);

      const cnt = document.createElement("span");
      cnt.className = "rank-count";
      cnt.textContent = r.n + " 次";
      li.appendChild(cnt);

      box.appendChild(li);
    });

    const vis = $("[data-stats-visitors]");
    if (vis) {
      if (stats.mode === "site" && stats.visitors) {
        const v = stats.visitors;
        // 当前周期的数字单独拎出来放前面，五个周期的全量跟在后面做对照
        const cur = (PERIODS.find((p) => p.id === state.statsPeriod) || {}).label || "";
        const curN = v[state.statsPeriod];
        vis.textContent =
          `${cur}访问人数 ${curN ?? "—"} 人　|　` +
          `今日 ${v.day ?? "—"} · 本周 ${v.week ?? "—"} · 本月 ${v.month ?? "—"} · ` +
          `本年 ${v.year ?? "—"} · 累计 ${v.all ?? "—"}`;
        // 桶名由后端按 UTC 算，UTC+8 这边的「今日」实际从早上 8 点开始。
        // 不写清楚的话，早上看到「今日 0 人」会以为统计坏了。
        const b = stats.buckets;
        vis.title = b && b.day
          ? `按 UTC 日期统计，当前统计日为 ${b.day}（UTC+8 地区相当于每天早上 8 点换日）`
          : "按 UTC 日期统计（UTC+8 地区相当于每天早上 8 点换日）";
      } else {
        vis.textContent = "访问人数需要后端支持，当前未启用（见 worker/README.md）。";
        vis.removeAttribute("title");
      }
    }
  }

  /** 从排行榜定位到某个资源：切到它所在分区，清搜索，翻到它所在页并展开。 */
  function jumpToItem(item) {
    state.section = item.section;
    state.sub = "all";
    state.q = "";
    const input = $('[data-filter="q"]');
    if (input) input.value = "";
    state.page = 1;

    const list = visibleItems();
    const idx = list.findIndex((it) => it.id === item.id);
    if (idx >= 0) state.page = Math.floor(idx / state.pageSize) + 1;
    render();

    const card = $$("[data-feed] .feed-card").find(
      (el) => el.dataset.itemId === item.id
    );
    if (card) {
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      card.classList.add("flash");
      setTimeout(() => card.classList.remove("flash"), 1200);
      if (card.getAttribute("aria-expanded") !== "true") card.click();
    } else {
      $("#feed").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  /* ---------- 资源帮找 ---------- */

  const WANTED_TABS = [
    { id: "open", label: "待找" },
    { id: "found", label: "已找到" },
    { id: "closed", label: "已关闭" },
  ];

  const WANTED_STATUS_LABEL = { open: "待找", found: "已找到", closed: "已关闭" };

  /** 失效反馈的状态标签。同一张表，但用户视角不同：待找→待补档。 */
  const BROKEN_STATUS_LABEL = { open: "待补档", found: "已补上", closed: "已关闭" };

  /** 帮找依赖后端。没有可用接口时整块隐藏 —— 显示一个提交后没反应的表单更糟。 */
  const wantedApi = () => (stats.mode === "site" ? stats.api : "");

  /* ---------- 后台编辑：覆盖层 ---------- */

  /** 后端地址。覆盖层与统计走同一个 Worker，但覆盖层在 stats.pull() 之前就要用，
   *  那时 stats.api 还没定，所以直接取配置里的第一个候选。 */
  function apiBase() {
    if (stats.api) return stats.api;
    const cfg = window.MO_CONFIG || {};
    const list = Array.isArray(cfg.statsApi) ? cfg.statsApi : cfg.statsApi ? [cfg.statsApi] : [];
    return list[0] || "";
  }

  /** 拉覆盖层。拿不到就返回空对象 —— 顶多显示原值，别让整页加载失败。 */
  async function loadOverrides() {
    const api = apiBase();
    if (!api) return {};
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      let res;
      try {
        // no-store：改完要立刻能看到，不能吃缓存
        res = await fetch(`${api}/api/overrides`, { cache: "no-store", signal: ctrl.signal });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      return data && data.overrides && typeof data.overrides === "object" ? data.overrides : {};
    } catch {
      return {};
    }
  }

  /** 拉后台新增的条目。和覆盖层一样：拿不到就当没有，别让整页加载失败。 */
  async function loadCustomItems() {
    const api = apiBase();
    if (!api) return [];
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      let res;
      try {
        res = await fetch(`${api}/api/items`, { cache: "no-store", signal: ctrl.signal });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      return Array.isArray(data && data.items) ? data.items : [];
    } catch {
      return [];
    }
  }

  /** items.json 的原始条目 + 后台新增的，合起来才是完整数据源。 */
  const allRaw = () => state.rawItems.concat(state.customItems);

  /** D1 覆盖层里的 deleted=true 会隐藏静态卡片；后台新增卡仍走真正删除。 */
  const rebuildItems = () => {
    state.items = allRaw()
      .filter((r) => !(overrides[r && r.id] && overrides[r.id].deleted === true))
      .map((r, i) => normalize(r, i, overrides[r && r.id]));
  };

  /** 覆盖层或新增条目变了之后重建 state.items 并重渲染。 */
  async function refreshOverrides({ withItems = false } = {}) {
    const [ov, custom] = await Promise.all([
      loadOverrides(),
      withItems ? loadCustomItems() : Promise.resolve(null),
    ]);
    overrides = ov;
    if (custom) state.customItems = custom;
    rebuildItems();
    render();
    refreshScrollDock();
  }

  /* ---------- 后台登录与卡片内编辑 ---------- */

  /** 带 token 发请求。401 说明会话没了，就地清掉登录态并重渲染。 */
  async function adminFetch(path, body) {
    const api = apiBase();
    if (!api) return { ok: false, error: "后端不可用" };
    try {
      const res = await fetch(api + path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(adminToken ? { Authorization: "Bearer " + adminToken } : {}),
        },
        body: JSON.stringify(body || {}),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 && adminToken) {
        adminToken = "";
        renderAdmin();
        render();
        // 帮找那块的运维入口同样只在登录态下存在，会话失效后也得撤掉 ——
        // 否则按钮还留在页面上，点了只会一直报「登录已过期」。
        if (state.wantedLoaded) renderWanted();
        return { ok: false, error: "登录已过期，请重新登录" };
      }
      return res.ok ? { ok: true, data } : { ok: false, error: data.error || "操作失败" };
    } catch {
      return { ok: false, error: "网络不通" };
    }
  }

  function renderAdmin() {
    const panel = $("[data-admin-panel]");
    if (!panel) return;
    // 只有地址带 #admin 才露出来。这不是安全措施（真正的门是密码），
    // 只是不想在页面上给访客一个后台入口。
    const wanted = location.hash === "#admin";
    panel.hidden = !wanted;
    if (!wanted) return;

    const logged = !!adminToken;
    const form = $("[data-admin-login]");
    const input = $("[data-admin-input]");
    const submit = $("[data-admin-submit]");
    const logout = $("[data-admin-logout]");
    const sub = $("[data-admin-sub]");

    if (input) input.hidden = logged;
    if (submit) submit.hidden = logged;
    if (logout) logout.hidden = !logged;
    if (form) form.querySelector('label[for="admin-pw"]').hidden = logged;
    if (sub) {
      sub.textContent = logged
        ? "已登录。展开任意卡片，点里面的「编辑这条」即可修改；改动立刻对所有访客生效。"
        : "登录后可以直接在卡片上改标题、简介、链接和提取码。";
    }

    // 新增资源那块只在登录后显示。退出时顺手收起表单，
    // 否则下次登录会看到上次填了一半的内容。
    const newWrap = $("[data-admin-new]");
    if (newWrap) {
      newWrap.hidden = !logged;
      if (!logged) {
        const box = $("[data-admin-new-form]");
        const toggle = $("[data-admin-new-toggle]");
        if (box) { box.hidden = true; box.textContent = ""; }
        if (toggle) toggle.textContent = "+ 新增一条资源";
      }
    }

    // 静态卡片软删除后可在后台恢复。退出时整个恢复区隐藏。
    const deletedWrap = $("[data-admin-deleted]");
    if (deletedWrap) {
      deletedWrap.hidden = !logged;
      if (!logged) {
        const list = $("[data-admin-deleted-list]");
        if (list) list.hidden = true;
      } else {
        renderDeletedAdmin();
      }
    }

    // 翻译工作区同理。退出时收起并清空 —— 里面可能留着上次的文件与队列，
    // 下次登录看到半截状态会以为出了问题。
    const txWrap = $("[data-tx]");
    if (txWrap) {
      txWrap.hidden = !logged;
      if (!logged) {
        const body = $("[data-tx-body]");
        const toggle = $("[data-tx-toggle]");
        const msg = $("[data-tx-msg]");
        // 先通知正在跑的 worker 停在当前块之后；清空数组让它拿不到下一块。
        tx.stopping = true;
        tx.chunks = [];
        tx.fileName = "";
        tx.fileType = "txt";
        tx.epub = null;
        if (body) { body.hidden = true; body.textContent = ""; }
        if (toggle) toggle.textContent = "⇄ 翻译工作区";
        if (msg) { msg.textContent = ""; msg.className = "admin-new-msg"; }
      }
    }
  }

  function bindAdmin() {
    const form = $("[data-admin-login]");
    if (!form) return;
    const input = $("[data-admin-input]");
    const submit = $("[data-admin-submit]");
    const msg = $("[data-admin-msg]");
    const say = (t, kind = "") => {
      if (msg) {
        msg.textContent = t;
        msg.className = "admin-msg" + (kind ? " " + kind : "");
      }
    };

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const pw = (input.value || "").trim();
      if (!pw) return say("请输入密码", "bad");
      submit.disabled = true;
      say("登录中…");
      const r = await adminFetch("/api/admin/login", { password: pw });
      submit.disabled = false;
      input.value = ""; // 无论成败都清掉，别把密码留在 DOM 里
      if (!r.ok) return say(r.error, "bad");
      adminToken = r.data.token;
      say("登录成功，展开卡片即可编辑", "ok");
      renderAdmin();
      render(); // 重渲染让卡片长出编辑按钮
      // 帮找那块的运维按钮也只在登录后显示，一并刷新
      if (state.wantedLoaded) renderWanted();
    });

    const logout = $("[data-admin-logout]");
    if (logout) {
      logout.addEventListener("click", async () => {
        await adminFetch("/api/admin/logout", {});
        adminToken = "";
        say("已退出", "ok");
        renderAdmin();
        render();
        if (state.wantedLoaded) renderWanted();
      });
    }

    // 支持直接改 hash 进出后台，不用刷新
    window.addEventListener("hashchange", renderAdmin);
    bindAdminNew();
    bindDeletedAdmin();
    bindTx();
  }

  /* ---------- 翻译工作区（仅站长登录后可见） ---------- */

  /**
   * 翻译原理就三步：切块 → 逐块调 API → 按原顺序拼回。
   * 界面上的进度条走的是「块」，不是字数。
   *
   * 请求由浏览器直发中转站，不经过任何服务器 —— 所以只支持开了 CORS 的端点。
   * 实测：motomoto.lol / api.yjs.im / ai.kscsnkli.site 三个放行了 `*`，
   * 而 OpenAI、Gemini 官方端点以及 tabitoken/kktoken 等都没有 CORS 头，
   * 浏览器直连会被拦（那类必须走服务端转发，这里不做）。
   */
  const TX_ENDPOINTS = [
    { id: "https://motomoto.lol/v1/chat/completions", label: "motomoto.lol" },
    { id: "https://api.yjs.im/v1/chat/completions", label: "api.yjs.im" },
    { id: "https://ai.kscsnkli.site/v1/chat/completions", label: "ai.kscsnkli.site" },
  ];

  // 设置存本机，key 不上传。键名带 v1 便于以后改结构时作废旧值。
  const TX_CFG_KEY = "mo-tx-cfg-v1";

  /** 切块长度。1300 字是本地工具 split_text 用了很久的值：
   *  再大容易触发上下文/超时，再小则请求次数暴增、更慢也更贵。 */
  const TX_CHUNK = 1300;

  /** 并发数上限。中转站对并发很敏感，开高了触发 429 反而更慢。 */
  const TX_CONCURRENCY_MAX = 4;

  const TX_PROMPT_DEFAULT =
    "你是专业的文学翻译。把用户给出的文本翻译成简体中文，" +
    "保持原有的分段与换行，不要添加解释、注释或任何额外内容，只输出译文。";

  /** 运行时状态。不进 state：这块只有站长用，跟资源列表的渲染无关。 */
  const tx = {
    chunks: [],      // [{ i, src, out, status, error, kind?, refs? }]
    fileName: "",
    fileType: "txt", // txt | epub
    epub: null,       // { entries, docs }，只在 EPUB 任务里有
    running: false,
    stopping: false,
  };

  function txLoadCfg() {
    const d = {
      endpoint: TX_ENDPOINTS[0].id,
      key: "",
      model: "gpt-4o-mini",
      concurrency: 2,
      prompt: TX_PROMPT_DEFAULT,
    };
    try {
      const raw = JSON.parse(localStorage.getItem(TX_CFG_KEY) || "{}");
      return { ...d, ...(raw && typeof raw === "object" ? raw : {}) };
    } catch {
      return d;
    }
  }

  function txSaveCfg(cfg) {
    try {
      localStorage.setItem(TX_CFG_KEY, JSON.stringify(cfg));
    } catch {
      /* 隐私模式下存不下，本次仍可用，只是下次要重填 */
    }
  }

  /**
   * 按段落切块。照搬本地工具 split_text 的规则：先按空行分段，
   * 再累加到长度上限 —— 切在段落边界，不会把句子截断。
   */
  /**
   * 段落特别长、没有空行时，原 split_text 会整段超过 1300 字。
   * 尽量在句号/问号/换行/空格处切；实在找不到才硬切。
   */
  function txSplitLong(text, maxLen = TX_CHUNK) {
    const out = [];
    let rest = String(text || "");
    while (rest.length > maxLen) {
      const head = rest.slice(0, maxLen + 1);
      let cut = -1;
      // 至少走到四成以后才找边界，避免切出大量几十字的小块
      const floor = Math.floor(maxLen * 0.4);
      for (let i = Math.min(maxLen, head.length - 1); i >= floor; i--) {
        if (/[。！？!?；;\.\n\s]/.test(head[i])) {
          cut = i + 1;
          break;
        }
      }
      if (cut < 1) cut = maxLen;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    if (rest) out.push(rest);
    return out;
  }

  function txSplit(text, maxLen = TX_CHUNK) {
    const t = String(text || "").trim();
    if (!t) return [];
    // 保留分隔符，拼回去时段间空行不丢
    const parts = t.split(/(\n\s*\n)/);
    const out = [];
    let cur = "";
    parts.forEach((p) => {
      if (cur.length + p.length > maxLen && cur.trim()) {
        // 单个段落也可能超过上限；再按句末/空格切，避免一块几千字。
        txSplitLong(cur.trim(), maxLen).forEach((x) => out.push(x));
        cur = p;
      } else {
        cur += p;
      }
    });
    if (cur.trim()) txSplitLong(cur.trim(), maxLen).forEach((x) => out.push(x));
    return out;
  }

  /* ---------- EPUB 解析 / 回填 / 打包 ---------- */

  const TX_EPUB_DOC_RE = /\.(xhtml?|html?)$/i;
  const TX_EPUB_SKIP_TAGS = new Set([
    "script", "style", "noscript", "svg", "math", "code", "pre",
    "textarea", "select", "option", "title",
  ]);
  // 导航、页码、纯符号、URL、文件名不值得送去翻译。
  const TX_EPUB_SKIP_CLASS = /(^|\s)(notranslate|pagebreak|page-break|pagenum|page-num)(\s|$)/i;

  /** 这些节点一般是书名、标题与正文。只抓可见文本，不碰属性、CSS、图片或脚本。 */
  function txEpubTextNodes(doc) {
    const root = doc.body || doc.documentElement;
    if (!root) return [];
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const out = [];
    let node;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!parent) continue;
      const tag = parent.localName && parent.localName.toLowerCase();
      if (!tag || TX_EPUB_SKIP_TAGS.has(tag)) continue;
      if (parent.closest("script,style,noscript,svg,math,code,pre,textarea,select")) continue;
      if (TX_EPUB_SKIP_CLASS.test(parent.className || "")) continue;
      if (parent.hasAttribute("data-notranslate") || parent.getAttribute("translate") === "no") continue;
      const raw = node.nodeValue || "";
      const text = raw.trim();
      if (!text) continue;
      if (/^(https?:\/\/|mailto:|#|\d+[\s./-]*$)/i.test(text)) continue;
      if (!/[\p{L}\p{N}]/u.test(text)) continue;
      out.push({ node, raw, text });
    }
    return out;
  }

  /**
   * 一个 EPUB 文档中的文本节点要合并成 API 块，但不能丢节点边界。
   * 用罕见的私用区标记 `MO_TX_n`；模型按提示原样保留它，
   * 翻完按标记拆开再分别写回原节点。若模型破坏了标记，该块会报错而不写坏书。
   */
  function txEpubBuildChunks(refs, docPath, startIndex) {
    const chunks = [];
    let group = [];
    let size = 0;
    const flush = () => {
      if (!group.length) return;
      const marks = group.map((r, i) => `MO_TX_${i}`);
      const src = group.map((r, i) => marks[i] + r.text).join("\n");
      chunks.push({
        i: startIndex + chunks.length,
        src,
        out: "",
        status: "pending",
        error: "",
        kind: "epub",
        docPath,
        refs: group.slice(),
        marks,
      });
      group = [];
      size = 0;
    };
    refs.forEach((r) => {
      // 节点自己超长也不切成多个 ref：切开再回填同一节点会把标记逻辑复杂化。
      // 这种极少见的节点单独成块即可。
      const add = r.text.length + 18;
      if (group.length && size + add > TX_CHUNK) flush();
      group.push(r);
      size += add;
    });
    flush();
    return chunks;
  }

  /** 解析 EPUB，保持原始 zip entries。只有 XHTML/HTML 文档会被解析。 */
  async function txLoadEpub(file) {
    if (!window.JSZip) throw new Error("EPUB 组件 JSZip 没加载，请强制刷新页面");
    const buf = await file.arrayBuffer();
    const zip = await window.JSZip.loadAsync(buf);

    // EPUB 规范要求 mimetype 存在；缺了通常不是合法 EPUB，导出也难保证阅读器接受。
    const mime = zip.file("mimetype");
    if (!mime) throw new Error("不是有效 EPUB：缺少 mimetype");
    const mimeText = (await mime.async("string")).trim();
    if (mimeText !== "application/epub+zip") {
      throw new Error("不是有效 EPUB：mimetype 不正确");
    }

    const parser = new DOMParser();
    const docs = [];
    const chunks = [];
    let index = 0;
    const names = Object.keys(zip.files)
      .filter((name) => !zip.files[name].dir && TX_EPUB_DOC_RE.test(name));

    for (const path of names) {
      const source = await zip.file(path).async("string");
      const doc = parser.parseFromString(source, "application/xhtml+xml");
      // 有些 EPUB 的 HTML 不严格符合 XML；退回 text/html 解析。
      const xmlBad = doc.querySelector("parsererror");
      const parsed = xmlBad ? parser.parseFromString(source, "text/html") : doc;
      const refs = txEpubTextNodes(parsed);
      if (!refs.length) continue;
      const made = txEpubBuildChunks(refs, path, index);
      chunks.push(...made);
      index += made.length;
      docs.push({ path, doc: parsed, source, xml: !xmlBad });
    }
    if (!chunks.length) throw new Error("EPUB 里没有找到可翻译的正文文本");
    return { zip, docs, chunks, bytes: buf.byteLength };
  }

  /** 将已经完成的块写回 DOM，并重新生成 EPUB。 */
  async function txExportEpub(say) {
    if (!tx.epub || !tx.chunks.length) return say("没有 EPUB 内容", "bad");
    const missing = tx.chunks.filter((c) => c.status !== "done");
    if (missing.length) {
      return say(`还有 ${missing.length} 块未完成；EPUB 不会用原文混合导出，请先补完`, "bad");
    }

    // 先验证并解析所有块，再开始写节点，避免写到一半才发现后面一块坏了。
    // 同时保证每个块只应用一次：如果导出过程中生成 zip 失败，再点导出不会把
    // 已翻过的节点首尾空白重复叠加。
    const parsed = [];
    for (const c of tx.chunks) {
      const marks = c.marks || [];
      const text = String(c.out || "");
      const positions = marks.map((m) => text.indexOf(m));
      if (positions.some((p) => p < 0)) {
        c.status = "error";
        c.error = "译文破坏了 EPUB 节点标记，请重试这一块";
        return say(`第 ${c.i + 1} 块节点标记损坏，已标为失败`, "bad");
      }
      for (let i = 1; i < positions.length; i++) {
        if (positions[i] <= positions[i - 1]) {
          c.status = "error";
          c.error = "译文改变了 EPUB 节点标记顺序，请重试这一块";
          return say(`第 ${c.i + 1} 块节点标记顺序错误，已标为失败`, "bad");
        }
      }
      const values = [];
      for (let i = 0; i < marks.length; i++) {
        const from = positions[i] + marks[i].length;
        const to = i + 1 < marks.length ? positions[i + 1] : text.length;
        const value = text.slice(from, to).replace(/^\s+|\s+$/g, "");
        if (!value) {
          c.status = "error";
          c.error = `第 ${i + 1} 个文本节点译文为空`;
          return say(`第 ${c.i + 1} 块：${c.error}`, "bad");
        }
        values.push(value);
      }
      parsed.push({ c, values });
    }

    parsed.forEach(({ c, values }) => {
      values.forEach((translated, i) => {
        const ref = c.refs[i];
        const lead = (ref.raw.match(/^\s*/) || [""])[0];
        const trail = (ref.raw.match(/\s*$/) || [""])[0];
        ref.node.nodeValue = lead + translated + trail;
      });
    });

    const serializer = new XMLSerializer();
    tx.epub.docs.forEach((d) => {
      let output;
      if (d.xml) {
        output = serializer.serializeToString(d.doc);
        if (!/^<\?xml/i.test(output) && /^<\?xml/i.test(d.source)) {
          const decl = (d.source.match(/^<\?xml[^>]*>\s*/i) || [""])[0];
          output = decl + output;
        }
      } else {
        output = "<!doctype html>\n" + d.doc.documentElement.outerHTML;
      }
      tx.epub.zip.file(d.path, output);
    });

    // EPUB 要求 mimetype 为第一个且不压缩。JSZip 重建时显式覆盖它，其他 entry
    // 保持原压缩方式由 JSZip 处理；图片、CSS、字体、OPF、NCX 都原样留在 zip 里。
    tx.epub.zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
    const blob = await tx.epub.zip.generateAsync({
      type: "blob",
      mimeType: "application/epub+zip",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });
    const name = (tx.fileName || "translated.epub").replace(/\.epub$/i, "") + ".zh.epub";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
    say(`已导出 ${name}（图片、CSS、目录与元数据保留）`, "ok");
  }

  /** 调一次翻译。错误信息要能看出是哪一类问题，否则用户只能干瞪眼。 */
  async function txCallOnce(cfg, text, kind = "txt") {
    let res;
    // EPUB 块用私用区标记保存文本节点边界。模型必须原样保留，
    // 否则没法把译文准确写回每个 <p>/<span> 文本节点。
    const epubRule = kind === "epub"
      ? "\n输入含有形如 MO_TX_0 的节点标记。必须逐字原样保留每个标记及其顺序，" +
        "只翻译标记后面的文字；不要增删、改写、合并标记。"
      : "";
    try {
      res = await fetch(cfg.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(cfg.key ? { Authorization: "Bearer " + cfg.key } : {}),
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: [
            { role: "system", content: (cfg.prompt || TX_PROMPT_DEFAULT) + epubRule },
            { role: "user", content: text },
          ],
          temperature: 0,
        }),
      });
    } catch (e) {
      // fetch 直接抛多半是 CORS 被拦或网络不通，两者浏览器都不给细节
      throw new Error("请求发不出去（该端点可能不允许浏览器直连，或网络不通）");
    }

    const raw = await res.text();
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      /* 非 JSON，下面按状态码报 */
    }

    if (!res.ok) {
      const msg = (data && data.error && (data.error.message || data.error.code)) || raw.slice(0, 160);
      if (res.status === 401) throw new Error("key 无效或已过期（401）");
      if (res.status === 404) throw new Error("端点或模型不存在（404）：" + msg);
      if (res.status === 429) throw new Error("被限流（429），降低并发或稍后重试");
      throw new Error(`HTTP ${res.status}：${msg}`);
    }

    const content = data && data.choices && data.choices[0]
      && data.choices[0].message && data.choices[0].message.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("返回里没有译文：" + JSON.stringify(data || raw).slice(0, 160));
    }
    return content.trim();
  }

  /** 跑队列。失败的块只标红不中断其他块 —— 中转站偶发 429/超时很常见，
   *  整任务作废会让人白等一场。 */
  async function txRun(render, say) {
    if (tx.running) return;
    const cfg = txLoadCfg();
    if (!cfg.key) return say("先填 API key", "bad");
    if (!cfg.model) return say("先填模型名", "bad");
    const todo = tx.chunks.filter((c) => c.status !== "done");
    if (!todo.length) return say("没有待翻译的块", "");

    tx.running = true;
    tx.stopping = false;
    render();

    const n = Math.max(1, Math.min(TX_CONCURRENCY_MAX, Number(cfg.concurrency) || 2));
    let cursor = 0;

    const worker = async () => {
      while (!tx.stopping) {
        const c = todo[cursor++];
        if (!c) return;
        c.status = "running";
        c.error = "";
        render();
        try {
          c.out = await txCallOnce(cfg, c.src, c.kind || tx.fileType);
          // EPUB 先检查节点标记。坏标记不等到导出才暴露，队列里直接标红可重试。
          if (c.kind === "epub") {
            const positions = (c.marks || []).map((m) => c.out.indexOf(m));
            if (positions.some((p) => p < 0)) {
              throw new Error("译文破坏了 EPUB 节点标记，请重试这一块");
            }
            for (let j = 1; j < positions.length; j++) {
              if (positions[j] <= positions[j - 1]) {
                throw new Error("译文改变了 EPUB 节点标记顺序，请重试这一块");
              }
            }
          }
          c.status = "done";
        } catch (e) {
          c.status = "error";
          c.error = e.message || String(e);
        }
        render();
      }
    };

    await Promise.all(Array.from({ length: n }, worker));

    tx.running = false;
    tx.stopping = false;
    const done = tx.chunks.filter((c) => c.status === "done").length;
    const bad = tx.chunks.filter((c) => c.status === "error").length;
    render();
    if (bad) say(`完成 ${done}/${tx.chunks.length}，${bad} 块失败，可重试失败项`, "bad");
    else say(`全部完成（${done} 块），可以导出了`, "ok");
  }

  /** 导出。TXT 可把失败块用原文占位；EPUB 必须全部成功，不能静默混入半本原文。 */
  async function txExport(say) {
    if (!tx.chunks.length) return say("还没有内容", "bad");
    if (tx.fileType === "epub") return txExportEpub(say);

    const missing = tx.chunks.filter((c) => c.status !== "done").length;
    const text = tx.chunks
      .map((c) => (c.status === "done" ? c.out : `【未翻译】\n${c.src}`))
      .join("\n\n");
    const name = (tx.fileName || "translated.txt").replace(/\.txt$/i, "") + ".zh.txt";

    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
    say(missing ? `已导出（${missing} 块未翻译，已用原文占位）` : "已导出", missing ? "bad" : "ok");
  }

  function buildTxBody(box, msg) {
    box.textContent = "";
    const cfg = txLoadCfg();
    const say = (t, kind = "") => {
      msg.textContent = t;
      msg.className = "admin-new-msg" + (kind ? " " + kind : "");
    };

    // 说明：第一次用的人得知道进度条在动什么
    const intro = document.createElement("p");
    intro.className = "tx-intro";
    intro.textContent =
      "原理：把文件按段落切成若干块 → 逐块调 API 翻译 → 按原顺序拼回导出。" +
      "进度按「块」算。API key 只存在这台设备的浏览器里，请求由浏览器直发，不经过任何服务器。";
    box.appendChild(intro);

    /* --- 设置 --- */
    const grid = document.createElement("div");
    grid.className = "tx-grid";

    const field = (label, el) => {
      const w = document.createElement("label");
      w.className = "admin-field";
      const s = document.createElement("span");
      s.textContent = label;
      w.appendChild(s);
      w.appendChild(el);
      grid.appendChild(w);
      return el;
    };

    const epSel = document.createElement("select");
    TX_ENDPOINTS.forEach((e) => {
      const o = document.createElement("option");
      o.value = e.id;
      o.textContent = e.label;
      epSel.appendChild(o);
    });
    const custom = document.createElement("option");
    custom.value = "__custom";
    custom.textContent = "自己填…";
    epSel.appendChild(custom);
    const known = TX_ENDPOINTS.some((e) => e.id === cfg.endpoint);
    epSel.value = known ? cfg.endpoint : "__custom";
    field("接口（只能用允许浏览器直连的）", epSel);

    const epInput = document.createElement("input");
    epInput.type = "text";
    epInput.placeholder = "https://……/v1/chat/completions";
    epInput.value = known ? "" : cfg.endpoint;
    const epRow = field("自定义接口地址", epInput);
    epRow.parentElement.hidden = known;

    const keyInput = document.createElement("input");
    keyInput.type = "password";      // 别让 key 明晃晃显示在屏幕上
    keyInput.autocomplete = "off";
    keyInput.value = cfg.key || "";
    field("API key（只存本机）", keyInput);

    const modelInput = document.createElement("input");
    modelInput.type = "text";
    modelInput.value = cfg.model || "";
    modelInput.placeholder = "如 gpt-4o-mini";
    field("模型名（各站支持的不一样，填错会 404）", modelInput);

    const concInput = document.createElement("input");
    concInput.type = "number";
    concInput.min = "1";
    concInput.max = String(TX_CONCURRENCY_MAX);
    concInput.value = String(cfg.concurrency || 2);
    field(`并发（1-${TX_CONCURRENCY_MAX}，高了容易被限流）`, concInput);

    const promptArea = document.createElement("textarea");
    promptArea.rows = 2;
    promptArea.value = cfg.prompt || TX_PROMPT_DEFAULT;
    field("翻译指令", promptArea);

    box.appendChild(grid);

    const readCfg = () => ({
      endpoint: epSel.value === "__custom" ? epInput.value.trim() : epSel.value,
      key: keyInput.value.trim(),
      model: modelInput.value.trim(),
      concurrency: Number(concInput.value) || 2,
      prompt: promptArea.value.trim() || TX_PROMPT_DEFAULT,
    });
    const persist = () => txSaveCfg(readCfg());

    epSel.addEventListener("change", () => {
      epRow.parentElement.hidden = epSel.value !== "__custom";
      persist();
    });
    [epInput, keyInput, modelInput, concInput, promptArea].forEach((el) =>
      el.addEventListener("change", persist)
    );

    /* --- 文件 --- */
    const fileRow = document.createElement("div");
    fileRow.className = "tx-actions";

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".txt,.epub,text/plain,application/epub+zip";
    fileRow.appendChild(fileInput);

    const fileHint = document.createElement("span");
    fileHint.className = "tx-file-hint";
    fileHint.textContent = "支持 TXT / EPUB；EPUB 会保留图片、CSS、目录与元数据，只翻译可见正文。";
    fileRow.appendChild(fileHint);
    box.appendChild(fileRow);

    /* --- 队列 --- */
    const list = document.createElement("ol");
    list.className = "tx-list";
    const actions = document.createElement("div");
    actions.className = "tx-actions";

    const btn = (label, cls = "") => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tx-btn" + (cls ? " " + cls : "");
      b.textContent = label;
      actions.appendChild(b);
      return b;
    };
    const runBtn = btn("开始翻译", "primary");
    const stopBtn = btn("停止");
    const retryBtn = btn("重试失败项");
    const expBtn = btn("导出译文");
    const clearBtn = btn("清空", "danger");

    box.appendChild(actions);
    box.appendChild(list);

    const render = () => {
      const done = tx.chunks.filter((c) => c.status === "done").length;
      const bad = tx.chunks.filter((c) => c.status === "error").length;

      runBtn.disabled = tx.running || !tx.chunks.length;
      stopBtn.disabled = !tx.running;
      retryBtn.disabled = tx.running || !bad;
      // TXT 可导出部分结果（未完成块用原文占位）；EPUB 为避免一本书里混着
      // 原文和译文，必须全部完成才开放导出。
      expBtn.disabled = tx.fileType === "epub"
        ? done !== tx.chunks.length || !done
        : !done;
      expBtn.textContent = tx.fileType === "epub" ? "导出 EPUB" : "导出译文";
      clearBtn.disabled = tx.running || !tx.chunks.length;
      runBtn.textContent = tx.running
        ? `翻译中… ${done}/${tx.chunks.length}`
        : done
          ? `继续翻译（剩 ${tx.chunks.length - done} 块）`
          : "开始翻译";

      list.textContent = "";
      tx.chunks.forEach((c) => {
        const li = document.createElement("li");
        li.className = "tx-item " + c.status;
        const head = document.createElement("div");
        head.className = "tx-item-head";
        const tag = document.createElement("span");
        tag.className = "tx-state";
        tag.textContent =
          { pending: "待翻译", running: "翻译中", done: "完成", error: "失败" }[c.status] || c.status;
        head.appendChild(tag);
        const size = document.createElement("span");
        size.className = "tx-size";
        size.textContent = c.kind === "epub"
          ? `第 ${c.i + 1} 块 · ${(c.refs || []).length} 个节点 · ${c.docPath}`
          : `第 ${c.i + 1} 块 · ${c.src.length} 字`;
        head.appendChild(size);
        li.appendChild(head);

        if (c.error) {
          const err = document.createElement("p");
          err.className = "tx-err";
          err.textContent = c.error;
          li.appendChild(err);
        }
        // 只给一小段预览，整本书的正文铺开会把页面撑爆
        const prev = document.createElement("p");
        prev.className = "tx-prev";
        prev.textContent = (c.status === "done" ? c.out : c.src).slice(0, 90);
        li.appendChild(prev);

        list.appendChild(li);
      });
    };

    fileInput.addEventListener("change", async () => {
      const f = fileInput.files && fileInput.files[0];
      if (!f) return;
      if (tx.running) return say("正在翻译，先停止再换文件", "bad");
      try {
        const isEpub = /\.epub$/i.test(f.name) || f.type === "application/epub+zip";
        tx.fileName = f.name;
        tx.stopping = false;

        if (isEpub) {
          say("正在解析 EPUB…");
          const book = await txLoadEpub(f);
          tx.fileType = "epub";
          tx.epub = book;
          tx.chunks = book.chunks;
          const nodes = tx.chunks.reduce((n, c) => n + (c.refs ? c.refs.length : 0), 0);
          say(
            `已载入《${f.name}》：${book.docs.length} 个文档、${nodes} 个文本节点，` +
              `切成 ${tx.chunks.length} 块（${(book.bytes / 1024 / 1024).toFixed(1)} MB）`,
            "ok"
          );
        } else {
          const text = await f.text();
          const parts = txSplit(text);
          if (!parts.length) return say("文件是空的", "bad");
          tx.fileType = "txt";
          tx.epub = null;
          tx.chunks = parts.map((src, i) => ({
            i, src, out: "", status: "pending", error: "", kind: "txt",
          }));
          say(`已载入《${f.name}》：${text.length} 字，切成 ${parts.length} 块`, "ok");
        }
        render();
      } catch (e) {
        tx.chunks = [];
        tx.epub = null;
        tx.fileName = "";
        say("读文件失败：" + (e.message || e), "bad");
        render();
      }
    });

    runBtn.addEventListener("click", () => {
      persist();
      txRun(render, say);
    });
    stopBtn.addEventListener("click", () => {
      tx.stopping = true;
      say("停止中…（正在跑的块会跑完）", "");
    });
    retryBtn.addEventListener("click", () => {
      tx.chunks.forEach((c) => {
        if (c.status === "error") {
          c.status = "pending";
          c.error = "";
        }
      });
      persist();
      txRun(render, say);
    });
    expBtn.addEventListener("click", async () => {
      expBtn.disabled = true;
      say(tx.fileType === "epub" ? "正在重新打包 EPUB…" : "正在导出…");
      try {
        await txExport(say);
      } catch (e) {
        say("导出失败：" + (e.message || e), "bad");
      } finally {
        render();
      }
    });
    clearBtn.addEventListener("click", () => {
      if (!window.confirm("清空当前文件与已翻译内容？未导出的译文会丢。")) return;
      tx.stopping = true;
      tx.chunks = [];
      tx.fileName = "";
      tx.fileType = "txt";
      tx.epub = null;       // EPUB 可能含大量图片，及时释放内存
      fileInput.value = "";
      say("已清空", "");
      render();
    });

    render();
  }

  function bindTx() {
    const toggle = $("[data-tx-toggle]");
    const body = $("[data-tx-body]");
    const msg = $("[data-tx-msg]");
    if (!toggle || !body || !msg) return;
    toggle.addEventListener("click", () => {
      const open = !body.hidden;
      body.hidden = open;
      toggle.textContent = open ? "⇄ 翻译工作区" : "收起";
      if (!open) buildTxBody(body, msg);
    });
  }

  /* ---------- 后台新增资源 ---------- */

  /** 新增表单的字段。与后端 createCustomItem 收的字段对应。 */
  const ADMIN_NEW_FIELDS = [
    { key: "name", label: "资源名", type: "text", required: true },
    { key: "placements", label: "所属位置（分区 + 小分区，可加多个）", type: "placements", required: true },
    { key: "description", label: "简介", type: "textarea" },
    { key: "url", label: "跳转链接", type: "text" },
    { key: "password", label: "提取码", type: "text" },
    { key: "tags", label: "标签（逗号分隔，最多 6 个）", type: "text" },
    { key: "kind", label: "资源类型（如 网盘资源）", type: "text" },
    { key: "note", label: "备注", type: "textarea" },
    { key: "adult", label: "成人向（未成年模式下隐藏）", type: "checkbox" },
  ];

  function buildAdminNewForm(box, msg) {
    box.textContent = "";
    const inputs = {};
    let picker = null;

    ADMIN_NEW_FIELDS.forEach((f) => {
      const row = document.createElement(f.type === "placements" ? "div" : "label");
      row.className = "admin-field";

      const name = document.createElement("span");
      name.textContent = f.label + (f.required ? " *" : "");
      row.appendChild(name);

      if (f.type === "placements") {
        // 默认落在小说区 —— 站里加得最多的是小说，省一次选择
        picker = buildPlacementPicker(row, [{ id: "novel", sub: "" }]);
      } else {
        let el;
        if (f.type === "checkbox") {
          el = document.createElement("input");
          el.type = "checkbox";
          row.classList.add("admin-field-inline");
        } else {
          el = document.createElement(f.type === "textarea" ? "textarea" : "input");
          if (f.type === "textarea") el.rows = 2;
          else el.type = "text";
        }
        row.appendChild(el);
        inputs[f.key] = el;
      }
      box.appendChild(row);
    });

    const actions = document.createElement("div");
    actions.className = "admin-actions";
    const submit = document.createElement("button");
    submit.type = "button";
    submit.className = "admin-save";
    submit.textContent = "添加";
    actions.appendChild(submit);
    box.appendChild(actions);

    const say = (t, kind = "") => {
      msg.textContent = t;
      msg.className = "admin-new-msg" + (kind ? " " + kind : "");
    };

    submit.addEventListener("click", async () => {
      const body = {};
      ADMIN_NEW_FIELDS.forEach((f) => {
        if (f.type === "placements") return;   // 分区单独读，见下
        body[f.key] = f.type === "checkbox" ? inputs[f.key].checked : inputs[f.key].value;
      });
      if (!String(body.name).trim()) return say("资源名不能为空", "bad");

      body.placements = picker ? picker.read() : "";
      if (!body.placements) return say("至少要选一个分区", "bad");

      submit.disabled = true;
      say("添加中…");
      const r = await adminFetch("/api/admin/item", body);
      submit.disabled = false;
      if (!r.ok) return say(r.error, "bad");

      const n = body.placements.split(",").length;
      say(n > 1 ? `已添加，挂在 ${n} 个分区下` : "已添加，所有访客立即可见", "ok");
      // 清空文本字段好接着加下一条，但保留分区选择 —— 连着加同类资源时省事
      ADMIN_NEW_FIELDS.forEach((f) => {
        if (f.type === "placements") return;
        if (f.type === "checkbox") inputs[f.key].checked = false;
        else inputs[f.key].value = "";
      });
      // 新增条目要重新拉 /api/items，withItems 才会带上它
      await refreshOverrides({ withItems: true });
    });
  }

  function bindAdminNew() {
    const toggle = $("[data-admin-new-toggle]");
    const box = $("[data-admin-new-form]");
    const msg = $("[data-admin-new-msg]");
    if (!toggle || !box || !msg) return;
    toggle.addEventListener("click", () => {
      const open = !box.hidden;
      box.hidden = open;
      toggle.textContent = open ? "+ 新增一条资源" : "收起";
      if (!open) buildAdminNewForm(box, msg);
    });
  }

  /** 渲染静态卡片的软删除记录；名称优先显示删除前已经保存的覆盖标题。 */
  function renderDeletedAdmin() {
    const wrap = $("[data-admin-deleted]");
    const toggle = $("[data-admin-deleted-toggle]");
    const list = $("[data-admin-deleted-list]");
    const msg = $("[data-admin-deleted-msg]");
    if (!wrap || !toggle || !list || !msg) return;

    const rawById = new Map(state.rawItems.map((r) => [String(r.id || ""), r]));
    const deleted = Object.entries(overrides)
      .filter(([id, ov]) => ov && ov.deleted === true && rawById.has(id))
      .map(([id, ov]) => ({ id, name: ov.name || rawById.get(id).name || id }));
    toggle.textContent = `已删除卡片（${deleted.length}）`;
    list.textContent = "";

    if (!deleted.length) {
      const empty = document.createElement("p");
      empty.className = "admin-deleted-empty";
      empty.textContent = "暂无已删除的静态卡片";
      list.appendChild(empty);
      return;
    }

    deleted.forEach((item) => {
      const row = document.createElement("div");
      row.className = "admin-deleted-row";
      const label = document.createElement("span");
      label.textContent = `${item.name}（${item.id}）`;
      row.appendChild(label);

      const restore = document.createElement("button");
      restore.type = "button";
      restore.className = "admin-restore";
      restore.textContent = "恢复";
      restore.addEventListener("click", async () => {
        restore.disabled = true;
        msg.textContent = "恢复中…";
        msg.className = "admin-new-msg";
        const r = await adminFetch("/api/admin/override", {
          item_id: item.id,
          fields: { deleted: null },
        });
        restore.disabled = false;
        if (!r.ok) {
          msg.textContent = r.error;
          msg.className = "admin-new-msg bad";
          return;
        }
        msg.textContent = `已恢复「${item.name}」`;
        msg.className = "admin-new-msg ok";
        await refreshOverrides();
        renderDeletedAdmin();
      });
      row.appendChild(restore);
      list.appendChild(row);
    });
  }

  function bindDeletedAdmin() {
    const toggle = $("[data-admin-deleted-toggle]");
    const list = $("[data-admin-deleted-list]");
    if (!toggle || !list) return;
    toggle.addEventListener("click", () => {
      list.hidden = !list.hidden;
      renderDeletedAdmin();
    });
  }

  function initAdmin() {
    bindAdmin();
    renderAdmin();
  }

  /** 卡片里的编辑表单。只在已登录时构建。
   *  分区归属用「分区 + 小分区」成对的下拉，可以加多行 —— 手打分区 id 极易拼错，
   *  而后端对未知分区会 400，用户得靠猜。 */
  const ADMIN_EDIT_FIELDS = [
    { key: "name", label: "标题", type: "text" },
    { key: "description", label: "简介", type: "textarea" },
    { key: "url", label: "跳转链接", type: "text" },
    { key: "password", label: "提取码", type: "text" },
    { key: "note", label: "备注", type: "textarea" },
    { key: "placements", label: "所属位置（分区 + 小分区，可加多个）", type: "placements" },
  ];

  /** 一条资源最多挂几个位置。与后端 PLACEMENT_MAX 保持一致。 */
  const PLACEMENT_MAX = 8;

  /** 可选分区列表（去掉「全部」这个伪分区）。 */
  const realSections = () => SECTIONS.filter((s) => s.id !== "all");

  /** 往 select 里填选项。空值那项表示「不指定小分区」。 */
  function fillOptions(sel, list, current, emptyLabel) {
    sel.textContent = "";
    if (emptyLabel !== undefined) {
      const o = document.createElement("option");
      o.value = "";
      o.textContent = emptyLabel;
      sel.appendChild(o);
    }
    list.forEach((it) => {
      const o = document.createElement("option");
      o.value = it.id;
      o.textContent = it.label;
      sel.appendChild(o);
    });
    sel.value = current || "";
  }

  /**
   * 多分区归属选择器。渲染成若干「分区 + 小分区 + 删除」行，末尾一个「+ 再加一个位置」。
   *
   * 返回 { read() } —— read 拼出后端要的 'novel:jp,novel:download,manga:kr' 串。
   * 不用 <select multiple>：那个只能选分区、带不上各自的小分区，而
   * 「小说/下载 + 小说/日轻」这种组合正是要表达的东西。
   *
   * 同一分区可以出现多次，只要小分区不同；完全相同的一对才算重复。
   *
   * @param initial [{id, sub}] 现有归属
   */
  function buildPlacementPicker(box, initial) {
    const rows = document.createElement("div");
    rows.className = "placement-rows";
    box.appendChild(rows);

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "placement-add";
    addBtn.textContent = "+ 再加一个位置";
    box.appendChild(addBtn);

    const hint = document.createElement("p");
    hint.className = "placement-hint";
    box.appendChild(hint);

    const state = [];   // [{ row, sec, sub }]

    const refresh = () => {
      // 第一行是主归属，卡片默认显示它的标签
      state.forEach((r, i) => {
        r.row.querySelector(".placement-index").textContent = i === 0 ? "主位置" : `位置 ${i + 1}`;
        // 只剩一行时不给删 —— 一条资源总得有个归属
        r.row.querySelector(".placement-del").hidden = state.length <= 1;
      });
      addBtn.hidden = state.length >= PLACEMENT_MAX;

      // 重复判定看完整的「分区:小分区」对。同区不同小分区是合法组合，
      // 不该报重复；同区一个留空一个具体则是冗余（留空已涵盖具体那个）。
      const seen = new Set();
      const withSub = new Set();
      const bare = new Set();
      let repeated = false;
      state.forEach((r) => {
        const sec = r.sec.value;
        const sub = r.sub.disabled ? "" : r.sub.value;
        const key = sub ? `${sec}:${sub}` : sec;
        if (seen.has(key)) repeated = true;
        seen.add(key);
        (sub ? withSub : bare).add(sec);
      });
      const redundant = [...bare].some((s) => withSub.has(s));

      if (repeated) {
        hint.textContent = "有完全相同的位置，保存时只会保留一个";
      } else if (redundant) {
        hint.textContent = "同一分区里既选了「不指定」又选了具体小分区，保存时会丢掉「不指定」那条";
      } else {
        hint.textContent =
          "同一个分区可以选多个小分区（如小说/下载 + 小说/日轻）。第一个位置决定卡片默认显示的标签。";
      }
      hint.className = "placement-hint" + (repeated || redundant ? " warn" : "");
    };

    const addRow = (secId, subId) => {
      if (state.length >= PLACEMENT_MAX) return;
      const row = document.createElement("div");
      row.className = "placement-row";

      const idx = document.createElement("span");
      idx.className = "placement-index";
      row.appendChild(idx);

      const sec = document.createElement("select");
      sec.className = "placement-sec";
      fillOptions(sec, realSections(), secId || "novel");
      row.appendChild(sec);

      const sub = document.createElement("select");
      sub.className = "placement-sub";
      row.appendChild(sub);

      const del = document.createElement("button");
      del.type = "button";
      del.className = "placement-del";
      del.textContent = "×";
      del.title = "移除这个位置";
      row.appendChild(del);

      // 小分区跟着分区联动。换分区时旧的小分区往往不存在（漫画的「公众号」
      // 放到小说下就是无效值），所以要重建选项。
      const syncSub = (keep) => {
        const subs = (SECTION_MAP.get(sec.value) || {}).subs || [];
        const cur = keep && subs.some((s) => s.id === keep) ? keep : "";
        fillOptions(sub, subs, cur, subs.length ? "（不指定）" : "（无小分区）");
        sub.disabled = subs.length === 0;
      };
      syncSub(subId);
      sec.addEventListener("change", () => {
        syncSub("");
        refresh();
      });
      // 小分区也要触发 refresh：重复判定看的是完整的「分区:小分区」对，
      // 只监听分区的话，改小分区后提示还是旧的（同区不同小分区已经合法了）。
      sub.addEventListener("change", refresh);

      del.addEventListener("click", (e) => {
        e.stopPropagation();
        const i = state.findIndex((r) => r.row === row);
        if (i >= 0) state.splice(i, 1);
        row.remove();
        refresh();
      });

      rows.appendChild(row);
      state.push({ row, sec, sub });
      refresh();
    };

    (initial && initial.length ? initial : [{ id: "novel", sub: "" }]).forEach((p) =>
      addRow(p.id, p.sub || "")
    );

    addBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      addRow("", "");
    });

    return {
      read() {
        // 去重键是完整的「分区:小分区」对 —— 同区不同小分区是合法组合。
        const seen = new Set();
        const picked = [];
        state.forEach((r) => {
          const sec = r.sec.value;
          if (!sec) return;
          const sub = r.sub.disabled ? "" : r.sub.value;
          const key = sub ? `${sec}:${sub}` : sec;
          if (seen.has(key)) return;
          seen.add(key);
          picked.push({ sec, sub, key });
        });

        // 同区既有「不指定」又有具体小分区时丢掉前者：它是后者的超集，
        // 两个都留会让这条资源在该区列表里出现两次。后端也做同样处理。
        const withSub = new Set(picked.filter((p) => p.sub).map((p) => p.sec));
        return picked
          .filter((p) => p.sub || !withSub.has(p.sec))
          .map((p) => p.key)
          .join(",");
      },
    };
  }

  function buildAdminEditor(item, wrap, box, msg) {
    box.textContent = "";
    const ov = overrides[item.id] || {};
    const inputs = {};
    let picker = null;

    ADMIN_EDIT_FIELDS.forEach((f) => {
      const row = document.createElement(f.type === "placements" ? "div" : "label");
      row.className = "admin-field";

      const name = document.createElement("span");
      name.textContent = f.label;
      // 标出这一项是不是被覆盖过，方便判断当前看到的是原值还是改过的值。
      // placements 与老形式的 section 都算「分区改过」。
      const changed =
        f.key in ov || (f.type === "placements" && ("section" in ov || "placements" in ov));
      if (changed) {
        const tag = document.createElement("em");
        tag.textContent = "已改";
        name.appendChild(tag);
      }
      row.appendChild(name);

      if (f.type === "placements") {
        // 当前归属直接取 normalize 后的 sections —— 它已经把覆盖层、
        // items.json 的 also_in 都算进去了，比在这里重新解析一遍可靠。
        picker = buildPlacementPicker(row, item.sections || []);
      } else {
        const el = document.createElement(f.type === "textarea" ? "textarea" : "input");
        if (f.type === "textarea") el.rows = 3;
        else el.type = "text";
        el.value = item[f.key] || "";
        row.appendChild(el);
        inputs[f.key] = el;
      }
      box.appendChild(row);
    });

    // 保存时用它和当前值比对，判断分区有没有被动过
    const placementsBefore = (item.sections || [])
      .map((s) => (s.sub ? `${s.id}:${s.sub}` : s.id))
      .join(",");

    const actions = document.createElement("div");
    actions.className = "admin-actions";

    const save = document.createElement("button");
    save.type = "button";
    save.className = "admin-save";
    save.textContent = "保存";
    actions.appendChild(save);

    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "admin-reset";
    reset.textContent = "撤销全部改动";
    reset.hidden = !Object.keys(ov).some((k) => k !== "updated");
    actions.appendChild(reset);
    box.appendChild(actions);

    const say = (t, kind = "") => {
      msg.textContent = t;
      msg.className = "card-admin-msg" + (kind ? " " + kind : "");
    };

    save.addEventListener("click", async (e) => {
      e.stopPropagation();
      // 只提交真正变了的字段。和当前显示值一样就不发 ——
      // 全量提交会把「没覆盖」的字段也写成覆盖，之后想回落原值都难。
      const fields = {};
      ADMIN_EDIT_FIELDS.forEach((f) => {
        if (f.type === "placements") return;   // 分区单独处理，见下
        const v = inputs[f.key].value;
        if (v !== (item[f.key] || "")) fields[f.key] = v;
      });

      // 分区归属：拼成 'novel:jp,manga:download' 与当前生效值比对。
      const placementsNow = picker ? picker.read() : "";
      if (!placementsNow) return say("至少要选一个分区", "bad");
      const moved = placementsNow !== placementsBefore;
      if (moved) {
        fields.placements = placementsNow;
        // 老形式的单值覆盖要显式撤销，否则库里两套并存，前端得猜听谁的。
        // 后端也会做这一步，这里一并传是为了语义明确。
        fields.section = null;
        fields.subsection = null;
      }

      if (!Object.keys(fields).length) return say("没有改动", "");
      save.disabled = true;
      say("保存中…");
      const r = await adminFetch("/api/admin/override", { item_id: item.id, fields });
      save.disabled = false;
      if (!r.ok) return say(r.error, "bad");
      // 重渲染会把这张卡换成新节点，所以提示得交给新卡片去显示
      const n = placementsNow.split(",").length;
      adminFlash = {
        id: item.id,
        text: moved
          ? n > 1
            ? `已保存，这条现在挂在 ${n} 个分区下`
            : "已保存，条目已移动到新分区"
          : "已保存，所有访客立即可见",
        kind: "ok",
      };
      await refreshOverrides();
      adminFlash = null;
    });

    reset.addEventListener("click", async (e) => {
      e.stopPropagation();
      reset.disabled = true;
      say("撤销中…");
      // 每一项都置 null，后端会把整行删掉，条目回到 items.json 的原值。
      // section/subsection 是老形式的分区覆盖，也得一起撤 —— 只撤 placements
      // 的话，早期存的单值覆盖还留在库里，条目回不到原始分区。
      const fields = { section: null, subsection: null };
      ADMIN_EDIT_FIELDS.forEach((f) => (fields[f.key] = null));
      const r = await adminFetch("/api/admin/override", { item_id: item.id, fields });
      reset.disabled = false;
      if (!r.ok) return say(r.error, "bad");
      adminFlash = { id: item.id, text: "已回到原始值", kind: "ok" };
      await refreshOverrides();
      adminFlash = null;
    });

    // 两类条目都能删：custom- 真删 D1 行；静态 items.json 条目写 deleted 覆盖软删除。
    const del = document.createElement("button");
    del.type = "button";
    del.className = "admin-delete";
    del.textContent = "删除这条";
    actions.appendChild(del);

    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      const isCustom = String(item.id).startsWith("custom-");
      const detail = isCustom
        ? "此操作不可撤销。"
        : "这会对所有访客隐藏该卡片，可在后台的「已删除卡片」中恢复。";
      if (!window.confirm(`确定删除「${item.name}」？${detail}`)) return;
      del.disabled = true;
      say("删除中…");
      const r = isCustom
        ? await adminFetch("/api/admin/item/delete", { id: item.id })
        : await adminFetch("/api/admin/override", { item_id: item.id, fields: { deleted: true } });
      del.disabled = false;
      if (!r.ok) return say(r.error, "bad");
      const panelMsg = $("[data-admin-new-msg]");
      if (panelMsg) {
        panelMsg.textContent = isCustom
          ? `已删除「${item.name}」`
          : `已隐藏「${item.name}」，可在「已删除卡片」中恢复`;
        panelMsg.className = "admin-new-msg ok";
      }
      await refreshOverrides({ withItems: isCustom });
      renderDeletedAdmin();
    });
  }

  /** 本机记下已反馈过的条目，避免同一个人反复点同一张卡。
   *  后端也按指纹去重，这里只是让按钮状态在刷新后仍然正确。 */
  const REPORTED_KEY = "mo-reported-v1";

  function loadReported() {
    try {
      const raw = JSON.parse(localStorage.getItem(REPORTED_KEY) || "[]");
      return new Set(Array.isArray(raw) ? raw : []);
    } catch {
      return new Set();
    }
  }

  function markReported(id) {
    try {
      const s = loadReported();
      s.add(id);
      // 只留最近 200 条，避免无限增长
      localStorage.setItem(REPORTED_KEY, JSON.stringify([...s].slice(-200)));
    } catch {
      /* 隐私模式下存不下，无所谓：后端仍会按指纹去重 */
    }
  }

  /** 报告某条资源失效。按钮就在那张卡上，所以 item_id 一定准确。 */
  async function reportBroken(item, btn, msg) {
    const api = wantedApi();
    if (!api) {
      msg.textContent = "反馈功能暂时不可用";
      msg.className = "card-report-msg bad";
      return;
    }
    if (btn.disabled) return;
    btn.disabled = true;
    msg.textContent = "提交中…";
    msg.className = "card-report-msg";
    try {
      const res = await fetch(`${api}/api/requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "broken",
          item_id: item.id,
          title: item.name,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        msg.textContent = data.error || "提交失败，稍后再试";
        msg.className = "card-report-msg bad";
        btn.disabled = false;
        return;
      }
      markReported(item.id);
      btn.textContent = "已反馈，会尽快补档";
      btn.classList.add("done");
      msg.textContent = data.merged ? "已有人反馈过，帮你加了一票" : "收到，感谢反馈";
      msg.className = "card-report-msg ok";
      // 失效反馈列表变了，顺手刷新面板
      if (state.wantedLoaded) {
        await loadWanted();
        renderWanted();
      }
    } catch {
      msg.textContent = "网络不通，稍后再试";
      msg.className = "card-report-msg bad";
      btn.disabled = false;
    }
  }

  const fmtWantedDate = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d)) return "";
    return d.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
  };

  /** 后端是否已认识 kind。分 kind 的 summary 形如 {want:{...},broken:{...}}，
   *  老后端返回的是扁平的 {open,found,closed} —— 用这个形状差别当探测信号，
   *  比另加一个版本号接口省事，也不用两边同时改。 */
  const summaryIsKindAware = (raw) =>
    !!raw && typeof raw === "object" &&
    ["want", "broken"].some((k) => raw[k] && typeof raw[k] === "object");

  /** 把 summary 归一成 {want:{open,found,closed}, broken:{...}}。
   *  老后端返回扁平形状时，库里只可能是想要资源的记录，所以整份计到 want 上，
   *  broken 归零 —— 前端先上线、后端后部署的窗口期里不会显示 undefined。 */
  function normalizeWantedSummary(raw) {
    const blank = () => ({ open: 0, found: 0, closed: 0 });
    const out = { want: blank(), broken: blank() };
    if (!raw || typeof raw !== "object") return out;

    const pick = (src, dst) => {
      if (!src || typeof src !== "object") return;
      ["open", "found", "closed"].forEach((s) => {
        const n = Number(src[s]);
        if (Number.isFinite(n) && n >= 0) dst[s] = n;
      });
    };

    if (summaryIsKindAware(raw)) {
      pick(raw.want, out.want);
      pick(raw.broken, out.broken);
    } else {
      pick(raw, out.want);
    }
    return out;
  }

  /** 拉取求助列表。失败时不清空已有数据，避免网络抖动把列表闪成空。 */
  async function loadWanted() {
    const api = wantedApi();
    if (!api) return false;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      let res;
      try {
        res = await fetch(`${api}/api/requests`, { cache: "no-store", signal: ctrl.signal });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      state.wantedItems = Array.isArray(data.items) ? data.items : [];
      state.brokenReady = summaryIsKindAware(data.summary);
      state.wantedSummary = normalizeWantedSummary(data.summary);
      state.wantedLoaded = true;
      // 后端还是老版时退回单一「想要资源」视图，别让用户停在一个点了会存脏数据的面板上
      if (!state.brokenReady && state.wantedKind === "broken") {
        state.wantedKind = "want";
        state.wantedStatus = "open";
      }
      return true;
    } catch {
      return false;
    }
  }

  /** 类型切换：想要资源 / 失效反馈。两类用同一张表，靠 kind 区分。 */
  const WANTED_KINDS = [
    { id: "want", label: "想要资源" },
    { id: "broken", label: "失效反馈" },
  ];

  const kindStatusLabel = (kind) =>
    kind === "broken" ? BROKEN_STATUS_LABEL : WANTED_STATUS_LABEL;

  function renderWantedKindTabs() {
    const bar = $("[data-wanted-kinds]");
    if (!bar) return;
    bar.textContent = "";
    // 后端不支持 kind 时只有一类，两个标签没有意义，整条隐藏
    bar.hidden = !state.brokenReady;
    if (!state.brokenReady) return;
    WANTED_KINDS.forEach((k) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "wanted-kind";
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", String(state.wantedKind === k.id));
      btn.textContent = k.label;

      const cnt = document.createElement("span");
      cnt.className = "tab-count";
      cnt.textContent = (state.wantedSummary[k.id] || {}).open ?? 0;
      btn.appendChild(cnt);

      btn.addEventListener("click", () => {
        state.wantedKind = k.id;
        state.wantedStatus = "open"; // 换类型回到待处理，否则可能停在空列表上
        renderWanted();
      });
      bar.appendChild(btn);
    });
  }

  function renderWantedTabs() {
    const bar = $("[data-wanted-tabs]");
    if (!bar) return;
    bar.textContent = "";
    const labels = kindStatusLabel(state.wantedKind);
    const counts = state.wantedSummary[state.wantedKind] || {};
    WANTED_TABS.forEach((t) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "wanted-tab";
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", String(state.wantedStatus === t.id));
      // 两类的状态叫法不同：想要资源是「待找/已找到」，失效反馈是「待补档/已补上」
      btn.textContent = labels[t.id] || t.label;

      const cnt = document.createElement("span");
      cnt.className = "tab-count";
      cnt.textContent = counts[t.id] ?? 0;
      btn.appendChild(cnt);

      btn.addEventListener("click", () => {
        state.wantedStatus = t.id;
        // 标签栏也要重画，否则高亮留在原处，看起来像点了没反应
        renderWantedTabs();
        renderWantedList();
      });
      bar.appendChild(btn);
    });
  }

  /** 全部文本走 textContent —— 这是用户提交的内容，绝不能当 HTML 解析。 */
  function renderWantedList() {
    const box = $("[data-wanted-list]");
    if (!box) return;
    box.textContent = "";

    const labels = kindStatusLabel(state.wantedKind);
    const list = state.wantedItems.filter(
      (x) => (x.kind || "want") === state.wantedKind && x.status === state.wantedStatus
    );
    const empty = $("[data-wanted-empty]");
    if (empty) {
      empty.hidden = list.length > 0;
      if (state.wantedStatus !== "open") {
        empty.textContent = `暂无${labels[state.wantedStatus]}的记录。`;
      } else {
        empty.textContent =
          state.wantedKind === "broken"
            ? "目前没有待补档的资源。发现链接失效可以在资源卡片里点「链接失效？点这里反馈」。"
            : "还没有人留言，你可以第一个提交。";
      }
    }

    list.forEach((item) => {
      const li = document.createElement("li");
      li.className = "wanted-row";

      const main = document.createElement("div");
      main.className = "wanted-main";

      const name = document.createElement("p");
      name.className = "wanted-name";
      name.textContent = item.title;
      main.appendChild(name);

      if (item.note) {
        const note = document.createElement("p");
        note.className = "wanted-note";
        note.textContent = item.note;
        main.appendChild(note);
      }

      // 站长的处理回复，只有已找到/已关闭的条目才会有
      if (item.reply) {
        const reply = document.createElement("p");
        reply.className = "wanted-reply";
        reply.textContent = "↳ " + item.reply;
        main.appendChild(reply);
      }

      const meta = document.createElement("p");
      meta.className = "wanted-meta";
      const d = fmtWantedDate(item.created);
      meta.textContent = d ? `${d} 提交` : "";
      main.appendChild(meta);

      li.appendChild(main);

      const side = document.createElement("div");
      side.className = "wanted-side";

      const vote = document.createElement("button");
      vote.type = "button";
      vote.className = "wanted-vote";
      vote.title = state.wantedKind === "broken" ? "我也遇到失效了" : "我也想看";
      const arrow = document.createElement("span");
      arrow.setAttribute("aria-hidden", "true");
      arrow.textContent = "▲";
      const num = document.createElement("strong");
      num.textContent = item.votes;
      vote.appendChild(arrow);
      vote.appendChild(num);
      vote.addEventListener("click", () => voteWanted(item, vote, num));
      side.appendChild(vote);

      const pill = document.createElement("span");
      pill.className = "wanted-status " + item.status;
      pill.textContent = labels[item.status] || item.status;
      side.appendChild(pill);

      // 站长登录后每条多一排操作：标已处理 / 关闭 / 放回待处理 / 删除。
      // 之前只能在 D1 里手敲 UPDATE，看到「已补档」也没法在页面上标掉，
      // 待补档那个数字会一直挂着。
      if (adminToken) {
        const ops = document.createElement("div");
        ops.className = "wanted-ops";

        const mk = (label, title, onClick, cls = "") => {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "wanted-op" + (cls ? " " + cls : "");
          b.textContent = label;
          b.title = title;
          b.addEventListener("click", onClick);
          ops.appendChild(b);
          return b;
        };

        // 只显示能流转过去的状态，别给一个「把已补上标成已补上」的按钮
        if (item.status !== "found") {
          mk(labels.found, `标为${labels.found}`, () =>
            setRequestStatus(item, "found", ops)
          );
        }
        if (item.status !== "closed") {
          mk(labels.closed, `标为${labels.closed}`, () =>
            setRequestStatus(item, "closed", ops)
          );
        }
        if (item.status !== "open") {
          mk("放回" + labels.open, `标回${labels.open}`, () =>
            setRequestStatus(item, "open", ops)
          );
        }
        mk("写回复", "写一句处理说明，访客能看到", () => promptReply(item, ops));
        mk("删除", "彻底删掉这条反馈，不可撤销", () => removeRequest(item, ops), "danger");

        li.appendChild(ops);
      }

      li.appendChild(side);
      box.appendChild(li);
    });
  }

  /* ---------- 反馈运维（站长登录后可用） ---------- */

  /** 操作行里的临时提示。整块会在 loadWanted 后重建，所以不必还原。 */
  function opsSay(ops, text, kind = "") {
    let msg = ops.querySelector(".wanted-op-msg");
    if (!msg) {
      msg = document.createElement("span");
      msg.className = "wanted-op-msg";
      ops.appendChild(msg);
    }
    msg.textContent = text;
    msg.className = "wanted-op-msg" + (kind ? " " + kind : "");
  }

  const setOpsBusy = (ops, busy) =>
    ops.querySelectorAll("button").forEach((b) => (b.disabled = busy));

  /** 改状态后重新拉列表 —— 汇总数字也变了，本地改一条盖不住。 */
  async function setRequestStatus(item, status, ops) {
    setOpsBusy(ops, true);
    opsSay(ops, "处理中…");
    const r = await adminFetch("/api/admin/request", { id: item.id, status });
    setOpsBusy(ops, false);
    if (!r.ok) return opsSay(ops, r.error, "bad");
    await loadWanted();
    renderWanted();
  }

  async function promptReply(item, ops) {
    // 用 prompt 而不是内嵌输入框：写回复是偶发操作，为它在每行塞一个
    // textarea 会把列表撑得很乱。
    const text = window.prompt("写一句处理说明（访客能看到）：", item.reply || "");
    if (text === null) return;   // 取消
    setOpsBusy(ops, true);
    opsSay(ops, "保存中…");
    const r = await adminFetch("/api/admin/request", { id: item.id, reply: text });
    setOpsBusy(ops, false);
    if (!r.ok) return opsSay(ops, r.error, "bad");
    await loadWanted();
    renderWanted();
  }

  async function removeRequest(item, ops) {
    if (!window.confirm(`彻底删除「${item.title}」这条反馈？不可撤销。`)) return;
    setOpsBusy(ops, true);
    opsSay(ops, "删除中…");
    const r = await adminFetch("/api/admin/request/delete", { id: item.id });
    setOpsBusy(ops, false);
    if (!r.ok) return opsSay(ops, r.error, "bad");
    await loadWanted();
    renderWanted();
  }

  /** 一键清空当前类型下已处理完的（已找到/已补上 + 已关闭）。
   *  待处理的不在范围里 —— 还没看过的东西不该被一键抹掉。 */
  function bindWantedPurge() {
    const btn = $("[data-wanted-purge]");
    const msg = $("[data-wanted-admin-msg]");
    if (!btn || !msg) return;
    const say = (t, kind = "") => {
      msg.textContent = t;
      msg.className = "wanted-admin-msg" + (kind ? " " + kind : "");
    };

    btn.addEventListener("click", async () => {
      const labels = kindStatusLabel(state.wantedKind);
      const counts = state.wantedSummary[state.wantedKind] || {};
      const n = (counts.found || 0) + (counts.closed || 0);
      if (!n) return say("当前没有已处理的记录", "");
      const kindLabel = state.wantedKind === "broken" ? "失效反馈" : "想要资源";
      if (
        !window.confirm(
          `清空「${kindLabel}」里 ${n} 条${labels.found}/${labels.closed}的记录？不可撤销。`
        )
      ) {
        return;
      }
      btn.disabled = true;
      say("清理中…");
      const r = await adminFetch("/api/admin/requests/purge", {
        kind: state.wantedKind,
        statuses: ["found", "closed"],
      });
      btn.disabled = false;
      if (!r.ok) return say(r.error, "bad");
      say(`已清掉 ${r.data.deleted} 条`, "ok");
      await loadWanted();
      renderWanted();
    });
  }

  /** 更新面板标题下那行说明，同时决定整块是否显示。 */
  function renderWanted() {
    const panel = $("[data-wanted-panel]") || $(".wanted-section");
    const api = wantedApi();
    if (panel) {
      // 后端不可用时整块隐藏：表单点了没反应比没有表单更让人困惑
      panel.hidden = !api;
      if (!api) return;
    }
    const sub = $("[data-wanted-sub]");
    if (sub) {
      const want = (state.wantedSummary.want || {}).open || 0;
      const broken = (state.wantedSummary.broken || {}).open || 0;
      if (!state.wantedLoaded) {
        sub.textContent = "想要的资源可以留言，站内资源失效也能反馈。";
      } else if (state.brokenReady) {
        sub.textContent =
          `想要的资源可以留言，站内资源失效也能反馈。当前 ${want} 条待找、${broken} 条待补档。`;
      } else {
        // 老后端只有求资源这一类，别提失效反馈，免得用户去找不存在的入口
        sub.textContent = `匿名留言想看的作品，找到后会加进站里。当前 ${want} 条待找。`;
      }
    }
    // 只有「想要资源」需要提交表单；失效反馈走资源卡片上的按钮
    const form = $("[data-wanted-form]");
    if (form) form.hidden = state.wantedKind !== "want";
    const hint = $("[data-wanted-broken-hint]");
    if (hint) hint.hidden = state.wantedKind !== "broken";

    // 站长操作那一排只在登录后显示，按钮上带上待清条数
    const adminBar = $("[data-wanted-admin]");
    if (adminBar) {
      adminBar.hidden = !adminToken;
      if (adminToken) {
        const labels = kindStatusLabel(state.wantedKind);
        const counts = state.wantedSummary[state.wantedKind] || {};
        const n = (counts.found || 0) + (counts.closed || 0);
        const btn = $("[data-wanted-purge]");
        if (btn) {
          btn.textContent = n
            ? `清空已处理的（${n}）`
            : "清空已处理的";
          btn.disabled = !n;
          btn.title = `删掉当前类型下所有${labels.found}/${labels.closed}的记录`;
        }
      }
    }

    renderNoticeBroken();
    renderWantedKindTabs();
    renderWantedTabs();
    renderWantedList();
  }

  /** 公告里那句「点卡片里的反馈按钮」只有按钮真的存在时才说。
   *  卡片按钮的显示条件是后端认识 kind（brokenReady），没部署时公告若还教用户
   *  去点，用户会满页找一个不存在的按钮 —— 那时退回原来的「去反馈群说」。 */
  function renderNoticeBroken() {
    const on = $("[data-notice-broken]");
    const off = $("[data-notice-broken-fallback]");
    if (on) on.hidden = !state.brokenReady;
    if (off) off.hidden = state.brokenReady;
  }

  /** +1 想看。乐观更新数字，失败则回滚 —— 别让用户点了没有任何反馈。 */
  async function voteWanted(item, btn, numEl) {
    const api = wantedApi();
    if (!api || btn.disabled) return;
    btn.disabled = true;
    const before = item.votes;
    item.votes = before + 1;
    numEl.textContent = item.votes;
    try {
      const res = await fetch(`${api}/api/requests/vote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok !== true) {
        item.votes = before;
        numEl.textContent = before;
        btn.classList.add("voted");
        btn.title = data.reason === "already voted" ? "你已经投过了" : "投票没成功";
      } else {
        btn.classList.add("voted");
        btn.title = "已记下你这一票";
      }
    } catch {
      item.votes = before;
      numEl.textContent = before;
      btn.title = "网络不通，稍后再试";
      btn.disabled = false;
    }
  }

  /** 提交求助。 */
  function bindWantedForm() {
    const form = $("[data-wanted-form]");
    if (!form) return;
    const titleEl = $('[data-wanted-input="title"]');
    const noteEl = $('[data-wanted-input="note"]');
    const submit = $("[data-wanted-submit]");
    const msg = $("[data-wanted-msg]");

    const say = (text, kind = "") => {
      if (!msg) return;
      msg.textContent = text;
      msg.className = "wanted-msg" + (kind ? " " + kind : "");
    };

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const api = wantedApi();
      if (!api) return say("帮找功能暂时不可用", "bad");

      const title = (titleEl.value || "").trim();
      if (!title) return say("请先填作品名", "bad");

      submit.disabled = true;
      say("提交中…");
      try {
        const res = await fetch(`${api}/api/requests`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title, note: (noteEl.value || "").trim() }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          say(data.error || "提交失败，稍后再试", "bad");
        } else if (data.merged) {
          say("已有人提过这部作品，帮你加了一票", "ok");
          titleEl.value = "";
          noteEl.value = "";
        } else {
          say("提交成功，找到后会加进站里", "ok");
          titleEl.value = "";
          noteEl.value = "";
        }
        // 无论新建还是合并，列表都变了，重新拉一次
        if (res.ok) {
          state.wantedStatus = "open";
          await loadWanted();
          renderWanted();
          refreshScrollDock();
        }
      } catch {
        say("网络不通，稍后再试", "bad");
      } finally {
        submit.disabled = false;
      }
    });
  }

  /** 帮找区默认收起，首屏不被表单占掉。 */
  function bindWantedPanel() {
    const btn = $("[data-wanted-toggle]");
    const body = $("[data-wanted-body]");
    if (!btn || !body) return;
    btn.addEventListener("click", async () => {
      state.wantedOpen = !state.wantedOpen;
      body.hidden = !state.wantedOpen;
      btn.setAttribute("aria-expanded", String(state.wantedOpen));
      btn.textContent = state.wantedOpen ? "收起" : "展开";
      // 首次展开才拉数据，没人看的时候不占请求
      if (state.wantedOpen && !state.wantedLoaded) {
        await loadWanted();
      }
      if (state.wantedOpen) renderWanted();
      refreshScrollDock();
    });
  }

  /** 公告里的「资源帮找」跳转：滚过去并自动展开。 */
  function bindWantedJump() {
    const btn = $("[data-goto-wanted]");
    if (!btn) return;
    btn.addEventListener("click", async () => {
      const toggle = $("[data-wanted-toggle]");
      if (toggle && !state.wantedOpen) toggle.click();
      const sec = $("#wanted");
      if (sec) sec.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  /** 排行榜默认收起，避免首屏被一大块统计挤掉。 */
  function bindStatsPanel() {
    const btn = $("[data-stats-toggle]");
    const body = $("[data-stats-body]");
    if (!btn || !body) return;
    btn.addEventListener("click", () => {
      state.statsOpen = !state.statsOpen;
      body.hidden = !state.statsOpen;
      btn.setAttribute("aria-expanded", String(state.statsOpen));
      btn.textContent = state.statsOpen ? "收起" : "展开";
      if (state.statsOpen) renderStats();
      refreshScrollDock();
    });
  }

  function render() {
    renderTabs();
    renderSubTabs();
    const watching = state.section === "watch";
    const feed = $("[data-feed]")?.closest(".feed-section");
    const watch = $("[data-watch-panel]");
    if (feed) feed.hidden = watching;
    if (watch) watch.hidden = !watching;
    if (watching) renderWatch();
    else renderFeed();
    renderStatsTabs();
    renderStats();
    $('[data-stat="total"]').textContent = String(allowedItems().length).padStart(2, "0");
    refreshScrollDock();
  }
  /* ---------- 观看区（薄荷梨子网页适配） ---------- */

  const WATCH_KIND_LABELS = { music: "音乐", manga: "漫画", anime: "动画", novel: "小说" };
  const WATCH_CACHE_TTL = 5 * 60 * 1000;
  const WATCH_PROGRESS_KEY = "mo-watch-progress-v1";
  const watchCache = new Map();

  function watchCacheKey(kind = state.watchKind, query = state.watchQuery) {
    return `${kind}:${String(query || "").trim().toLowerCase()}`;
  }

  function watchProgress() {
    try {
      const value = JSON.parse(localStorage.getItem(WATCH_PROGRESS_KEY) || "{}");
      return value && typeof value === "object" ? value : {};
    } catch { return {}; }
  }

  function saveWatchProgress(kind, item, part = null, partIndex = null) {
    try {
      const all = watchProgress();
      const prev = all[kind];
      const rec = {
        id: String(item.id), title: item.title,
        partId: part ? String(part.id) : "",
        partTitle: part?.title || "",
        // 记下标，恢复时不用靠标题匹配（标题可能重名或带卷名变动）
        partIndex: Number.isInteger(partIndex) && partIndex >= 0 ? partIndex : null,
        at: Date.now(),
      };
      // 根因修复：打开条目（卡片点击处不带 part）时沿用原章节进度。
      // 之前是整条覆盖 → 刷新后一点开书，partId 先被抹成 ""，「继续阅读」条永远出不来。
      if (!part && prev && String(prev.id) === rec.id) {
        rec.partId = prev.partId || "";
        rec.partTitle = prev.partTitle || "";
        rec.partIndex = Number.isInteger(prev.partIndex) ? prev.partIndex : null;
      }
      all[kind] = rec;
      localStorage.setItem(WATCH_PROGRESS_KEY, JSON.stringify(all));
    } catch { /* 无痕模式下不影响观看 */ }
  }

  function watchStatus(text, bad = false) {
    const el = $("[data-watch-status]");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("is-bad", bad);
  }

  /* ---------- 观看区：漫画线路（多源） ---------- */

  // 和 App 里的漫画源对应（assets/public.js 的 MOBILE_*_SOURCE）。
  // 空 id = 自动：Worker 按注册顺序依次尝试，某条挂了自动跳下一条。
  const WATCH_MANGA_SOURCES = [
    { id: "", label: "自动（依次尝试）" },
    { id: "manga3r", label: "叽叽漫画" },
    { id: "manga4", label: "GMH 漫画" },
    { id: "crm", label: "薄荷梨子（原线路）" },
  ];

  const WATCH_PAGE_SIZE = 24;
  // 动画区嵌入原站的地址（与 APK 的 MOBILE_ANIMATION_BASE 一致）
  // 动画区走量子资源 API + 自建 hls.js 播放器（见 openWatchAnime / watchMountVideo）。

  function currentSource() {
    if (state.watchKind !== "manga") return "";
    return WATCH_MANGA_SOURCES.some((s) => s.id === state.watchSource) ? state.watchSource : "";
  }

  function sourceLabel() {
    const found = WATCH_MANGA_SOURCES.find((s) => s.id === currentSource());
    return found ? found.label : "自动";
  }

  /* ---------- 观看区：下载 ---------- */

  function watchDownloadName(item, suffix) {
    const safe = String(item?.title || "watch").replace(/[\\/:*?"<>|\r\n\t]+/g, " ").trim().slice(0, 80);
    return `${safe || "watch"}${suffix}`;
  }

  function watchSaveBlob(blob, filename) {
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(href), 60000);
  }

  /** 把上游地址换成同源代理地址，否则 Worker 会因为跨域 / 白名单拒掉。 */
  function watchProxyAudio(remote) {
    return `${apiBase()}/api/watch/audio?url=${encodeURIComponent(String(remote).replace(/^http:/, "https:"))}`;
  }

  /** 逐个抓取章节图片，串行下载以免同时打爆上游。 */
  async function watchDownloadImages(srcs, item, onProgress) {
    const files = [];
    for (let i = 0; i < srcs.length; i++) {
      onProgress?.(`正在下载第 ${i + 1}/${srcs.length} 张…`);
      const response = await fetch(watchMediaUrl(srcs[i]), { cache: "force-cache" });
      if (!response.ok) throw new Error(`第 ${i + 1} 张失败（HTTP ${response.status}）`);
      const blob = await response.blob();
      const ext = (blob.type.split("/")[1] || "jpg").replace("jpeg", "jpg");
      const name = `${String(i + 1).padStart(4, "0")}.${ext}`;
      files.push({ name, blob });
    }
    return files;
  }

  function watchPackZip(files) {
    if (!window.JSZip) throw new Error("打包组件未加载，请刷新页面重试");
    const zip = new window.JSZip();
    files.forEach((file) => zip.file(file.name, file.blob));
    return zip.generateAsync({ type: "blob", compression: "STORE" });
  }

  /** 正文按章节拼成一本纯文本，图片以 URL 形式留在原位。 */
  function watchNovelText(detail, item) {
    const lines = [
      `《${item.title}》`,
      detail.description ? `\n${detail.description}\n` : "",
      "".padEnd(24, "="),
    ];
    (detail.chapters || []).forEach((chapter) => {
      if (chapter.text) {
        lines.push(`\n\n${chapter.title}\n`);
        lines.push(chapter.text);
      } else {
        lines.push(`\n\n${chapter.title}\n（正文抓取失败）`);
      }
    });
    return lines.join("\n");
  }

  /** 目录页每章旁边的「下载」：单独抓一章正文，存成 txt。 */
  async function downloadNovelChapter(item, chapter, button) {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = "下载中…";
    try {
      const data = await watchApi(
        `/api/watch/novel?action=chapter&novel=${encodeURIComponent(item.id)}&chapter=${encodeURIComponent(chapter.id)}`
      );
      const text = (data.blocks || []).map((block) => (block.type === "image" ? `[图片] ${block.src}` : block.text)).join("\n\n");
      watchSaveBlob(
        new Blob([`${data.title || chapter.title}\n\n${text || "（本章没有正文）"}`], { type: "text/plain;charset=utf-8" }),
        watchDownloadName({ title: `${item.title} ${chapter.title}` }, ".txt")
      );
      button.textContent = "已下载";
    } catch (error) {
      button.textContent = "失败";
      watchStatus(`下载失败：${error.message}`, true);
    } finally {
      button.disabled = false;
      setTimeout(() => { button.textContent = original; }, 1800);
    }
  }

  /** 正文阅读页顶部的「下载本章」。 */
  async function downloadNovelChapterView(item, chapter, data, button) {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = "打包中…";
    try {
      const text = (data.blocks || []).map((block) => (block.type === "image" ? `[图片] ${block.src}` : block.text)).join("\n\n");
      watchSaveBlob(
        new Blob([`${data.title || chapter.title}\n\n${text}`], { type: "text/plain;charset=utf-8" }),
        watchDownloadName({ title: `${item.title} ${chapter.title}` }, ".txt")
      );
      button.textContent = "已下载";
    } catch (error) {
      button.textContent = "失败";
      watchStatus(`下载失败：${error.message}`, true);
    } finally {
      button.disabled = false;
      setTimeout(() => { button.textContent = original; }, 1800);
    }
  }

  function watchMusicItems(data) {
    const root = data?.data;
    // 兼容多种上游形状：
    //  - searchV2 原始结构：data.result.songs = 网易云标准数组（root.result 是 {songs:[]} 对象）
    //  - explore 经 Worker 归一化：{items:[...]}
    //  - 其它：data.result / data.songs / data.items 为数组
    const list = Array.isArray(root) ? root
      : root?.result?.songs
      || root?.songs
      || root?.result
      || data?.items
      || data?.result?.songs
      || data?.result
      || data?.songs
      || [];
    return (Array.isArray(list) ? list : []).map((entry) => {
      // explore 模式（Worker 归一化过）已经是 {id,name,artists,cover}
      if (entry?.name && entry?.artists && entry?.cover) {
        return {
          id: String(entry.id || ""),
          title: entry.name || "未知歌曲",
          subtitle: entry.artists.join(" / ") || "未知歌手",
          cover: entry.cover,
        };
      }
      const song = entry?.song || entry || {};
      const artists = song.artists || song.ar || entry.artists || [];
      const album = song.album || song.al || {};
      return {
        id: String(song.id || entry.id || ""),
        title: song.name || entry.name || "未知歌曲",
        subtitle: (Array.isArray(artists) ? artists.map((a) => a?.name).filter(Boolean).join(" / ") : "") || album.name || "未知歌手",
        cover: musicCover(song.pic || entry.pic || entry.picUrl || album.picUrl || ""),
      };
    }).filter((x) => x.id);
  }

  /** 网易云图床 ?param=WxH 裁剪：原图 200~700KB，300y300 只要 5~30KB，
   *  不裁剪的话一页封面要拉几 MB，半天显示不出来。 */
  function musicCover(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (!/^https?:\/\/p\d*\.music\.126\.net\//i.test(raw)) return raw.replace(/^http:/, "https:");
    return `${raw.replace(/^http:/, "https:").split("?")[0]}?param=300y300`;
  }

  async function watchApi(path) {
    const base = apiBase();
    if (!base) throw new Error("观看服务未配置");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(base + path, { cache: "no-store", signal: ctrl.signal });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  function watchRowCount() {
    return state.watchItems.length;
  }

  function setWatchStatus() {
    const label = WATCH_KIND_LABELS[state.watchKind];
    const q = state.watchQuery.trim();
    const total = state.watchItems.length;
    const shown = Math.min(state.watchLimit, total);
    if (!total) {
      watchStatus(q ? `没有找到“${q}”相关的${label}。` : `${label}暂无可显示内容。`);
      return;
    }
    const parts = [`${label}：共 ${total} 条，已显示 ${shown}`];
    if (state.watchKind === "manga") parts.push(`线路 ${sourceLabel()}`);
    watchStatus(`${parts.join(" · ")}${q ? ` · 关键词“${q}”` : ""}，点击卡片即可在网页内打开。`);
  }

  /** 单张卡片。renderWatchGrid 与 showMoreWatch 共用，保证追加的卡片和首批一致。 */
  function buildWatchCard(item, last) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "watch-card";
    card.dataset.kind = state.watchKind;
    const media = document.createElement("span");
    media.className = "watch-card-media";
    media.appendChild(watchPlaceholder());
    if (item.cover) {
      const img = document.createElement("img");
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      img.referrerPolicy = "no-referrer";
      img.addEventListener("load", () => img.classList.add("is-loaded"));
      img.addEventListener("error", () => img.remove());
      img.src = watchMediaUrl(item.cover);
      if (img.complete && img.naturalWidth) img.classList.add("is-loaded");
      media.appendChild(img);
    }
    const copy = document.createElement("span");
    copy.className = "watch-card-copy";
    const title = document.createElement("strong");
    title.textContent = item.title;
    const sub = document.createElement("small");
    sub.textContent = item.subtitle || WATCH_KIND_LABELS[state.watchKind];
    copy.append(title, sub);
    if (last && String(last.id) === String(item.id)) {
      card.classList.add("has-progress");
      const badge = document.createElement("span");
      badge.className = "watch-progress";
      badge.textContent = last.partTitle ? `上次：${last.partTitle}` : "最近打开";
      copy.appendChild(badge);
    }
    card.append(media, copy);
    card.addEventListener("click", () => openWatchItem(item));
    return card;
  }

  /** 重建列表 DOM（换关键词 / 换线路 / 重载时才用）。 */
  function renderWatchGrid() {
    const wrap = $("[data-watch-more]");
    if (!wrap) return;
    const list = $("[data-watch-list]");
    wrap.hidden = true;
    if (!list) return;

    list.textContent = "";
    const last = watchProgress()[state.watchKind];
    state.watchItems.slice(0, state.watchLimit)
      .forEach((item) => list.appendChild(buildWatchCard(item, last)));

    updateWatchPager();
  }

  /** 翻页条状态：页码指示 + 上一页/下一页可用性 + 剩余条数。
   *  动画区是「上游页」模式（20 部/页、共数百页、每次按页拉取），
   *  其余分区是「本地累加」模式（一次拉全量、分页展示）。 */
  function updateWatchPager() {
    const wrap = $("[data-watch-more]");
    if (!wrap) return;

    if (isAnimePagedMode()) {
      wrap.hidden = false;
      const now = $("[data-watch-page-now]");
      if (now) now.textContent = `第 ${state.animePage} / ${state.animeTotalPages} 页`;
      const prev = $("[data-watch-prev]");
      if (prev) prev.disabled = state.animePage <= 1;
      const next = $("[data-watch-next]");
      if (next) next.disabled = !state.animeHasNext && state.animePage >= state.animeTotalPages;
      const more = $("[data-watch-more-btn]");
      if (more) more.parentElement && (more.hidden = true);
      const info = $("[data-watch-page-info]");
      if (info) info.textContent = `第 ${state.animePage} 页 · 共 ${state.animeTotalPages} 页`;
      return;
    }

    const total = watchRowCount();
    const shown = Math.min(state.watchLimit, total);
    const page = Math.ceil(shown / WATCH_PAGE_SIZE) || 1;
    const pages = Math.ceil(total / WATCH_PAGE_SIZE) || 1;

    wrap.hidden = total <= WATCH_PAGE_SIZE;
    const more = $("[data-watch-more-btn]");
    if (more) more.hidden = false;
    const now = $("[data-watch-page-now]");
    if (now) now.textContent = `第 ${page} / ${pages} 页`;
    const prev = $("[data-watch-prev]");
    if (prev) prev.disabled = page <= 1;
    const next = $("[data-watch-next]");
    if (next) next.disabled = page >= pages;
    const label = $("[data-watch-more-label]");
    if (label) label.textContent = shown >= total ? "已到末页" : `加载更多（还剩 ${total - shown} 条）`;
    const info = $("[data-watch-page-info]");
    if (info) info.textContent = `已显示 ${shown} / ${total} 条`;
  }

  /** 动画区且没在搜索时，用上游分页。 */
  function isAnimePagedMode() {
    return state.watchKind === "anime" && !state.watchQuery.trim();
  }

  /** 动画区翻页：直接拉上游对应页。 */
  function gotoAnimePage(page) {
    const target = Math.min(Math.max(1, page), 400);
    if (target === state.animePage && state.watchItems.length) return;
    state.animePage = target;
    loadWatch({ force: true });
    document.querySelector("[data-watch-grid]")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /** 翻到指定页（1 起）。只渲染到该页末尾：向后翻就追加新卡片，
   *  向前翻则重建到该页（数量少，重建比逐个删更省事）。 */
  function gotoWatchPage(page) {
    if (isAnimePagedMode()) { gotoAnimePage(page); return; }
    const total = watchRowCount();
    const pages = Math.ceil(total / WATCH_PAGE_SIZE) || 1;
    const target = Math.min(Math.max(1, page), pages);
    const newLimit = Math.min(target * WATCH_PAGE_SIZE, total);
    const before = state.watchLimit;

    if (newLimit < before) {
      // 往回翻：重建列表到目标页
      state.watchLimit = newLimit;
      renderWatchGrid();
      setWatchStatus();
      document.querySelector("[data-watch-grid]")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }

    const list = $("[data-watch-list]");
    if (newLimit > before && list) {
      const last = watchProgress()[state.watchKind];
      let firstNew = null;
      state.watchItems.slice(before, newLimit).forEach((item) => {
        const card = buildWatchCard(item, last);
        if (!firstNew) firstNew = card;
        list.appendChild(card);
      });
      if (firstNew) firstNew.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    state.watchLimit = newLimit;
    updateWatchPager();
    setWatchStatus();
  }

  /** 只做分页计数 + 状态行，不动已渲染的卡片，避免页面滚动位置被重置。 */
  function showMoreWatch() {
    gotoWatchPage(Math.ceil(Math.min(state.watchLimit, watchRowCount()) / WATCH_PAGE_SIZE) + 1);
  }

  async function loadWatch({ force = false } = {}) {
    const kind = state.watchKind;
    const q = state.watchQuery.trim();
    const source = currentSource();
    const requestId = ++state.watchRequest;
    state.watchViewerOpen = false;
    state.watchViewRequest++;
    state.watchLimit = WATCH_PAGE_SIZE;
    // 动画翻页：换页时由 gotoAnimePage 设置 animePage 再调用这里。
    const page = state.animePage;

    renderWatchTabs();
    renderWatchSources();

    // 动画区已改为量子资源 API（自建 hls.js 播放器），走下面的通用列表流程。
    // 原来的「整站 iframe 嵌入」因上游强推 APK 且 Worker 被其 CF 挑战而废弃。

    const key = `${watchCacheKey(kind, q)}:${source}:${kind === "anime" ? page : ""}`;
    const cached = watchCache.get(key);

    if (!force && cached && Date.now() - cached.at < WATCH_CACHE_TTL) {
      state.watchItems = cached.items;
      state.watchError = "";
      state.watchLoading = false;
      renderWatch();
      setWatchStatus();
      return;
    }

    state.watchLoading = true;
    state.watchError = "";
    renderWatch();
    watchStatus(`正在加载${WATCH_KIND_LABELS[kind]}…`);

    try {
      let items = [];
      if (kind === "music") {
        // 无搜索词时用 explore（最新 + 品类聚合），不然永远只有 10 首；
        // 搜索仍走上游 searchV2。
        const path = q
          ? `/api/watch/music?action=searchV2&q=${encodeURIComponent(q)}`
          : "/api/watch/music?action=explore";
        items = watchMusicItems(await watchApi(path));
      } else {
        const params = new URLSearchParams({ action: "list" });
        if (q) params.set("q", q);
        if (kind === "manga" && source) params.set("source", source);
        if (kind === "anime" && !q) params.set("page", String(page));
        const payload = await watchApi(`/api/watch/${kind}?${params}`);
        items = payload.items || [];
        // 动画区：上游分页信息（306 页）
        if (kind === "anime" && !q && payload.totalPages) {
          state.animeTotalPages = Math.max(1, Math.min(payload.totalPages, 400));
          state.animeHasNext = !!payload.hasNext;
        }
      }

      if (requestId !== state.watchRequest) return;

      state.watchItems = items;
      watchCache.set(key, { at: Date.now(), items });
      setWatchStatus();
    } catch (error) {
      if (requestId !== state.watchRequest) return;
      state.watchItems = [];
      state.watchError = error.name === "AbortError" ? "请求超时" : error.message;
      watchStatus(`加载失败：${state.watchError}`, true);
    } finally {
      if (requestId === state.watchRequest) {
        state.watchLoading = false;
        renderWatch();
      }
    }
  }

  function watchMediaUrl(value) {
    const src = String(value || "");
    if (!src) return "";
    if (src.startsWith("/")) return `${apiBase()}${src}`;
    return src.replace(/^http:/, "https:");
  }

  function watchPlaceholder(kind = state.watchKind) {
    const node = document.createElement("span");
    node.className = `watch-cover-placeholder is-${kind}`;
    node.setAttribute("aria-hidden", "true");
    node.textContent = { music: "♫", manga: "漫", anime: "动", novel: "文" }[kind] || "墨";
    return node;
  }

  function renderWatchMessage(grid, text, action = null) {
    const box = document.createElement("div");
    box.className = "watch-empty";
    const message = document.createElement("p");
    message.textContent = text;
    box.appendChild(message);
    if (action) box.appendChild(watchButton(action.label, action.run, "watch-retry"));
    grid.appendChild(box);
  }

  /** 分区标签（音乐/漫画/动画/小说）+ 漫画线路选择器。 */
  function renderWatchSources() {
    const bar = $("[data-watch-sources]");
    if (!bar) return;
    const isManga = state.watchKind === "manga";
    bar.hidden = !isManga;
    if (!isManga) return;
    if (bar.dataset.rendered !== "1") {
      bar.dataset.rendered = "1";
      const label = document.createElement("label");
      label.className = "watch-source-pick";
      const caption = document.createElement("span");
      caption.textContent = "漫画线路";
      const select = document.createElement("select");
      select.setAttribute("data-watch-source", "");
      WATCH_MANGA_SOURCES.forEach((source) => {
        const option = document.createElement("option");
        option.value = source.id;
        option.textContent = source.label;
        select.appendChild(option);
      });
      label.append(caption, select);
      bar.appendChild(label);

      const hint = document.createElement("p");
      hint.className = "watch-source-hint";
      hint.setAttribute("data-watch-source-hint", "");
      bar.appendChild(hint);

      select.addEventListener("change", () => {
        state.watchSource = select.value;
        state.watchItems = [];
        state.watchLimit = WATCH_PAGE_SIZE;
        loadWatch({ force: true });
      });
    }
    const select = $("[data-watch-source]");
    if (select && select.value !== currentSource()) select.value = currentSource();
    const hint = $("[data-watch-source-hint]");
    if (hint) {
      hint.textContent = currentSource()
        ? "已锁定该漫画源；打不开或没有章节时换一个源试试。"
        : "自动模式会依次尝试各漫画源（叽叽漫画 → GMH → 原线路），某条挂了自动跳下一条。";
    }
  }

  function renderWatchTabs() {
    const bar = $("[data-watch-tabs]");
    if (!bar) return;
    bar.textContent = "";
    Object.entries(WATCH_KIND_LABELS).forEach(([id, label]) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "watch-tab";
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", String(state.watchKind === id));
      btn.textContent = label;
      btn.addEventListener("click", () => {
        if (state.watchKind === id) return;
        closeWatchViewer();
        state.watchKind = id;
        state.sub = id;
        state.watchItems = [];
        state.watchError = "";
        state.watchQuery = "";
        state.watchSource = "";
        state.watchLimit = WATCH_PAGE_SIZE;
        state.animePage = 1;
        state.animeTotalPages = 1;
        const input = $("[data-watch-query]");
        if (input) input.value = "";
        renderWatchTabs();
        loadWatch();
      });
      bar.appendChild(btn);
    });
  }

  function renderWatch() {
    const grid = $("[data-watch-grid]");
    const viewer = $("[data-watch-viewer]");
    if (!grid || !viewer) return;
    grid.setAttribute("aria-busy", String(state.watchLoading));
    if (state.watchViewerOpen) {
      grid.hidden = true;
      viewer.hidden = false;
      return;
    }
    viewer.hidden = true;
    grid.hidden = false;

    const list = $("[data-watch-list]");
    if (!list) return;
    const wrap = $("[data-watch-more]");

    if (state.watchLoading) {
      list.textContent = "";
      if (wrap) wrap.hidden = true;
      for (let i = 0; i < 8; i++) {
        const card = document.createElement("div");
        card.className = "watch-skeleton";
        card.setAttribute("aria-hidden", "true");
        card.innerHTML = '<span></span><i></i><i></i>';
        list.appendChild(card);
      }
      return;
    }

    if (state.watchError) {
      list.textContent = "";
      if (wrap) wrap.hidden = true;
      renderWatchMessage(list, `暂时没能加载${WATCH_KIND_LABELS[state.watchKind]}：${state.watchError}`, {
        label: "重新加载", run: () => loadWatch({ force: true }),
      });
      return;
    }

    if (!state.watchItems.length) {
      list.textContent = "";
      if (wrap) wrap.hidden = true;
      renderWatchMessage(list, state.watchQuery
        ? `没有找到“${state.watchQuery}”相关内容，换个关键词试试。`
        : `${WATCH_KIND_LABELS[state.watchKind]}暂无可显示内容。`);
      return;
    }

    renderWatchGrid();
  }

  async function openWatchItem(item) {
    const grid = $("[data-watch-grid]");
    const viewer = $("[data-watch-viewer]");
    const body = $("[data-watch-viewer-body]");
    const kind = state.watchKind;
    const requestId = ++state.watchViewRequest;
    state.watchViewerOpen = true;
    $("[data-watch-viewer-title]").textContent = item.title;
    grid.hidden = true;
    viewer.hidden = false;
    body.innerHTML = '<p class="watch-loading">正在获取内容…</p>';
    saveWatchProgress(kind, item);
    if (kind === "music") return openWatchMusic(item, body, requestId);
    if (kind === "novel") return openWatchNovel(item, body, requestId);
    if (kind === "manga") return openWatchManga(item, body, requestId);
    if (kind === "anime") return openWatchAnime(item, body, requestId);
    renderWatchMessage(body, "该线路尚未开放网页播放。");
  }

  const watchViewCurrent = (requestId) => requestId === state.watchViewRequest;

  function watchError(body, prefix, error, retry = null) {
    const message = error?.name === "AbortError" ? "请求超时" : (error?.message || String(error));
    body.textContent = "";
    renderWatchMessage(body, `${prefix}：${message}`, retry ? { label: "重试", run: retry } : null);
  }

  async function openWatchMusic(item, body, requestId) {
    try {
      const data = await watchApi(`/api/watch/music?action=getAlgerListenUrl&id=${encodeURIComponent(item.id)}`);
      if (!watchViewCurrent(requestId)) return;
      const remote = typeof data?.data === "string" ? data.data : data?.data?.url || data?.url || "";
      if (!remote) throw new Error("上游没有返回播放地址");
      const audio = document.createElement("audio");
      audio.className = "watch-player";
      audio.controls = true;
      audio.autoplay = true;
      audio.preload = "metadata";
      audio.src = watchProxyAudio(remote);
      const bar = document.createElement("div");
      bar.className = "watch-action-bar";
      bar.appendChild(watchButton("下载音频", async (event) => {
        const button = event.currentTarget;
        const original = button.textContent;
        button.disabled = true;
        button.textContent = "下载中…";
        try {
          const response = await fetch(watchProxyAudio(remote), { cache: "force-cache" });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const blob = await response.blob();
          watchSaveBlob(blob, watchDownloadName(item, ".mp3"));
          button.textContent = "已下载";
        } catch (error) {
          button.textContent = "失败";
          watchStatus(`下载失败：${error.message}`, true);
        } finally {
          button.disabled = false;
          setTimeout(() => { button.textContent = original; }, 1800);
        }
      }, "watch-download"));
      body.replaceChildren(bar, audio);
      saveWatchProgress("music", item);
    } catch (error) {
      if (watchViewCurrent(requestId)) watchError(body, "播放失败", error, () => openWatchItem(item));
    }
  }

  function watchButton(label, onClick, className = "") {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    if (className) button.className = className;
    button.addEventListener("click", onClick);
    return button;
  }

  /* ---------- 阅读器工具条（小说 / 漫画） ----------
   * 小说：字号 A-/A+（14–28px）+ 主题（白/纸/暗）；漫画：适应宽度/原始大小 + 回顶部。
   * 偏好记 localStorage，换章后保持。 */
  const READ_KEYS = {
    novelSize: "mo-read-novel-size",
    novelTheme: "mo-read-novel-theme",
    novelLang: "mo-read-novel-lang",
    mangaFit: "mo-read-manga-fit",
  };
  const NOVEL_THEME_LABEL = { "": "白", paper: "纸", dark: "暗" };

  function watchReadStore(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : v;
    } catch { return fallback; }
  }
  function watchReadSave(key, value) {
    try { localStorage.setItem(key, String(value)); } catch { /* 隐私模式忽略 */ }
  }

  function watchNovelTools(reader, lang = "simplified", onLangChange = null) {
    const bar = document.createElement("div");
    bar.className = "watch-read-tools";
    let size = Math.min(28, Math.max(14, parseInt(watchReadStore(READ_KEYS.novelSize, "17"), 10) || 17));
    let theme = NOVEL_THEME_LABEL[watchReadStore(READ_KEYS.novelTheme, "")] !== undefined
      ? watchReadStore(READ_KEYS.novelTheme, "") : "";
    const apply = () => {
      reader.style.fontSize = `${size}px`;
      reader.dataset.theme = theme;
    };
    const minus = watchButton("A−", () => { size = Math.max(14, size - 1); apply(); try { localStorage.setItem(READ_KEYS.novelSize, String(size)); } catch {} }, "watch-tool-btn");
    const plus = watchButton("A+", () => { size = Math.min(28, size + 1); apply(); try { localStorage.setItem(READ_KEYS.novelSize, String(size)); } catch {} }, "watch-tool-btn");
    const themeBtn = watchButton(`主题：${NOVEL_THEME_LABEL[theme] || "白"}`, () => {
      const order = ["", "paper", "dark"];
      theme = order[(order.indexOf(theme) + 1) % order.length];
      themeBtn.textContent = `主题：${NOVEL_THEME_LABEL[theme] || "白"}`;
      apply();
      try { localStorage.setItem(READ_KEYS.novelTheme, theme); } catch {}
    }, "watch-tool-btn");
    // 简繁切换按钮
    const langLabel = lang === "traditional" ? "繁体" : "简体";
    const langBtn = watchButton(`文：${langLabel}`, () => {
      const newLang = lang === "traditional" ? "simplified" : "traditional";
      langBtn.textContent = `文：${newLang === "traditional" ? "繁体" : "简体"}`;
      try { localStorage.setItem(READ_KEYS.novelLang, newLang); } catch {}
      if (onLangChange) onLangChange(newLang);
    }, "watch-tool-btn");
    apply();
    bar.append(minus, plus, themeBtn, langBtn);
    return bar;
  }

  function watchMangaTools(reader) {
    const bar = document.createElement("div");
    bar.className = "watch-read-tools";
    const fit = () => reader.dataset.fit || "fit";
    const apply = () => { reader.dataset.fit = fit(); topBtn.textContent = fit() === "fit" ? "原始大小" : "适应宽度"; };
    const fitBtn = watchButton("", () => {
      reader.dataset.fit = fit() === "fit" ? "orig" : "fit";
      try { localStorage.setItem(READ_KEYS.mangaFit, fit()); } catch {}
      apply();
    }, "watch-tool-btn");
    const topBtn = watchButton("↑ 回顶部", () => bar.scrollIntoView({ block: "start" }), "watch-tool-btn");
    try {
      const saved = localStorage.getItem(READ_KEYS.mangaFit);
      if (saved) reader.dataset.fit = saved;
    } catch {}
    apply();
    bar.append(fitBtn, topBtn);
    return bar;
  }

  /* ---------- 沉浸式阅读模式 ----------
   * 「专门适配阅读」：全屏遮罩里只留当前这本书的正文 + 上下章 + 目录抽屉，
   * 站点其它 UI（分区 tab / 卡片流 / 搜索）全部让位，长文阅读不被打断。
   * 小说和漫画共用同一个壳，正文内容由各自渲染函数灌进去。 */
  const { mountReadingMode, closeReadingMode, isReadingModeOpen } = (() => {
    let overlay = null;
    let host = null;         // 正文容器
    let titleNode = null;
    let stepNode = null;
    let headHost = null;     // 工具条容器
    let drawer = null;       // 目录抽屉
    let onPrev = null, onNext = null;
    let hintTimer = null;

    /** 沉浸/常规切换：点正文区域收起或叫回顶栏+工具条+底栏。
     *  点链接、按钮、图片之外的空白（或正文段落）才算切换，避免误收起后点不到东西。 */
    function setImmersive(on) {
      if (!overlay) return;
      overlay.classList.toggle("is-immersive", !!on);
      if (on) {
        const hint = document.createElement("div");
        hint.className = "read-mode-hint";
        hint.textContent = "已进入沉浸模式 · 点一下正文可叫回工具栏";
        overlay.appendChild(hint);
        clearTimeout(hintTimer);
        hintTimer = setTimeout(() => hint.remove(), 2700);
      } else {
        overlay.querySelectorAll(".read-mode-hint").forEach((n) => n.remove());
      }
    }

    function toggleImmersive() {
      if (!overlay) return;
      // 目录抽屉开着的时候不切换，否则用户看不清自己点了什么
      if (drawer && !drawer.hidden) return;
      setImmersive(!overlay.classList.contains("is-immersive"));
    }

    function build() {
      overlay = document.createElement("div");
      overlay.className = "read-mode";
      overlay.hidden = true;
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-modal", "true");
      overlay.setAttribute("aria-label", "阅读模式");

      const top = document.createElement("div");
      top.className = "read-mode-top";
      const close = document.createElement("button");
      close.type = "button";
      close.className = "read-mode-close";
      close.textContent = "✕ 退出阅读";
      close.addEventListener("click", closeReadingMode);
      titleNode = document.createElement("h2");
      titleNode.className = "read-mode-title";
      stepNode = document.createElement("span");
      stepNode.className = "read-mode-step";
      const tocBtn = document.createElement("button");
      tocBtn.type = "button";
      tocBtn.className = "read-mode-toc-btn";
      tocBtn.textContent = "☰ 目录";
      tocBtn.addEventListener("click", () => {
        if (!drawer) return;
        drawer.hidden = !drawer.hidden;
      });
      // 显式入口：桌面端不像手机那样下意识「点一下」，给个按钮
      const immBtn = document.createElement("button");
      immBtn.type = "button";
      immBtn.className = "read-mode-toc-btn";
      immBtn.textContent = "⤢ 沉浸";
      immBtn.title = "隐藏顶栏/底栏，只留正文（点正文可来回切换）";
      immBtn.addEventListener("click", () => setImmersive(true));
      top.append(close, titleNode, stepNode, tocBtn, immBtn);

      headHost = document.createElement("div");
      headHost.className = "read-mode-tools";

      drawer = document.createElement("div");
      drawer.className = "read-mode-drawer";
      drawer.hidden = true;

      host = document.createElement("div");
      host.className = "read-mode-body";

      const nav = document.createElement("div");
      nav.className = "read-mode-nav";
      const prev = document.createElement("button");
      prev.type = "button";
      prev.className = "read-mode-step-btn";
      prev.textContent = "← 上一章";
      prev.addEventListener("click", () => onPrev && onPrev());
      const next = document.createElement("button");
      next.type = "button";
      next.className = "read-mode-step-btn";
      next.textContent = "下一章 →";
      next.addEventListener("click", () => onNext && onNext());
      nav.append(prev, next);

      overlay.append(top, drawer, headHost, host, nav);
      overlay.addEventListener("click", (event) => { if (event.target === overlay) setImmersive(false); });
      // 点正文区域（不含工具栏/目录/按钮/链接）= 切换沉浸；图片点击仍走自己的逻辑
      host.addEventListener("click", (event) => {
        if (event.target.closest("button, a, .read-mode-drawer, .read-mode-top, .read-mode-nav, .read-mode-tools")) return;
        toggleImmersive();
      });
      document.body.appendChild(overlay);
    }

    function ensure() { if (!overlay) build(); return overlay; }

    function mount({ title, step, content, tools, chapters, activeId, onPick, prev, next }) {
      ensure();
      titleNode.textContent = title || "";
      stepNode.textContent = step || "";
      onPrev = prev || null;
      onNext = next || null;
      headHost.textContent = "";
      if (tools) headHost.appendChild(tools);

      // 目录抽屉：只列这本书的章节，点一下直接跳
      drawer.textContent = "";
      if (chapters && chapters.length) {
        const head = document.createElement("div");
        head.className = "read-mode-drawer-head";
        head.textContent = `目录 · 共 ${chapters.length} 章`;
        drawer.appendChild(head);
        const grid = document.createElement("div");
        grid.className = "read-mode-drawer-grid";
        chapters.forEach((chapter, index) => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "read-mode-drawer-item";
          if (chapter.id === activeId) btn.classList.add("is-current");
          btn.textContent = `${index + 1}. ${chapter.title}`;
          btn.addEventListener("click", () => { drawer.hidden = true; onPick && onPick(chapter, index); });
          grid.appendChild(btn);
        });
        drawer.appendChild(grid);
        drawer.hidden = true;
      }

      host.textContent = "";
      host.appendChild(content);
      host.scrollTop = 0;
      overlay.hidden = false;
      setImmersive(false); // 每次进/换章都先显示工具栏，避免一片空白不知道能点什么
      document.body.classList.add("no-scroll");
      window.scrollTo({ top: 0 });
    }

    function closeReadingMode() {
      if (!overlay) return;
      overlay.hidden = true;
      setImmersive(false);
      document.body.classList.remove("no-scroll");
      onPrev = onNext = null;
    }

    return { mountReadingMode: mount, closeReadingMode, isReadingModeOpen: () => !!overlay && !overlay.hidden };
  })();

  // Esc 退出阅读模式（比找 ✕ 按钮顺手）；用捕获阶段，避免被其它键盘逻辑吞掉。
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const overlay = document.querySelector(".read-mode");
    if (overlay && !overlay.hidden) {
      event.preventDefault();
      closeReadingMode();
    }
  }, true);

  /* 当前正在读的内容上下文：给 ← / → 翻章用。
   * 内嵌阅读和沉浸模式都会登记，退出目录/关闭观看区时清掉，避免误翻。 */
  let readingContext = null;

  document.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const target = event.target;
    // 正在搜索框/输入框里打字时不要抢方向键
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
    const ctx = readingContext;
    if (!ctx || !ctx.chapters?.length) return;
    const next = ctx.index + (event.key === "ArrowLeft" ? -1 : 1);
    if (next < 0 || next >= ctx.chapters.length) return;
    event.preventDefault();
    ctx.go(next);
  });

  /** 把 blocks 渲染成阅读用的正文节点（小说/漫画共用）。 */
  function renderNovelBlocks(blocks, className = "watch-reader") {
    const reader = document.createElement("div");
    reader.className = className;
    (blocks || []).forEach((block) => {
      if (block.type === "image") {
        // 小说插图 / 漫画页：百分比进度，100% 或失败才完整展示（失败可点击重试）。
        // lazy=视口附近才拉，省流量；worker asset 带 ACAO，能走流式精确百分比。
        reader.appendChild(loadImageWithProgress(watchMediaUrl(block.src), {
          alt: "",
          wrapClass: "img-progress-wrap reader-image",
          lazy: true,
          retryOnFail: true,
        }));
      } else if (block.text) {
        const paragraph = document.createElement("p");
        paragraph.textContent = block.text;
        reader.appendChild(paragraph);
      }
    });
    return reader;
  }

  /**
   * 渲染某一章正文（内嵌阅读 + 沉浸模式共用同一份实现）。
   * immersive=true 时进全屏阅读模式：只留这本书的正文、上下章和目录抽屉。
   */
  async function showNovelChapter(item, body, requestId, chapters, index, immersive = false) {
    const chapter = chapters[index];
    if (!chapter) return;
    if (!immersive) body.innerHTML = '<p class="watch-loading">正在读取正文…</p>';
    
    // 获取语言偏好（简体/繁体），默认简体
    let lang = watchReadStore(READ_KEYS.novelLang, "simplified");
    
    let data;
    try {
      // 添加 lang 参数
      data = await watchApi(`/api/watch/novel?action=chapter&novel=${encodeURIComponent(item.id)}&chapter=${encodeURIComponent(chapter.id)}&lang=${encodeURIComponent(lang)}`);
    } catch (error) {
      if (watchViewCurrent(requestId)) watchError(body, "阅读失败", error, () => openWatchNovel(item, body, requestId));
      return;
    }
    if (!watchViewCurrent(requestId) && !immersive) return;

    const title = data.title || chapter.title;
    const chapterTitle = `${item.title || ""} · ${title}`;
    saveWatchProgress("novel", item, chapter, index);

    // 章节内分页（源站一章多页时 data.pages > 1）
    const totalPages = data.pages || 1;
    const allBlocks = data.blocks || [];
    // 每页大约均分：按 30 段/页切分
    const pageSize = 30;
    const pageBlocks = [];
    for (let i = 0; i < allBlocks.length; i += pageSize) {
      pageBlocks.push(allBlocks.slice(i, i + pageSize));
    }
    // 若 API 返回了真实页数，优先用真实页数做均分
    if (totalPages > 1 && pageBlocks.length !== totalPages) {
      const perPage = Math.ceil(allBlocks.length / totalPages);
      pageBlocks.length = 0;
      for (let i = 0; i < allBlocks.length; i += perPage) {
        pageBlocks.push(allBlocks.slice(i, i + perPage));
      }
    }
    const hasPages = pageBlocks.length > 1;
    let chapterPage = 0;

    const reader = renderNovelBlocks(hasPages ? pageBlocks[0] : allBlocks);
    let toolsEl = watchNovelTools(reader, lang, (newLang) => {
      if (newLang === lang) return;
      lang = newLang;
      // 切换语言后重新加载当前章节
      showNovelChapter(item, body, requestId, chapters, index, immersive);
    });

    let pageInfoEl = null, topPrevBtn = null, topNextBtn = null;
    let tailInfoEl = null, tailPrevBtn = null, tailNextBtn = null;
    // 沉浸模式下的页内翻页按钮
    let immersivePrevBtn = null, immersiveNextBtn = null;

    const refreshPageControls = () => {
      const label = `第 ${chapterPage + 1} / ${pageBlocks.length} 页`;
      if (pageInfoEl) pageInfoEl.textContent = label;
      if (tailInfoEl) tailInfoEl.textContent = label;
      const atFirst = chapterPage <= 0;
      const atLast = chapterPage >= pageBlocks.length - 1;
      for (const btn of [topPrevBtn, topNextBtn, tailPrevBtn, tailNextBtn]) {
        if (btn) {
          if (btn === topPrevBtn || btn === tailPrevBtn) btn.disabled = atFirst;
          else btn.disabled = atLast;
        }
      }
      // 同步沉浸模式的页内翻页按钮
      if (immersivePrevBtn) immersivePrevBtn.disabled = atFirst;
      if (immersiveNextBtn) immersiveNextBtn.disabled = atLast;
    };

    const goPage = (delta) => {
      const np = chapterPage + delta;
      if (np < 0 || np >= pageBlocks.length) return;
      chapterPage = np;
      const curBlocks = pageBlocks[chapterPage] || [];
      const newReader = renderNovelBlocks(curBlocks);
      const newTools = watchNovelTools(newReader, lang, (newLang) => {
        if (newLang === lang) return;
        lang = newLang;
        showNovelChapter(item, body, requestId, chapters, index, immersive);
      });
      toolsEl.replaceWith(newTools);
      reader.replaceChildren(...newReader.children);
      // 沉浸模式下翻页后，重新追加页内翻页按钮
      if (immersivePrevBtn && immersiveNextBtn) {
        const pageBar = createImmersivePageControls();
        if (pageBar) {
          const target = newTools.querySelector('.watch-read-tools') || newTools;
          target.appendChild(pageBar);
        }
      }
      // 翻页后滚动到正文顶部。内嵌模式滚动页面，沉浸模式滚动 .read-mode-body
      requestAnimationFrame(() => {
        if (immersive) {
          const scrollContainer = document.querySelector(".read-mode-body");
          if (scrollContainer) scrollContainer.scrollTop = 0;
        } else {
          body.scrollIntoView({ block: "start" });
        }
      });
      refreshPageControls();
      const stepNode = document.querySelector('.read-mode-step');
      if (stepNode) stepNode.textContent = `第 ${index + 1} / ${chapters.length} 章 · 第 ${chapterPage + 1} / ${pageBlocks.length} 页`;
      toolsEl = newTools;
    };

    // 创建沉浸模式的页内翻页按钮（仅在 hasPages 时）
    const createImmersivePageControls = () => {
      if (!hasPages) return null;
      const bar = document.createElement("div");
      bar.className = "watch-read-tools";
      immersivePrevBtn = watchButton("‹ 上页", () => goPage(-1), "watch-tool-btn");
      immersivePrevBtn.disabled = true;
      immersiveNextBtn = watchButton("下页 ›", () => goPage(1), "watch-tool-btn");
      bar.append(immersivePrevBtn, immersiveNextBtn);
      return bar;
    };

    // 沉浸模式：内容已是同一份 reader/tools，直接挂进全屏壳，切章不丢偏好
    const stepInto = (nextIndex) => {
      if (nextIndex < 0 || nextIndex >= chapters.length) return;
      showNovelChapter(item, body, requestId, chapters, nextIndex, true);
    };
    const enterMode = () => showNovelChapter(item, body, requestId, chapters, index, true);
    // 登记给 ← / → 用：不论内嵌还是沉浸模式，方向键都能翻章
    readingContext = { chapters, index, go: (n) => showNovelChapter(item, body, requestId, chapters, n, immersive) };

    if (immersive) {
      $(`[data-watch-viewer-title]`).textContent = chapterTitle;
      document.title = `${title} - ${item.title || "墨小说漫画"}`;
      // 沉浸模式下的页内翻页按钮
      if (hasPages) {
        const pageBar = createImmersivePageControls();
        if (pageBar) {
          // 将页内翻页按钮追加到工具栏
          const existingTools = toolsEl.querySelector('.watch-read-tools');
          if (existingTools) {
            existingTools.appendChild(pageBar);
          } else {
            toolsEl.appendChild(pageBar);
          }
        }
      }
      mountReadingMode({
        title: chapterTitle,
        step: hasPages
          ? `第 ${index + 1} / ${chapters.length} 章 · 第 ${chapterPage + 1} / ${pageBlocks.length} 页`
          : `第 ${index + 1} / ${chapters.length} 章`,
        content: reader,
        tools: toolsEl,
        chapters,
        activeId: chapter.id,
        onPick: (picked) => {
          const at = chapters.findIndex((c) => c.id === picked.id);
          if (at >= 0) { chapterPage = 0; stepInto(at); }
        },
        prev: index > 0 ? () => stepInto(index - 1) : null,
        next: index < chapters.length - 1 ? () => stepInto(index + 1) : null,
      });
      return;
    }

    $(`[data-watch-viewer-title]`).textContent = title;
    // 内嵌阅读：章节内翻页 + 目录/阅读模式/章间翻页 + 下载
    const bar = document.createElement("div");
    bar.className = "watch-action-bar";
    bar.appendChild(watchButton("← 返回目录", () => openWatchNovel(item, body, requestId), "watch-inline-back"));

    // 章节内分页控制器（只有一章多页时显示）
    if (hasPages) {
      pageInfoEl = document.createElement("span");
      pageInfoEl.className = "watch-page-info";
      pageInfoEl.textContent = `第 ${chapterPage + 1} / ${pageBlocks.length} 页`;
      bar.appendChild(pageInfoEl);

      topPrevBtn = watchButton("‹ 上页", () => goPage(-1), "watch-download");
      topPrevBtn.disabled = chapterPage <= 0;
      bar.appendChild(topPrevBtn);

      topNextBtn = watchButton("下页 ›", () => goPage(1), "watch-download");
      topNextBtn.disabled = chapterPage >= pageBlocks.length - 1;
      bar.appendChild(topNextBtn);
    }

    bar.appendChild(watchButton("📖 阅读模式", () => enterMode(), "watch-download"));
    if (index > 0) bar.appendChild(watchButton("← 上一章", () => showNovelChapter(item, body, requestId, chapters, index - 1), "watch-download"));
    if (index < chapters.length - 1) bar.appendChild(watchButton("下一章 →", () => showNovelChapter(item, body, requestId, chapters, index + 1), "watch-download"));
    const download = watchButton("下载本章", null, "watch-download");
    download.addEventListener("click", () => downloadNovelChapterView(item, chapter, data, download));
    bar.appendChild(download);

    body.replaceChildren(bar, toolsEl, reader);

    // 正文底部再放一组切章按钮，读完不用滚回去
    const tail = document.createElement("div");
    tail.className = "watch-action-bar watch-chapter-tail";
    // 底部也添加章节内分页（与顶部通过 goPage 共享变量，自动同步）
    if (hasPages) {
      tailInfoEl = document.createElement("span");
      tailInfoEl.className = "watch-page-info";
      tailInfoEl.textContent = `第 ${chapterPage + 1} / ${pageBlocks.length} 页`;
      tail.appendChild(tailInfoEl);

      tailPrevBtn = watchButton("‹ 上页", () => goPage(-1), "watch-download");
      tailPrevBtn.disabled = chapterPage <= 0;
      tail.appendChild(tailPrevBtn);

      tailNextBtn = watchButton("下页 ›", () => goPage(1), "watch-download");
      tailNextBtn.disabled = chapterPage >= pageBlocks.length - 1;
      tail.appendChild(tailNextBtn);
    }
    if (index > 0) tail.appendChild(watchButton("← 上一章", () => showNovelChapter(item, body, requestId, chapters, index - 1), "watch-download"));
    if (index < chapters.length - 1) tail.appendChild(watchButton("下一章 →", () => showNovelChapter(item, body, requestId, chapters, index + 1), "watch-download"));
    if (tail.children.length) body.appendChild(tail);
    body.scrollIntoView({ block: "start" });
  }

  async function openWatchNovel(item, body, requestId) {
    try {
      const detail = await watchApi(`/api/watch/novel?action=detail&novel=${encodeURIComponent(item.id)}`);
      if (!watchViewCurrent(requestId)) return;
      $(`[data-watch-viewer-title]`).textContent = detail.title || item.title;
      body.textContent = "";
      if (detail.description) {
        const description = document.createElement("p");
        description.className = "watch-description";
        description.textContent = detail.description;
        body.appendChild(description);
      }

      const chapters = detail.chapters || [];

      // 个别条目在上游已经下架或换镜像（列表里还挂着，正文却是空的）。
      // 这种情况直接给一句人话 + 重试，比留一张只有标题的空目录好。
      if (!chapters.length) {
        renderWatchMessage(body, "这个条目在上游取不到目录，可能已下架或换了镜像。", {
          label: "重新获取", run: () => openWatchNovel(item, body, requestId),
        });
        return;
      }

      // 目录工具栏：章节数 + 一键下载全本（逐章抓正文后打包成 txt）。
      const tools = document.createElement("div");
      tools.className = "watch-dir-tools";
      const count = document.createElement("span");
      count.className = "watch-dir-count";
      count.textContent = `共 ${chapters.length} 章`;
      tools.appendChild(count);
      if (chapters.length) {
        tools.appendChild(watchButton(`下载全本（${chapters.length} 章）`, async (event) => {
          const button = event.currentTarget;
          const original = button.textContent;
          button.disabled = true;
          const texts = [];
          try {
            for (let i = 0; i < chapters.length; i++) {
              button.textContent = `抓取正文 ${i + 1}/${chapters.length}…`;
              const data = await watchApi(
                `/api/watch/novel?action=chapter&novel=${encodeURIComponent(item.id)}&chapter=${encodeURIComponent(chapters[i].id)}`
              );
              texts.push({
                title: chapters[i].title,
                text: (data.blocks || [])
                  .map((block) => (block.type === "image" ? `[图片] ${block.src}` : block.text))
                  .join("\n\n"),
              });
            }
            button.textContent = "打包中…";
            const full = watchNovelText({ ...detail, chapters: texts }, item);
            watchSaveBlob(
              new Blob([full], { type: "text/plain;charset=utf-8" }),
              watchDownloadName(item, ` 全本 ${chapters.length}章.txt`)
            );
            button.textContent = "已下载";
          } catch (error) {
            button.textContent = "失败";
            watchStatus(`下载失败：${error.message}`, true);
          } finally {
            button.disabled = false;
            setTimeout(() => { button.textContent = original; }, 1800);
          }
        }, "watch-download"));
      }
      body.appendChild(tools);

      // 「继续阅读」：这本书上次读到哪一章。
      // 匹配顺序 = partId（权威，两边都 String() 归一化，上游数字/字符串混返都不会误判）
      //          → partIndex（下标兜底，要求下标处标题也对得上，防章节表变动后跳错）
      //          → partTitle（老记录兜底：早期版本没存下标，partId 也可能为空）。
      const saved = watchProgress().novel;
      let resumeAt = -1;
      if (saved && String(saved.id) === String(item.id) && chapters.length) {
        const sameId = (a, b) => a != null && b != null && String(a) === String(b);
        if (saved.partId) {
          const byId = chapters.findIndex((c) => sameId(c.id, saved.partId));
          if (byId >= 0) resumeAt = byId;
        }
        if (resumeAt < 0
            && Number.isInteger(saved.partIndex)
            && saved.partIndex >= 0 && saved.partIndex < chapters.length) {
          const at = chapters[saved.partIndex];
          if (!saved.partTitle || String(at.title) === String(saved.partTitle)) resumeAt = saved.partIndex;
        }
        if (resumeAt < 0 && saved.partTitle) {
          const byTitle = chapters.findIndex((c) => String(c.title) === String(saved.partTitle));
          if (byTitle >= 0) resumeAt = byTitle;
        }
      }
      if (resumeAt >= 0) {
        const resume = document.createElement("div");
        resume.className = "watch-resume";
        const text = document.createElement("span");
        text.className = "watch-resume-text";
        text.textContent = `上次读到 第 ${resumeAt + 1} 章「${chapters[resumeAt].title}」`;
        const go = watchButton("继续阅读 →", () => showNovelChapter(item, body, requestId, chapters, resumeAt), "watch-resume-btn");
        resume.append(text, go);
        body.appendChild(resume);
      }

      // 目录按「卷 / 章节」分列，避免几百章挤成一坨。
      const list = document.createElement("div");
      list.className = "watch-chapter-list";
      chapters.forEach((chapter, index) => {
        const row = document.createElement("div");
        row.className = "watch-chapter-row";
        if (index === resumeAt) row.classList.add("is-current");

        const open = document.createElement("button");
        open.type = "button";
        open.className = "watch-chapter-open";
        const order = document.createElement("span");
        order.className = "watch-chapter-index";
        order.textContent = String(index + 1);
        const name = document.createElement("span");
        name.className = "watch-chapter-name";
        name.textContent = chapter.title;
        open.append(order, name);
        open.addEventListener("click", async () => {
          await showNovelChapter(item, body, requestId, chapters, index);
        });

        const save = watchButton("下载", null, "watch-chapter-download");
        save.addEventListener("click", () => downloadNovelChapter(item, chapter, save));

        row.append(open, save);
        list.appendChild(row);
      });
      body.appendChild(list);
    } catch (error) {
      if (watchViewCurrent(requestId)) watchError(body, "目录加载失败", error, () => openWatchItem(item));
    }
  }

  /**
   * 渲染某一话漫画（内嵌 + 沉浸模式共用）。
   * ctx 带上出详情那条线的 source/remoteId/apiHost，换线才不会撞 id。
   */
  async function showMangaChapter(item, body, requestId, chapters, index, ctx, immersive = false) {
    const chapter = chapters[index];
    if (!chapter) return;
    if (!immersive) body.innerHTML = '<p class="watch-loading">正在读取漫画…</p>';
    const params = new URLSearchParams({ action: "chapter", comic: item.id, chapter: chapter.id });
    if (ctx.effectiveSource) params.set("source", ctx.effectiveSource);
    if (ctx.remoteId) params.set("remoteId", ctx.remoteId);
    if (ctx.apiHost) params.set("apiHost", ctx.apiHost);

    let data;
    try {
      data = await watchApi(`/api/watch/manga?${params}`);
    } catch (error) {
      if (watchViewCurrent(requestId)) watchError(body, "漫画加载失败", error, () => openWatchManga(item, body, requestId));
      return;
    }
    if (!watchViewCurrent(requestId) && !immersive) return;

    const images = data.images || [];
    const reader = document.createElement("div");
    reader.className = "watch-manga-reader";
    images.forEach((src, i) => {
      const image = document.createElement("img");
      image.src = watchMediaUrl(src);
      image.alt = `${chapter.title} 第 ${i + 1} 页`;
      image.loading = i < 2 ? "eager" : "lazy";
      image.decoding = "async";
      image.referrerPolicy = "no-referrer";
      reader.appendChild(image);
    });
    saveWatchProgress("manga", item, chapter, index);
    const tools = watchMangaTools(reader);
    const chapterTitle = `${item.title || ""} · ${chapter.title}`;
    const stepInto = (n) => {
      if (n < 0 || n >= chapters.length) return;
      showMangaChapter(item, body, requestId, chapters, n, ctx, true);
    };
    readingContext = { chapters, index, go: (n) => showMangaChapter(item, body, requestId, chapters, n, ctx, immersive) };

    if (immersive) {
      $(`[data-watch-viewer-title]`).textContent = chapterTitle;
      document.title = `${chapter.title} - ${item.title || "墨小说漫画"}`;
      mountReadingMode({
        title: chapterTitle,
        step: `第 ${index + 1} / ${chapters.length} 话 · ${images.length} 页`,
        content: reader,
        tools,
        chapters,
        activeId: chapter.id,
        onPick: (picked) => {
          const at = chapters.findIndex((c) => c.id === picked.id);
          if (at >= 0) stepInto(at);
        },
        prev: index > 0 ? () => stepInto(index - 1) : null,
        next: index < chapters.length - 1 ? () => stepInto(index + 1) : null,
      });
      return;
    }

    const bar = document.createElement("div");
    bar.className = "watch-action-bar";
    bar.appendChild(watchButton("← 返回目录", () => openWatchManga(item, body, requestId), "watch-inline-back"));
    bar.appendChild(watchButton("📖 阅读模式", () => showMangaChapter(item, body, requestId, chapters, index, ctx, true), "watch-download"));
    if (index > 0) bar.appendChild(watchButton("← 上一话", () => showMangaChapter(item, body, requestId, chapters, index - 1, ctx), "watch-download"));
    if (index < chapters.length - 1) bar.appendChild(watchButton("下一话 →", () => showMangaChapter(item, body, requestId, chapters, index + 1, ctx), "watch-download"));
    const download = watchButton(`下载本话（${images.length} 张）`, null, "watch-download");
    download.addEventListener("click", async () => {
      const original = download.textContent;
      download.disabled = true;
      try {
        const files = await watchDownloadImages(images, item, (text) => { download.textContent = text; });
        download.textContent = "打包中…";
        const blob = await watchPackZip(files);
        watchSaveBlob(blob, watchDownloadName({ title: `${item.title} ${chapter.title}` }, ".zip"));
        download.textContent = "已下载";
      } catch (error) {
        download.textContent = "失败";
        watchStatus(`下载失败：${error.message}`, true);
      } finally {
        download.disabled = false;
        setTimeout(() => { download.textContent = original; }, 1800);
      }
    });
    bar.appendChild(download);
    body.replaceChildren(bar, tools, reader);

    const tail = document.createElement("div");
    tail.className = "watch-action-bar watch-chapter-tail";
    if (index > 0) tail.appendChild(watchButton("← 上一话", () => showMangaChapter(item, body, requestId, chapters, index - 1, ctx), "watch-download"));
    if (index < chapters.length - 1) tail.appendChild(watchButton("下一话 →", () => showMangaChapter(item, body, requestId, chapters, index + 1, ctx), "watch-download"));
    if (tail.children.length) body.appendChild(tail);
    body.scrollIntoView({ block: "start" });
  }

  async function openWatchManga(item, body, requestId) {
    try {
      const source = currentSource();
      const params = new URLSearchParams({ action: "detail", comic: item.id });
      if (source) params.set("source", source);
      const detail = await watchApi(`/api/watch/manga?${params}`);
      if (!watchViewCurrent(requestId)) return;
      $(`[data-watch-viewer-title]`).textContent = detail.title || item.title;
      body.textContent = "";

      // GMH 这类源取章节图要带上远端漫画 ID 和接口域名，详情接口会一起返回。
      const remoteId = detail.remoteId || "";
      const apiHost = detail.apiHost || "";
      // 章节固定用「出详情的那条线」：自动模式下各源 id 体系不同，
      // 换线去查同一个 id 可能撞到另一部漫画。
      const effectiveSource = detail.source || source;

      const meta = document.createElement("p");
      meta.className = "watch-source-line";
      // 自动模式下用实际出内容的那条线，而不是「自动」两个字。
      const shownSource = detail.sourceLabel || sourceLabel();
      meta.textContent = `当前线路：${shownSource}${detail.description ? ` · ${detail.description}` : ""}`;
      body.appendChild(meta);

      const mangaChapters = detail.chapters || [];
      const mangaCtx = { effectiveSource, remoteId, apiHost };
      // 「继续阅读」：和小说同一套匹配顺序（partId → partIndex → partTitle），
      // 类型一律 String() 归一化，避免数字/字符串 id 比较误判导致整条不出现。
      const savedManga = watchProgress().manga;
      let mangaResumeAt = -1;
      if (savedManga && String(savedManga.id) === String(item.id) && mangaChapters.length) {
        const sameId = (a, b) => a != null && b != null && String(a) === String(b);
        if (savedManga.partId) {
          const byId = mangaChapters.findIndex((c) => sameId(c.id, savedManga.partId));
          if (byId >= 0) mangaResumeAt = byId;
        }
        if (mangaResumeAt < 0
            && Number.isInteger(savedManga.partIndex)
            && savedManga.partIndex >= 0 && savedManga.partIndex < mangaChapters.length) {
          const at = mangaChapters[savedManga.partIndex];
          if (!savedManga.partTitle || String(at.title) === String(savedManga.partTitle)) mangaResumeAt = savedManga.partIndex;
        }
        if (mangaResumeAt < 0 && savedManga.partTitle) {
          const byTitle = mangaChapters.findIndex((c) => String(c.title) === String(savedManga.partTitle));
          if (byTitle >= 0) mangaResumeAt = byTitle;
        }
      }
      if (mangaResumeAt >= 0) {
        const resume = document.createElement("div");
        resume.className = "watch-resume";
        const text = document.createElement("span");
        text.className = "watch-resume-text";
        text.textContent = `上次看到「${mangaChapters[mangaResumeAt].title}」`;
        resume.append(text, watchButton("继续阅读 →", () =>
          showMangaChapter(item, body, requestId, mangaChapters, mangaResumeAt, mangaCtx, false), "watch-resume-btn"));
        body.appendChild(resume);
      }

      const chapters = document.createElement("div");
      chapters.className = "watch-chapters";
      mangaChapters.forEach((chapter, chapterIndex) => {
        const btn = watchButton(chapter.title, async () => {
          await showMangaChapter(item, body, requestId, mangaChapters, chapterIndex, mangaCtx, false);
        });
        if (chapterIndex === mangaResumeAt) btn.classList.add("is-current");
        chapters.appendChild(btn);
      });
      body.appendChild(chapters);
      if (!detail.chapters?.length) {
        renderWatchMessage(body, source
          ? "这条线路没有返回章节，换一条线路再试。"
          : "当前线路没有返回章节，请稍后刷新。");
      }
    } catch (error) {
      if (watchViewCurrent(requestId)) watchError(body, "目录加载失败", error, () => openWatchItem(item));
    }
  }

  /* 动画播放器：hls.js（vendor 本地）直连 m3u8，桌面 Chrome/Firefox 用 MSE，
     iOS Safari 用原生 HLS。流 CDN ACAO=*，无需代理。 */
  function watchMountVideo(container, srcUrl, onError) {
    const video = document.createElement("video");
    video.className = "watch-player watch-video";
    video.controls = true;
    video.playsInline = true;
    video.preload = "metadata";
    let hls = null;
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = srcUrl; // Safari/iOS 原生 HLS
    } else if (window.Hls && window.Hls.isSupported()) {
      hls = new Hls({ maxBufferLength: 24, manifestLoadingTimeOut: 20000, fragLoadingMaxRetry: 4 });
      hls.loadSource(srcUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (!data?.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && data.details !== "manifestLoadError") {
          hls.startLoad(); // 网络抖动自动重试
          return;
        }
        onError?.();
      });
    } else {
      video.src = srcUrl; // 极老浏览器最后兜底
    }
    container.replaceChildren(video);
    const p = video.play();
    if (p && p.catch) p.catch(() => {});
    return video;
  }

  async function openWatchAnime(item, body, requestId) {
    try {
      const detail = await watchApi(`/api/watch/anime?action=detail&anime=${encodeURIComponent(item.id)}`);
      if (!watchViewCurrent(requestId)) return;
      $(`[data-watch-viewer-title]`).textContent = detail.title || item.title;
      body.textContent = "";
      const lines = (detail.lines || []).filter((line) => line.eps.length);
      if (detail.description) {
        const desc = document.createElement("p");
        desc.className = "watch-description";
        desc.textContent = detail.description;
        body.appendChild(desc);
      }
      if (!lines.length) {
        const link = document.createElement("a");
        link.className = "watch-download";
        link.href = `${detail.sourceSite || "https://www.lmm85.com"}/detail/${item.id}.html`;
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = "到原站播放 →";
        const tip = document.createElement("p");
        tip.className = "watch-source-line";
        tip.textContent = "资源站这会儿没给出可播放的线路（m3u8），可以稍后重试，或去原站看：";
        body.append(tip, link);
        return;
      }

      // 播放状态：线路 / 集下标，播放器与选集共用。
      const cur = { li: 0, ei: 0, video: null };
      // 全屏视频模式状态：overlay 是否已搭好 / 控件是否收起 / 选集抽屉是否打开 / 计时是否在跑。
      const vm = { open: false, controlsDown: false, drawerOpen: false, timer: null };
      const status = document.createElement("p");
      status.className = "watch-loading";
      status.hidden = true;

      const lineRow = document.createElement("div");
      lineRow.className = "watch-line-row";
      const lineLabel = document.createElement("span");
      lineLabel.className = "watch-source-line";
      lineLabel.textContent = "线路";
      const lineBtns = lines.map((line, li) => {
        const label = line.source ? `${line.source} · ${line.label}` : line.label;
        const btn = watchButton(label, () => playEp(li, 0), "watch-line-btn");
        lineRow.append(btn);
        return btn;
      });
      lineRow.prepend(lineLabel);
      if (lines.length > 1) body.appendChild(lineRow);

      const eps = document.createElement("div");
      eps.className = "watch-chapters";
      const epBtns = [];
      function renderEps() {
        eps.textContent = "";
        epBtns.length = 0;
        (lines[cur.li].eps).forEach((episode, ei) => {
          const btn = watchButton(episode.ep, () => playEp(cur.li, ei), "watch-chapter-open");
          epBtns.push(btn);
          eps.appendChild(btn);
        });
        syncEpsActive();
      }
      function syncEpsActive() {
        epBtns.forEach((btn, i) => btn.classList.toggle("is-current", i === cur.ei));
        lineBtns.forEach((btn, i) => btn.classList.toggle("is-current", i === cur.li));
      }

      // 自动切换：当前线路失败时，尝试下一条线路（不依赖用户手动切换）。
      function tryNextLine() {
        if (lines.length <= 1) return;
        const nextLi = (cur.li + 1) % lines.length;
        if (nextLi === cur.li) return; // 已经试完所有线路
        const nextEp = lines[nextLi].eps[cur.ei];
        if (!nextEp) return;
        status.textContent = `${lines[cur.li].source || lines[cur.li].label} 不可用，自动切换到 ${lines[nextLi].source || lines[nextLi].label}…`;
        cur.li = nextLi;
        playEp(nextLi, cur.ei);
      }
      function playEp(li, ei) {
        cur.li = li; cur.ei = ei;
        const ep = lines[li].eps[ei];
        syncEpsActive();
        body.querySelectorAll("video").forEach((v) => v.pause());
        status.hidden = false;
        status.textContent = "正在连接视频流…";
        const video = watchMountVideo(vm.open ? vmStage : playerWrap, ep.url, () => {
          tryNextLine();
        });
        video.addEventListener("playing", () => { status.hidden = true; });
        video.addEventListener("error", () => {
          tryNextLine();
        });
        saveWatchProgress("anime", item, { title: ep.ep });
        cur.video = video;
        syncVideoMode(li, ei);
        $(`[data-watch-viewer-title]`).textContent = `${detail.title || item.title} · ${ep.ep}`;
        prevBtn.disabled = ei <= 0;
        nextBtn.disabled = ei >= lines[li].eps.length - 1;
        prevBtn.onclick = () => playEp(li, ei - 1);
        nextBtn.onclick = () => playEp(li, ei + 1);
      }

      /* ---------- 全屏视频模式 ----------
         把当前视频搬进一个全屏 overlay，顶栏显示标题与集数，底栏是进度/时间 + 前进后退
         (5s/30s/1m/10m)，选集抽屉可开合。点视频本体隐藏/唤出功能栏，沉浸式观看。 */
      const vmOverlay = document.createElement("div");
      vmOverlay.className = "anime-vm";
      vmOverlay.hidden = true;
      const vmTop = document.createElement("div");
      vmTop.className = "anime-vm-top";
      const vmClose = document.createElement("button");
      vmClose.type = "button";
      vmClose.className = "anime-vm-btn";
      vmClose.textContent = "✕ 退出";
      const vmTitle = document.createElement("span");
      vmTitle.className = "anime-vm-title";
      const vmEpRow = document.createElement("span");
      vmEpRow.className = "anime-vm-ep";
      const vmDrawerBtn = document.createElement("button");
      vmDrawerBtn.type = "button";
      vmDrawerBtn.className = "anime-vm-btn";
      vmDrawerBtn.textContent = "选集 ▾";
      vmTop.append(vmClose, vmTitle, vmEpRow, vmDrawerBtn);
      const vmStage = document.createElement("div");
      vmStage.className = "anime-vm-stage";
      const vmDrawer = document.createElement("div");
      vmDrawer.className = "anime-vm-drawer";
      vmDrawer.hidden = true;
      const vmBottom = document.createElement("div");
      vmBottom.className = "anime-vm-bar";
      const vmProgress = document.createElement("div");
      vmProgress.className = "anime-vm-progress";
      const vmFill = document.createElement("div");
      vmFill.className = "anime-vm-progress-fill";
      vmProgress.appendChild(vmFill);
      const vmSeekRow = document.createElement("div");
      vmSeekRow.className = "anime-vm-seek";
      const vmTime = document.createElement("span");
      vmTime.className = "anime-vm-time";
      const vmPlayBtn = document.createElement("button");
      vmPlayBtn.type = "button";
      vmPlayBtn.className = "anime-vm-btn anime-vm-play";
      vmPlayBtn.textContent = "⏸";
      const buildSeekBtn = (label, delta) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "anime-vm-btn anime-vm-seekbtn";
        b.textContent = label;
        b.addEventListener("click", () => seekBy(delta));
        return b;
      };
      vmSeekRow.append(
        buildSeekBtn("-10m", -600), buildSeekBtn("-1m", -60), buildSeekBtn("-30s", -30), buildSeekBtn("-5s", -5),
        vmPlayBtn,
        buildSeekBtn("+5s", 5), buildSeekBtn("+30s", 30), buildSeekBtn("+1m", 60), buildSeekBtn("+10m", 600),
        vmTime
      );
      const vmHint = document.createElement("div");
      vmHint.className = "anime-vm-hint";
      vmHint.hidden = true;
      vmBottom.append(vmProgress, vmSeekRow);
      vmOverlay.append(vmTop, vmStage, vmDrawer, vmBottom, vmHint);

      // 选集抽屉：每行一个按钮，点选即切集。
      function renderVmDrawer() {
        vmDrawer.textContent = "";
        const labelRow = document.createElement("div");
        labelRow.className = "anime-vm-drawer-label";
        labelRow.textContent = "选择集数";
        vmDrawer.appendChild(labelRow);
        lines.forEach((line, li) => {
          const group = document.createElement("div");
          group.className = "anime-vm-drawer-group";
          const gl = document.createElement("div");
          gl.className = "anime-vm-drawer-line";
          gl.textContent = `${line.label} · 共 ${line.eps.length} 集`;
          group.appendChild(gl);
          const btns = document.createElement("div");
          btns.className = "anime-vm-drawer-btns";
          line.eps.forEach((episode, ei) => {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "anime-vm-epbtn";
            b.textContent = episode.ep;
            b.classList.toggle("is-current", li === cur.li && ei === cur.ei);
            b.addEventListener("click", () => { playEp(li, ei); });
            btns.appendChild(b);
          });
          group.appendChild(btns);
          vmDrawer.appendChild(group);
        });
      }

      // 焦点时间同步 / 时间显示格式化。
      const fmtTime = (s) => {
        if (!isFinite(s) || s < 0) s = 0;
        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
        const mm = h ? String(m).padStart(2, "0") : String(m);
        return (h ? h + ":" : "") + mm + ":" + String(sec).padStart(2, "0");
      };
      function tickVm() {
        const v = cur.video;
        if (!v) return;
        if (v.duration && isFinite(v.duration)) {
          vmFill.style.width = Math.min(100, (v.currentTime / v.duration) * 100) + "%";
          vmTime.textContent = `${fmtTime(v.currentTime)} / ${fmtTime(v.duration)}`;
        }
      }
      function cycleTick() {
        tickVm();
        if (vm.open && !vmOverlay.hidden) vm.timer = requestAnimationFrame(cycleTick);
        else vm.timer = null;
      }

      // 相对跳转：5s/30s/1m/10m。
      function seekBy(delta) {
        const v = cur.video;
        if (!v || !v.duration || !isFinite(v.duration)) return;
        v.currentTime = Math.max(0, Math.min(v.duration - 0.1, v.currentTime + delta));
        showVmHint(delta >= 0 ? `+${fmtTime(delta)}` : `-${fmtTime(-delta)}`);
      }
      function togglePlay() {
        const v = cur.video;
        if (!v) return;
        if (v.paused) v.play().catch(() => {}); else v.pause();
      }
      function showVmHint(text) {
        vmHint.textContent = text;
        vmHint.hidden = false;
        clearTimeout(vmHint._t);
        vmHint._t = setTimeout(() => { vmHint.hidden = true; }, 900);
      }

      // 点视频本体：切功能栏显隐；再点一下唤出。
      function toggleVmControls() {
        vm.controlsDown = !vm.controlsDown;
        vmOverlay.classList.toggle("is-immersive", vm.controlsDown);
        showVmHint(vm.controlsDown ? "点一下唤出功能栏" : "");
      }

      // 打开/关闭全屏视频模式。
      function openVideoMode() {
        const v = cur.video;
        if (!v) return;
        vm.open = true;
        vm.controlsDown = false;
        renderVmDrawer();
        vmTitle.textContent = detail.title || item.title;
        vmEpRow.textContent = lines[cur.li].eps[cur.ei]?.ep || "";
        vmOverlay.classList.remove("is-immersive");
        if (v.parentNode && v.parentNode !== vmStage) {
          v.remove();
          vmStage.replaceChildren(v);
        }
        vmOverlay.hidden = false;
        document.body.appendChild(vmOverlay);
        document.body.classList.add("no-scroll");
        v.play().catch(() => {});
        syncVmControls();
        cycleTick();
      }
      function closeVideoMode() {
        vm.open = false;
        if (vm.timer) cancelAnimationFrame(vm.timer);
        vm.timer = null;
        vmOverlay.hidden = true;
        vmOverlay.remove();
        document.body.classList.remove("no-scroll");
        // 把视频放回正文播放器。
        const v = cur.video;
        if (v && v.parentNode === vmStage) {
          v.remove();
          playerWrap.replaceChildren(v);
          v.play().catch(() => {});
        }
      }
      vmClose.addEventListener("click", closeVideoMode);
      vmStage.addEventListener("click", toggleVmControls);
      vmPlayBtn.addEventListener("click", togglePlay);
      vmDrawerBtn.addEventListener("click", () => {
        vm.drawerOpen = !vm.drawerOpen;
        vmDrawer.hidden = !vm.drawerOpen;
        vmDrawerBtn.textContent = vm.drawerOpen ? "选集 ▴" : "选集 ▾";
      });
      // 上新集时刷新抽屉高亮 + 标题/集数，若正在全屏则直接切流。
      function syncVideoMode(li, ei) {
        const ep = lines[li]?.eps[ei];
        if (ep) {
          vmEpRow.textContent = ep.ep;
          vmTitle.textContent = detail.title || item.title;
          if (vm.open && vm.drawerOpen) renderVmDrawer();
          tickVm();
        }
      }
      function syncVmControls() { tickVm(); }

      const playerWrap = document.createElement("div");
      playerWrap.className = "watch-anime-player";
      body.appendChild(playerWrap);

      const bar = document.createElement("div");
      bar.className = "watch-action-bar";
      const prevBtn = watchButton("← 上一集", null, "watch-download");
      const nextBtn = watchButton("下一集 →", null, "watch-download");
      const fullBtn = watchButton("⛶ 视频模式", () => openVideoMode(), "watch-download watch-fullscreen-btn");
      bar.append(prevBtn, nextBtn, fullBtn);
      if (detail.sourceSite) {
        const link = document.createElement("a");
        link.className = "watch-download";
        link.href = `${detail.sourceSite}/detail/${item.id}.html`;
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = "原站打开";
        bar.appendChild(link);
      }
      body.appendChild(bar);
      body.appendChild(status);

      // 选集网格（当前线路）
      body.appendChild(eps);
      renderEps();
      // 默认从第 1 集开始播放
      playEp(0, 0);
    } catch (error) {
      if (watchViewCurrent(requestId)) watchError(body, "选集加载失败", error, () => openWatchItem(item));
    }
  }

  function closeWatchViewer() {
    state.watchViewRequest++;
    state.watchViewerOpen = false;
    readingContext = null;
    closeReadingMode();
    document.title = "墨小说漫画 · 资源导航";
    const viewer = $("[data-watch-viewer]");
    const body = $("[data-watch-viewer-body]");
    const media = body?.querySelector("audio, video");
    if (media) media.pause();
    // 关掉可能开着的全屏视频模式：清 overlay、恢复滚动。
    const vmOv = document.querySelector(".anime-vm");
    if (vmOv) {
      vmOv.remove();
      document.body.classList.remove("no-scroll");
      // 若视频正在全屏内，把它放回正文播放器位置，避免流被销毁。
      const v = vmOv.querySelector("video");
      if (v) {
        v.remove();
        const pwrap = body?.querySelector(".watch-anime-player");
        if (pwrap) pwrap.appendChild(v);
      }
    }
    if (body) body.textContent = "";
    if (viewer) viewer.hidden = true;
    if (state.section === "watch") renderWatch();
  }

  function bindWatch() {
    const form = $("[data-watch-search]");
    const input = $("[data-watch-query]");
    const runSearch = () => {
      state.watchQuery = input.value.trim();
      state.watchItems = [];
      state.watchLimit = WATCH_PAGE_SIZE;
      loadWatch({ force: true });
    };
    // 手机键盘上「搜索」是 enterkeyhint，不一定会提交表单，按键也要兜住。
    form?.addEventListener("submit", (event) => {
      event.preventDefault();
      runSearch();
    });
    input?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        runSearch();
      }
    });
    $("[data-watch-clear]")?.addEventListener("click", () => {
      input.value = "";
      state.watchQuery = "";
      state.watchItems = [];
      state.watchLimit = WATCH_PAGE_SIZE;
      loadWatch({ force: true });
    });
    $(`[data-watch-refresh]`)?.addEventListener("click", () => loadWatch({ force: true }));
    $(`[data-watch-back]`)?.addEventListener("click", closeWatchViewer);
    $("[data-watch-more-btn]")?.addEventListener("click", showMoreWatch);
    // 翻页条：上一页 / 下一页（页码指示由 updateWatchPager 维护）
    $("[data-watch-prev]")?.addEventListener("click", () => {
      const page = Math.ceil(Math.min(state.watchLimit, watchRowCount()) / WATCH_PAGE_SIZE) || 1;
      gotoWatchPage(page - 1);
    });
    $("[data-watch-next]")?.addEventListener("click", () => {
      const page = Math.ceil(Math.min(state.watchLimit, watchRowCount()) / WATCH_PAGE_SIZE) || 1;
      gotoWatchPage(page + 1);
    });
  }

  /* ---------- 成年 / 未成年模式 ---------- */

  /** 更新模式按钮的文字与状态。 */
  function renderModeUI() {
    const btn = $("[data-mode-toggle]");
    if (!btn) return;
    btn.setAttribute("aria-pressed", String(state.adultMode));
    $("[data-mode-label]").textContent = state.adultMode ? "成年模式" : "未成年模式";

    const hidden = state.items.filter((it) => it.adult).length;
    const hint = $("[data-mode-hint]");
    if (hint) {
      hint.textContent = state.adultMode
        ? ""
        : hidden
          ? `已隐藏 ${hidden} 个成人向资源`
          : "";
    }
  }

  /** 切到成年模式必须经过确认弹窗；关掉不需要确认。 */
  function bindMode() {
    const btn = $("[data-mode-toggle]");
    const dialog = $("[data-age-dialog]");
    if (!btn || !dialog) return;

    // 刻意不做持久化：每次打开页面都回到未成年模式
    btn.addEventListener("click", () => {
      if (state.adultMode) {
        state.adultMode = false;
        state.page = 1;
        renderModeUI();
        render();
        return;
      }
      dialog.hidden = false;
      $("[data-age-confirm]").focus();
    });

    $("[data-age-confirm]").addEventListener("click", () => {
      state.adultMode = true;
      state.page = 1;
      dialog.hidden = true;
      renderModeUI();
      render();
    });

    $("[data-age-cancel]").addEventListener("click", () => {
      dialog.hidden = true;
      btn.focus();
    });

    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) {
        dialog.hidden = true;
        btn.focus();
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !dialog.hidden) {
        dialog.hidden = true;
        btn.focus();
      }
    });
  }

  /** 公告里的「教程 / 问题区」跳转。 */
  function bindNoticeJump() {
    const btn = $("[data-goto-guide]");
    if (!btn) return;
    btn.addEventListener("click", () => {
      state.section = "guide";
      state.sub = "all";
      state.page = 1;
      render();
      $("#feed").scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  /** 回到顶部 / 到底部悬浮按钮。页面不够长时整体隐藏。 */
  function bindScrollDock() {
    const dock = $("[data-scroll-dock]");
    const upBtn = $("[data-scroll-top]");
    const downBtn = $("[data-scroll-bottom]");
    if (!dock || !upBtn || !downBtn) return;

    const scrollTo = (top) => window.scrollTo({ top, behavior: "smooth" });
    upBtn.addEventListener("click", () => scrollTo(0));
    downBtn.addEventListener("click", () =>
      scrollTo(document.documentElement.scrollHeight)
    );

    // 按滚动位置决定显示哪个方向，两端各留 120px 余量避免抖动
    const update = () => {
      const doc = document.documentElement;
      const scrolled = window.scrollY;
      const max = doc.scrollHeight - window.innerHeight;

      if (max < 240) {
        dock.hidden = true;
        return;
      }
      dock.hidden = false;
      upBtn.hidden = scrolled < 120;
      downBtn.hidden = scrolled > max - 120;
    };

    // 滚动事件用 rAF 节流，避免每帧重复计算
    let queued = false;
    const onScroll = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        update();
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    update();

    // 列表内容变化后页面高度会变，需要重算
    return update;
  }

  /* ---------- 事件绑定 ---------- */

  function bindControls() {
    const input = $('[data-filter="q"]');
    if (input) {
      input.addEventListener("input", () => {
        state.q = input.value.trim();
        state.page = 1; // 换搜索词回到第一页，否则可能停在空页
        render();
      });
    }
    const form = $("[data-controls]");
    if (form) form.addEventListener("submit", (e) => e.preventDefault());

    const sortSel = $('[data-filter="sort"]');
    if (sortSel) {
      sortSel.addEventListener("change", () => {
        state.sort = sortSel.value || "default";
        state.page = 1; // 换排序后原页码没有意义
        render();
      });
    }
  }

  function bindTheme() {
    const btn = $("[data-theme-toggle]");
    if (!btn) return;
    const saved = localStorage.getItem("mo-theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const apply = (theme) => {
      document.documentElement.dataset.theme = theme;
      btn.setAttribute("aria-pressed", String(theme === "dark"));
      localStorage.setItem("mo-theme", theme);
    };
    apply(saved || (prefersDark ? "dark" : "light"));
    btn.addEventListener("click", () => {
      apply(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
    });
  }

  /* ---------- 启动 ---------- */

  async function init() {
    bindTheme();
    bindControls();
    bindWatch();
    bindMode();
    bindNoticeJump();
    bindStatsPanel();
    bindWantedPanel();
    bindWantedForm();
    bindWantedPurge();
    bindWantedJump();
    stats.init();
    // 卡片渲染时要读它来决定反馈按钮是否已完成态，所以得在首次 render 之前
    reportedSet = loadReported();
    refreshScrollDock = bindScrollDock() || (() => {});
    try {
      // 覆盖层与 items.json 并行拉。覆盖层失败不影响主流程 ——
      // 顶多显示原值，比整页加载失败好。
      // 覆盖层、后台新增条目与 items.json 并行拉。后两者失败不影响主流程 ——
      // 顶多少几条 / 显示原值，比整页加载失败好。
      const [res, ovMap, customs] = await Promise.all([
        fetch(DATA_URL, { cache: "no-cache" }),
        loadOverrides(),
        loadCustomItems(),
      ]);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const payload = await res.json();
      const raw = Array.isArray(payload) ? payload : payload.items || [];
      overrides = ovMap;
      state.rawItems = raw;
      state.customItems = customs;
      rebuildItems();
      state.generatedAt = payload.generated_at || null;
      $("[data-footer-updated]").textContent = fmtDate(state.generatedAt);
      renderModeUI();
      render();
      // 远端统计后到：拉到就重渲染，拉不到保持本机数据，不影响已渲染的页面
      if (await stats.pull()) {
        stats.reportVisit();
        // 帮找依赖同一个后端，接口通了才显示这一块。
        // 只拉汇总不展开列表 —— 待找条数要显示在标题上。
        // 必须在 render() 之前拉：卡片要按 brokenReady 决定是否画失效反馈按钮。
        await loadWanted();
        render();
        renderWanted();
        refreshScrollDock();
      }
      // 后台入口：地址带 #admin 时展开登录面板
      initAdmin();
    } catch (err) {
      const feed = $("[data-feed]");
      feed.textContent = "";
      const p = document.createElement("p");
      p.className = "load-error";
      p.textContent = "数据加载失败：" + err.message + "（请确认 data/items.json 存在）";
      feed.appendChild(p);
    }
  }

  document.addEventListener("DOMContentLoaded", init);



})();

