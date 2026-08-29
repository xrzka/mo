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
        { id: "kr", label: "韩轻" },
        { id: "jp", label: "日轻" },
      ],
    },
    {
      id: "manga",
      label: "漫画",
      icon: "🎨",
      subs: [
        { id: "kr", label: "韩漫" },
        { id: "jp", label: "日漫" },
      ],
    },
    { id: "anime", label: "动画", icon: "🎬" },
    { id: "game", label: "游戏", icon: "🎮" },
    { id: "music", label: "音乐", icon: "🎵" },
    { id: "tool", label: "工具", icon: "🔧" },
    { id: "ai", label: "AI", icon: "✦" },
    { id: "guide", label: "教程 / 问题", icon: "💡" },
    { id: "collection", label: "收录", icon: "🗂" },
  ];

  const SECTION_MAP = new Map(SECTIONS.map((s) => [s.id, s]));

  const PAGE_SIZES = [10, 20, 30, 50, 100];
  const DEFAULT_PAGE_SIZE = 20;

  const state = {
    items: [],
    generatedAt: null,
    section: "all",
    sub: "all",
    q: "",
    adultMode: false, // 默认未成年模式，成人向内容不显示
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
  };

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

  /** 收敛原始数据，缺字段给安全默认值；未知分区归到 novel 以免丢卡片。 */
  function normalize(raw, index) {
    const section = SECTION_MAP.has(raw.section) && raw.section !== "all" ? raw.section : "novel";
    const subs = SECTION_MAP.get(section).subs || [];
    const sub = subs.some((s) => s.id === raw.subsection) ? raw.subsection : null;
    return {
      id: raw.id || "item-" + index,
      name: raw.name || "未命名资源",
      description: raw.description || "暂无简介",
      url: raw.url || "",
      section,
      sub,
      icon: raw.icon || SECTION_MAP.get(section).icon,
      tags: Array.isArray(raw.tags) ? raw.tags.slice(0, 6) : [],
      kind: raw.kind || "网站",
      needLogin: raw.need_login === true,
      updateInfo: raw.update_info || "未标注",
      note: raw.note || "",
      password: raw.password || "",
      adult: raw.adult === true,
      // 多网盘源；没有 links 字段时用主链接兜底成单元素数组
      links: Array.isArray(raw.links) && raw.links.length
        ? raw.links.filter((l) => l && /^https?:\/\//i.test(l.url))
        : raw.url
          ? [{ name: "打开", url: raw.url, password: raw.password || "" }]
          : [],
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

  /** 分区匹配；小分区只在选中主分区时生效。 */
  const inSection = (item, sectionId, subId = "all") => {
    if (sectionId !== "all" && item.section !== sectionId) return false;
    if (sectionId !== "all" && subId !== "all" && item.sub !== subId) return false;
    return true;
  };

  /** 未成年模式下过滤掉成人向条目。所有计数与列表都必须经过这一层。 */
  const allowedItems = () => state.items.filter((it) => state.adultMode || !it.adult);

  const visibleItems = () =>
    allowedItems().filter(
      (it) => inSection(it, state.section, state.sub) && matchesQuery(it, state.q)
    );

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

    const inCurrent = allowedItems().filter(
      (it) => it.section === state.section && matchesQuery(it, state.q)
    );
    const options = [{ id: "all", label: "全部" }, ...subs];

    options.forEach((o) => {
      const n = inCurrent.filter((it) => o.id === "all" || it.sub === o.id).length;
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

    field("icon").textContent = item.icon;
    field("name").textContent = item.name;
    field("description").textContent = item.description;

    const secDef = SECTION_MAP.get(item.section);
    const subDef = (secDef.subs || []).find((s) => s.id === item.sub);
    // 有小分区就显示小分区名，更具体
    field("section").textContent = subDef ? subDef.label : secDef.label;

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

    const detail = node.querySelector("[data-detail]");
    const toggle = () => {
      const open = node.getAttribute("aria-expanded") === "true";
      node.setAttribute("aria-expanded", String(!open));
      detail.hidden = open;
    };
    node.addEventListener("click", (e) => {
      if (e.target.closest("a")) return;
      toggle();
    });
    node.addEventListener("keydown", (e) => {
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

  function render() {
    renderTabs();
    renderSubTabs();
    renderFeed();
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
    refreshScrollDock = bindScrollDock() || (() => {});
    try {
      const res = await fetch(DATA_URL, { cache: "no-cache" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const payload = await res.json();
      const raw = Array.isArray(payload) ? payload : payload.items || [];
      state.items = raw.map(normalize);
      state.generatedAt = payload.generated_at || null;
      $("[data-footer-updated]").textContent = fmtDate(state.generatedAt);
      renderModeUI();
      render();
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

