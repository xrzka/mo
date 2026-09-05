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

  // 后台编辑的覆盖层：{ itemId: {name?, description?, url?, password?, note?, updated} }
  // 站点是纯静态的，浏览器改不了 items.json，所以编辑结果存在 D1 里，
  // 渲染前合并进来（见 normalize 的 ov 参数）。
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

    /** 解析 'novel:jp,manga:download' 这种归属串成 [{id, sub}]。
     *  未知分区丢掉而不是回落 —— 回落会把它塞进兜底区，一条资源莫名出现在
     *  「收录 / 杂类」里比少一个归属更难解释。 */
    const parsePlacements = (text) => {
      const out = [];
      String(text || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((part) => {
          const [secId, subId = ""] = part.split(":").map((s) => s.trim());
          if (!SECTION_MAP.has(secId) || secId === "all") return;
          if (out.some((s) => s.id === secId)) return;   // 同区只留第一个
          out.push({ id: secId, sub: subOf(secId, subId) });
        });
      return out;
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

      const cnt = document.createElement("span");
      cnt.className = "tab-count";
      cnt.textContent = n;
      btn.appendChild(cnt);

      btn.addEventListener("click", () => {
        state.section = s.id;
        state.sub = "all"; // 换主分区时重置小分区
        state.page = 1;
        render();
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
      const n = inCurrent.filter(
        (it) => o.id === "all" || subInSection(it, state.section) === o.id
      ).length;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "subtab-btn";
      btn.setAttribute("aria-selected", String(state.sub === o.id));
      btn.textContent = o.label;

      const cnt = document.createElement("span");
      cnt.className = "tab-count";
      cnt.textContent = n;
      btn.appendChild(cnt);

      btn.addEventListener("click", () => {
        state.sub = o.id;
        state.page = 1;
        render();
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

    // 标签跟着当前所在分区走：同一份「小说+漫画」资源，在小说区显示「韩轻」，
    // 在漫画区显示「韩漫」，比永远显示主分区更符合用户此刻的语境。
    const shownSec = state.section !== "all" && inSection(item, state.section)
      ? state.section
      : item.section;
    const secDef = SECTION_MAP.get(shownSec);
    const subDef = (secDef.subs || []).find((s) => s.id === subInSection(item, shownSec));
    // 有小分区就显示小分区名，更具体
    field("section").textContent = subDef ? subDef.label : secDef.label;

    // 跨区资源额外标一下另外那些区，让人知道这一份里还有别的内容
    if ((item.sections || []).length > 1) {
      const others = item.sections
        .filter((s) => s.id !== shownSec)
        .map((s) => (SECTION_MAP.get(s.id) || {}).label)
        .filter(Boolean);
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

  /** 覆盖层或新增条目变了之后重建 state.items 并重渲染。 */
  async function refreshOverrides({ withItems = false } = {}) {
    const [ov, custom] = await Promise.all([
      loadOverrides(),
      withItems ? loadCustomItems() : Promise.resolve(null),
    ]);
    overrides = ov;
    if (custom) state.customItems = custom;
    state.items = allRaw().map((r, i) => normalize(r, i, overrides[r && r.id]));
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
    });

    const logout = $("[data-admin-logout]");
    if (logout) {
      logout.addEventListener("click", async () => {
        await adminFetch("/api/admin/logout", {});
        adminToken = "";
        say("已退出", "ok");
        renderAdmin();
        render();
      });
    }

    // 支持直接改 hash 进出后台，不用刷新
    window.addEventListener("hashchange", renderAdmin);
    bindAdminNew();
  }

  /* ---------- 后台新增资源 ---------- */

  /** 新增表单的字段。与后端 createCustomItem 收的字段对应。 */
  const ADMIN_NEW_FIELDS = [
    { key: "name", label: "资源名", type: "text", required: true },
    { key: "placements", label: "所属分区（可加多个）", type: "placements", required: true },
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
    { key: "placements", label: "所属分区（可加多个）", type: "placements" },
  ];

  /** 一条资源最多挂几个分区。与后端 PLACEMENT_MAX 保持一致。 */
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
   * 多分区归属选择器。渲染成若干「分区 + 小分区 + 删除」行，末尾一个「+ 再加一个分区」。
   *
   * 返回 { read() } —— read 拼出后端要的 'novel:jp,manga:download' 串。
   * 不用 <select multiple>：那个只能选分区、带不上各自的小分区，而
   * 「小说/日轻 + 漫画/下载」这种组合正是要表达的东西。
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
    addBtn.textContent = "+ 再加一个分区";
    box.appendChild(addBtn);

    const hint = document.createElement("p");
    hint.className = "placement-hint";
    box.appendChild(hint);

    const state = [];   // [{ row, sec, sub }]

    const refresh = () => {
      // 第一行是主归属，卡片默认显示它的标签；同区重复没有意义（计数会翻倍）
      state.forEach((r, i) => {
        r.row.querySelector(".placement-index").textContent = i === 0 ? "主分区" : `分区 ${i + 1}`;
        // 只剩一行时不给删 —— 一条资源总得有个归属
        r.row.querySelector(".placement-del").hidden = state.length <= 1;
      });
      addBtn.hidden = state.length >= PLACEMENT_MAX;
      const dup = new Set();
      const repeated = state.some((r) => {
        const v = r.sec.value;
        if (dup.has(v)) return true;
        dup.add(v);
        return false;
      });
      hint.textContent = repeated
        ? "同一个分区选了多次，保存时只会保留第一次"
        : "第一个是主分区，卡片上的标签按它显示。";
      hint.className = "placement-hint" + (repeated ? " warn" : "");
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
      del.title = "移除这个分区";
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
        const seen = new Set();
        return state
          .map((r) => ({ sec: r.sec.value, sub: r.sub.disabled ? "" : r.sub.value }))
          .filter((p) => {
            if (!p.sec || seen.has(p.sec)) return false;
            seen.add(p.sec);
            return true;
          })
          .map((p) => (p.sub ? `${p.sec}:${p.sub}` : p.sec))
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

    // 后台新增的条目可以直接删掉。items.json 里的条目不给删 ——
    // 它们不在 custom_items 表里，删除得改仓库文件。
    if (String(item.id).startsWith("custom-")) {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "admin-delete";
      del.textContent = "删除这条";
      actions.appendChild(del);

      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        // 删除不可撤销，问一句。误删一条得重新填一遍表单。
        if (!window.confirm(`确定删除「${item.name}」？此操作不可撤销。`)) return;
        del.disabled = true;
        say("删除中…");
        const r = await adminFetch("/api/admin/item/delete", { id: item.id });
        del.disabled = false;
        if (!r.ok) return say(r.error, "bad");
        // 这张卡会消失，flash 没有落点，提示改放到后台面板那行
        const panelMsg = $("[data-admin-new-msg]");
        if (panelMsg) {
          panelMsg.textContent = `已删除「${item.name}」`;
          panelMsg.className = "admin-new-msg ok";
        }
        await refreshOverrides({ withItems: true });
      });
    }
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

      li.appendChild(side);
      box.appendChild(li);
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
    renderFeed();
    renderStatsTabs();
    renderStats();
    $('[data-stat="total"]').textContent = String(allowedItems().length).padStart(2, "0");
    refreshScrollDock();
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
    bindMode();
    bindNoticeJump();
    bindStatsPanel();
    bindWantedPanel();
    bindWantedForm();
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
      state.items = allRaw().map((r, i) => normalize(r, i, overrides[r && r.id]));
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

