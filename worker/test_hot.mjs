/**
 * hot.js 单测：真网络跑一遍四个平台 + 缓存/降级/参数校验。
 * 用法：node test_hot.mjs          （联网）
 *       node test_hot.mjs --offline（跳过联网部分，只测本地逻辑）
 */
import { handleHot } from "./hot.js";

const OFFLINE = process.argv.includes("--offline");
let pass = 0;
let fail = 0;

function ok(cond, name, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

/** 极简 D1 替身：只支持 hot_rank 表的 first / run。 */
function makeDB() {
  const rows = new Map();
  return {
    _rows: rows,
    prepare(sql) {
      const isSelect = /^\s*SELECT/i.test(sql);
      const isUpsert = /^\s*INSERT/i.test(sql);
      return {
        _args: [],
        bind(...args) {
          this._args = args;
          return this;
        },
        async first() {
          if (!isSelect) throw new Error("unsupported");
          if (!/hot_rank/.test(sql)) throw new Error("no such table: whatever");
          return rows.get(this._args[0]) || null;
        },
        async run() {
          if (!isUpsert) throw new Error("unsupported");
          const [src, payload, provider, fetchedAt] = this._args;
          rows.set(src, { payload, provider, fetched_at: fetchedAt });
          return { success: true };
        },
      };
    },
  };
}

const urlOf = (q) => new URL(`https://mo-stats.pages.dev/api/hot${q}`);

async function main() {
  console.log("== 参数校验 ==");
  const env0 = { DB: makeDB() };
  const bad = await handleHot(new Request("https://x/api/hot"), urlOf("?src=nope"), env0);
  ok(bad.status === 400, "未知 src 返回 400", JSON.stringify(bad.body));

  if (!OFFLINE) {
    console.log("== 真实上游（四平台） ==");
    const env = { DB: makeDB() };
    const t0 = Date.now();
    const res = await handleHot(new Request("https://x/api/hot"), urlOf("?debug=1"), env);
    const ms = Date.now() - t0;
    ok(res.status === 200, "整体 200");
    for (const src of ["bili", "douyin", "ks", "xhs"]) {
      const block = res.body.data[src];
      const first = block.items[0];
      ok(
        block.ok && block.items.length >= 5,
        `${src}（${block.label}）拿到 ${block.items.length} 条 · 源=${block.provider}`,
        JSON.stringify(res.body.attempts && res.body.attempts[src])
      );
      if (first) {
        ok(
          first.title.length > 1 && /^https?:\/\//.test(first.url) && first.rank === 1,
          `${src} 首条结构正常`,
          JSON.stringify(first)
        );
        console.log(`      #1 ${first.title} · 热度=${first.hot || "-"}`);
      }
    }
    console.log(`  （耗时 ${ms}ms）`);

    console.log("== 缓存命中：第二次不再走上游 ==");
    const res2 = await handleHot(new Request("https://x/api/hot"), urlOf(""), env);
    const allCached = Object.values(res2.body.data).every((d) => d.cached && !d.stale);
    ok(allCached, "第二次全部命中缓存");
    ok(
      res2.body.data.bili.items.length === res.body.data.bili.items.length,
      "缓存条目数与首次一致"
    );

    console.log("== 强制刷新在 60s 内应被忽略 ==");
    const res3 = await handleHot(new Request("https://x/api/hot"), urlOf("?refresh=1"), env);
    ok(res3.body.data.bili.cached === true, "refresh=1 刚拉过 → 仍给缓存");

    console.log("== 超过 60s 的 refresh=1 必须真的重拉（否则刷新按钮永远没反应） ==");
    for (const row of env.DB._rows.values()) row.fetched_at = Date.now() - 120_000;
    const res3b = await handleHot(new Request("https://x/api/hot"), urlOf("?refresh=1&debug=1"), env);
    ok(
      Object.values(res3b.body.data).every((d) => d.cached === false),
      "2 分钟前的快照 + refresh=1 → 走上游重拉"
    );

    console.log("== 降级：上游全挂 + 有旧快照 → 返回 stale ==");
    const env2 = { DB: makeDB() };
    // 先塞一条 1 小时前的旧快照
    await handleHot(new Request("https://x/api/hot"), urlOf(""), env2);
    for (const row of env2.DB._rows.values()) row.fetched_at = Date.now() - 3600_000;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("simulated network down");
    };
    const res4 = await handleHot(new Request("https://x/api/hot"), urlOf(""), env2);
    globalThis.fetch = realFetch;
    const staleOk = Object.values(res4.body.data).every((d) => d.ok && d.stale);
    ok(staleOk, "上游全挂时用旧快照兜底并标记 stale");

    console.log("== 表不存在也不能 500 ==");
    const env3 = {
      DB: {
        prepare() {
          throw new Error("D1_ERROR: no such table: hot_rank");
        },
      },
    };
    const res5 = await handleHot(new Request("https://x/api/hot"), urlOf("?src=bili"), env3);
    ok(res5.status === 200, "缺表时仍返回 200");
  }

  console.log(`\n${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error("测试崩了：", err);
  process.exit(1);
});
