# 点击 / 访问统计后端

站点是纯静态的，浏览器里没法跨用户共享数据。要做**全站**排行榜和访问人数，
必须有个地方存计数 —— 这个目录就是那个地方，一个 Cloudflare Worker + D1。

**不部署也能用。** 不配的话前端走本机模式：点击数记在你自己浏览器的
localStorage 里，排行榜和排序都正常，但只反映你这台设备，访问人数显示为不可用。

## 两种模式的差别

| | 本机模式（默认） | 全站模式（部署后） |
| --- | --- | --- |
| 点击数来源 | 你这台设备 | 所有访客汇总 |
| 换浏览器/设备 | 数据不通 | 通 |
| 清缓存 | 数据没了 | 不影响 |
| 访问人数 | 拿不到 | 每天/周/月/年/累计 |
| 成本 | 0 | 0（免费额度内） |

免费额度是每天 5 万次 D1 读、10 万次 Worker 请求。一次点击写 5 行、一次
开页读 10 行，按每天几千次点击算，用掉的是零头。

## 部署

需要 Node 和一个 Cloudflare 账号（免费版即可）。

```bash
cd worker
npm install -g wrangler        # 装过就跳过
wrangler login                 # 浏览器里授权

wrangler d1 create mo-stats    # 建库，记下输出的 database_id
```

把 `database_id` 填进 `wrangler.toml`，然后建表并部署：

```bash
wrangler d1 execute mo-stats --remote --file=schema.sql
wrangler deploy
```

部署完会打印形如 `https://mo-stats.你的子域.workers.dev` 的地址。把它填进
上一级目录的 `config.js`：

```js
window.MO_CONFIG = {
  statsApi: "https://mo-stats.你的子域.workers.dev",
};
```

提交推送，10 分钟内（CDN 缓存 `max-age=600`）线上就切到全站模式。改
`config.js` 时记得把 `index.html` 里三个 `?v=` 版本号一起提，否则缓存不更新。

### 可选：开限流

不绑 KV 也能跑，只是没有防刷。要开的话：

```bash
wrangler kv namespace create RATE
```

把返回的 id 填进 `wrangler.toml` 里注释掉的 `[[kv_namespaces]]` 段，取消注释，
再 `wrangler deploy`。默认限制单 IP 每分钟 60 次写入。

## 验证部署

```bash
curl https://mo-stats.你的子域.workers.dev/api/stats
```

应该返回 `{"clicks":{...},"visitors":{...},"buckets":{...}}`。刚部署时全是空的。

前端有兜底：接口挂了、域名写错了、超时了，都会自动退回本机模式，页面不会白屏。
这条路径有测试覆盖（`test_browser.py` 的「后端不可用时降级」）。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/stats` | 各周期 Top 20 点击 + 访问人数 |
| POST | `/api/hit` | `{"id":"资源id"}`，该资源计数 +1 |
| POST | `/api/visit` | `{}`，当天访问人数 +1（去重后） |

写接口只接受 `ALLOWED_ORIGINS`（`index.js` 顶部）里的来源，默认只有
`https://xrzka.github.io`。换域名要改这里。读接口不限来源，方便你直接在
浏览器里看数字。

## 几个设计决定

**为什么用 D1 不用 KV。** 计数是读改写，KV 最终一致，两个人同时点会
互相覆盖。D1 走 `INSERT ... ON CONFLICT DO UPDATE SET n = n + 1`，是
一条原子语句。测试里 50 次并发点击一次不丢，KV 方案过不了这条。

**为什么存五份。** `clicks` 表按 `(period, bucket, item)` 存，一次点击往
day/week/month/year/all 各写一行。查排行榜就是一次带索引的
`ORDER BY n DESC LIMIT 20`，不用扫历史聚合。代价是写放大 5 倍，但写
本来就少。

**访问人数怎么去重。** 不存 IP。存的是 `SHA-256(IP + UA + 当天日期)` 的前
32 位十六进制。日期当盐，所以跨天的记录无法关联到同一个人，也无法从
哈希反推 IP。判断新访客靠 `INSERT OR IGNORE` 的 `changes` 是否为 1 ——
是 1 才给 `visits` 加数，所以那个数字是**人数**不是次数。

前端另外用 localStorage 记了「今天报过了」，刷新页面不会重复上报。两层
去重是互补的：前端挡刷新，后端挡清缓存和多标签页。

**桶名统一用 UTC。** 服务端没有「用户时区」的概念，前后端各按自己的时区
算会让同一次点击落进不同的天。前端本机模式用本地时区（「今日」才符合
直觉），全站模式下桶名完全由后端决定，不存在冲突。ISO 周编号两边算法
一致，`test_frontend_parity.mjs` 专门盯这件事。

**seen 表会长大。** 每个访客每天 5 行。cron 每天清一次 400 天前的记录，
见 `wrangler.toml` 的 `[triggers]`。

## 测试

```bash
node test_buckets.mjs            # 桶名算法、id 校验
node test_frontend_parity.mjs    # 前后端桶名一致性、本机模式分桶、真实数据 id 合法性
node test_selectors.mjs          # app.js 用的选择器在 index.html 里都存在
node test_worker.mjs             # Worker 逻辑（真 SQL，node:sqlite 内存库当 D1）
python test_browser.py           # 真 Chromium 端到端，含全站模式和降级
```

`test_worker.mjs` 用 `node:sqlite`（Node 22+ 内置）跑真实 SQL，覆盖并发计数、
访客去重、CORS、限流、注入串拦截、定时清理、榜单截断。`test_browser.py`
用 Playwright 起真浏览器，本地 HTTP 桩假装 Worker，覆盖点击写入、跨天分桶、
排行榜定位、未成年模式过滤、后端挂掉时降级。

**一个已知局限：** `test_frontend_parity.mjs` 里前端那份桶名算法和本机计数
逻辑是从 `app.js` 抄过去的（IIFE 没法 import）。改 `app.js` 里
`isoWeek` / `bucketKeys` / `bumpLocal` 时必须同步改测试，否则它测的是旧逻辑。
