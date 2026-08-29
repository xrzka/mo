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
    { id: "ai", label: "AI", icon: "✦" },
    { id: "collection", label: "收录", icon: "🗂" },
  ];

  const SECTION_MAP = new Map(SECTIONS.map((s) => [s.id, s]));

  const state = {
    items: [],
    generatedAt: null,
    section: "all",
    sub: "all",
    q: "",
    adultMode: false, // 默认未成年模式，成人向内容不显示
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

    // 提取码：有则显示，点击可复制
    const pwWrap = field("passwordWrap");
    if (item.password) {
      field("password").textContent = item.password;
      const btn = field("copyPw");
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(item.password);
          btn.textContent = "已复制";
          setTimeout(() => (btn.textContent = "复制"), 1500);
        } catch {
          btn.textContent = "请手动复制";
        }
      });
    } else {
      pwWrap.remove();
    }

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
    const secDef = SECTION_MAP.get(state.section);
    const subDef = (secDef.subs || []).find((s) => s.id === state.sub);
    const label = subDef ? `${secDef.label} · ${subDef.label}` : secDef.label;
    $("[data-result-count]").textContent = list.length ? `${label} · 共 ${list.length} 个资源` : "";
  }

  function render() {
    renderTabs();
    renderSubTabs();
    renderFeed();
    $('[data-stat="total"]').textContent = String(allowedItems().length).padStart(2, "0");
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
        renderModeUI();
        render();
        return;
      }
      dialog.hidden = false;
      $("[data-age-confirm]").focus();
    });

    $("[data-age-confirm]").addEventListener("click", () => {
      state.adultMode = true;
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
    bindMode();
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

