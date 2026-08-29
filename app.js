/**
 * 墨小说漫画 —— 纯静态资源导航。
 * 数据来源：同目录 data/items.json。
 * 无框架、无依赖、无后端，可直接部署到 GitHub Pages。
 */
(() => {
  "use strict";

  const DATA_URL = "data/items.json";

  /** 分区定义。新增分区在这里加一项，data/items.json 里 section 用对应 id。 */
  const SECTIONS = [
    { id: "all", label: "全部", icon: "◆" },
    { id: "novel", label: "小说", icon: "📖" },
    { id: "manga", label: "漫画", icon: "🎨" },
    { id: "anime", label: "动画", icon: "🎬" },
    { id: "game", label: "游戏", icon: "🎮" },
    { id: "ai", label: "AI", icon: "✦" },
  ];

  const SECTION_MAP = new Map(SECTIONS.map((s) => [s.id, s]));

  const state = {
    items: [],
    generatedAt: null,
    section: "all",
    q: "",
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const fmtDate = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d)) return "—";
    return d.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
  };
  /** 收敛原始数据，缺字段给安全默认值；未知分区归到 novel 以免丢卡片。 */
  function normalize(raw, index) {
    const section = SECTION_MAP.has(raw.section) && raw.section !== "all" ? raw.section : "novel";
    return {
      id: raw.id || "item-" + index,
      name: raw.name || "未命名资源",
      description: raw.description || "暂无简介",
      url: raw.url || "",
      section,
      icon: raw.icon || SECTION_MAP.get(section).icon,
      tags: Array.isArray(raw.tags) ? raw.tags.slice(0, 6) : [],
      kind: raw.kind || "网站",
      needLogin: raw.need_login === true,
      updateInfo: raw.update_info || "未标注",
      note: raw.note || "",
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

  const visibleItems = () =>
    state.items.filter(
      (it) => (state.section === "all" || it.section === state.section) && matchesQuery(it, state.q)
    );

  /* ---------- 渲染 ---------- */

  function renderTabs() {
    const bar = $("[data-tabs]");
    bar.textContent = "";
    SECTIONS.forEach((s) => {
      // 计数只受搜索词影响，不受当前分区影响，这样切换分区时数字稳定
      const n = state.items.filter(
        (it) => (s.id === "all" || it.section === s.id) && matchesQuery(it, state.q)
      ).length;

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
    field("section").textContent = SECTION_MAP.get(item.section).label;

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

    const link = field("link");
    // 只放行 http(s)，挡掉 javascript: 之类的伪协议
    if (/^https?:\/\//i.test(item.url)) link.href = item.url;
    else link.remove();

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
    const feed = $("[data-feed]");
    feed.textContent = "";
    const frag = document.createDocumentFragment();
    list.forEach((it) => frag.appendChild(buildCard(it)));
    feed.appendChild(frag);

    $("[data-empty]").hidden = list.length > 0;
    const label = SECTION_MAP.get(state.section).label;
    $("[data-result-count]").textContent = list.length
      ? `${label} · 共 ${list.length} 个资源`
      : "";
  }

  function render() {
    renderTabs();
    renderFeed();
    $('[data-stat="total"]').textContent = String(state.items.length).padStart(2, "0");
  }
  /* ---------- 事件绑定 ---------- */

  function bindControls() {
    const input = $('[data-filter="q"]');
    if (input) {
      input.addEventListener("input", () => {
        state.q = input.value.trim();
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
    try {
      const res = await fetch(DATA_URL, { cache: "no-cache" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const payload = await res.json();
      const raw = Array.isArray(payload) ? payload : payload.items || [];
      state.items = raw.map(normalize);
      state.generatedAt = payload.generated_at || null;
      $("[data-footer-updated]").textContent = fmtDate(state.generatedAt);
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

