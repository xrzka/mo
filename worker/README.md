# 点击 / 访问统计后端

站点是纯静态的，浏览器里没法跨用户共享数据。要做**全站**排行榜和访问人数，
必须有个地方存计数 —— 这个目录就是那个地方，一个 Cloudflare Worker + D1。

## 当前部署状态

**已部署，站点跑在全站模式。同一份逻辑挂在两个入口。**

| 项目 | 值 |
| --- | --- |
| 主入口（访客走这个） | `https://mo-stats.pages.dev` |
| 备用入口 | `https://mo-stats.werneruszcb71.workers.dev` |
| Cloudflare 账号 | `werneruszcb71@gmail.com` |
| Account ID | `2282ef506abf2f1af6d4ddc4a25988af` |
| D1 数据库 | `mo-stats`（区域 WNAM） |
| database_id | `784254ea-5aa2-415c-bfd3-945b9cc4bd67` |
| 定时清理 | 每天 03:17 UTC |

**为什么有两个入口。** `*.workers.dev` 在国内被墙 —— DNS 被污染（解析到
`31.13.95.48` 这种无关地址），拿到真实 IP `188.114.96.2` 直连也不通，
同 IP 换个普通 SNI 同样不通，所以是 IP 段级别的封锁。访客的浏览器连不上，
统计会静默退回本机模式。`*.pages.dev` 实测可以直连（20 次 19 通），
所以主入口用它。

两个入口读写**同一个 D1 库**，数据完全一致。`pages/functions/[[path]].js`
直接 import `../../index.js`，没有第二份实现 —— 那份有测试盯着。

`config.js` 里 `statsApi` 是数组，前端按顺序试，第一个通的就用。

wrangler 的登录凭据和日志都在 `D:\local_translate_tool\wrangler_home`，不在 C 盘 ——
用 `./wr.sh` 包装脚本跑所有 wrangler 命令来保证这一点（它设了 `XDG_CONFIG_HOME`
和 `WRANGLER_LOG_PATH`）。直接敲 `wrangler` 会往 C 盘写。

**不部署也能用。** 不配的话前端走本机模式：点击数记在你自己浏览器的
localStorage 里，排行榜和排序都正常，但只反映你这台设备，访问人数显示为不可用。

### 更新 Pages 入口

```bash
cd worker/pages
../wr.sh pages deploy
```

Worker 入口那边是 `cd worker && ./wr.sh deploy`。改了 `index.js` 要两边都发。

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

需要 Node 和一个 Cloudflare 账号（免费版即可）。已经部署过一次了，这节留作
重建或换账号时的参考。

```bash
cd worker
npm install -g wrangler        # 装过就跳过（装在 D:\npm-global）
./wr.sh login                 # 浏览器里授权，务必用 wr.sh 而不是裸 wrangler

./wr.sh d1 create mo-stats    # 建库，记下输出的 database_id
```

把 `database_id` 填进 `wrangler.toml`，然后建表并部署：

```bash
./wr.sh d1 execute mo-stats --remote --file=schema.sql
./wr.sh deploy
```

部署完会打印形如 `https://mo-stats.你的子域.workers.dev` 的地址。把它填进
上一级目录的 `config.js`，提交推送，10 分钟内（CDN 缓存 `max-age=600`）线上
就切到全站模式。改 `config.js` 时记得把 `index.html` 里三个 `?v=` 版本号一起提，
否则缓存不更新。

### 部署时踩到的两个坑

**`wrangler login` 只等 120 秒。** 源码里 `12e4` 毫秒硬编码，超时就把回调端口
8976 关掉。如果 dash.cloudflare.com 加载慢，等你点完 Allow，浏览器把 code 送
回来时端口已经没了，表现为「localhost 拒绝连接」。这不是代理问题 —— 地址栏里
`?code=cfoac_...` 说明 OAuth 那半是通的。重跑 `./wr.sh login` 抢时间即可，
或者在原标签页按刷新重发同一个 code。

**`d1 execute --file` 走的 import 接口不稳。** 它会先把 SQL 上传再执行，这一步
在国内网络下常报 `fetch failed`（日志里能看到 POST `/d1/database/<id>/import`）。
改用 `--command` 逐条建表就绕过了，`schema.sql` 里的语句一句句执行即可。
`--command` 走的是另一个接口，稳定得多。

**`*.workers.dev` 在国内不可达。** 这个坑最费时间。表现是浏览器里统计一直
显示「本机统计」，看起来像后端没部署好，其实接口是通的 —— 只有能翻墙的网络
能连上。排查路径：DNS 查到 `31.13.95.48`（污染），DoH 查到真实 IP
`188.114.96.2`，直连真实 IP 超时，同 IP 换普通 SNI 也超时 → IP 段封锁，
不是 SNI 封锁，也不是我的代码问题。解法是加一个 `pages.dev` 入口。

**国内直连 pages.dev 的 TLS 握手偶发超时。** 实测首次加载约 20% 会失败。
前端的 `pull()` 因此改成整轮候选跑完还失败就再重试一轮，命令行测试脚本
`test_live.py` 也带了退避重试。加重试后真浏览器 8/8 都进全站模式。
另外降级到本机模式后，点击仍会串行补报到候选地址，所以那 20% 的抖动
不会导致丢数据。

### 可选：开限流

不绑 KV 也能跑，只是没有防刷。要开的话：

```bash
./wr.sh kv namespace create RATE
```

把返回的 id 填进 `wrangler.toml` 里注释掉的 `[[kv_namespaces]]` 段，取消注释，
再 `./wr.sh deploy`。默认限制单 IP 每分钟 60 次写入。

## 验证部署

```bash
curl https://mo-stats.pages.dev/api/stats
```

应该返回 `{"clicks":{...},"visitors":{...},"buckets":{...}}`。刚部署时全是空的。

备用入口要带代理才测得通：

```bash
curl --proxy http://127.0.0.1:7890 https://mo-stats.werneruszcb71.workers.dev/api/stats
```

前端有兜底：所有地址都不通时会自动退回本机模式，页面不会白屏。
这条路径有测试覆盖（`test_browser.py` 的「后端全都不可用时降级」）。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/stats` | 各周期 Top 20 点击 + 访问人数 |
| POST | `/api/hit` | `{"id":"资源id"}`，该资源计数 +1 |
| POST | `/api/visit` | `{}`，当天访问人数 +1（去重后） |

写接口只接受 `ALLOWED_ORIGINS`（`index.js` 顶部）里的来源，默认只有
`https://xrzka.github.io`。换域名要改这里，改完两个入口都要重新部署。
读接口不限来源，方便你直接在浏览器里看数字。

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
python test_browser.py           # 真 Chromium 端到端，含多地址回退、重试、降级
python test_live.py              # 打线上真接口（默认 pages.dev，可直连）
python test_live.py --api https://mo-stats.werneruszcb71.workers.dev --proxy http://127.0.0.1:7890
```

`test_worker.mjs` 用 `node:sqlite`（Node 22+ 内置）跑真实 SQL，覆盖并发计数、
访客去重、CORS、限流、注入串拦截、定时清理、榜单截断。`test_browser.py`
用 Playwright 起真浏览器，本地 HTTP 桩假装后端，覆盖点击写入、跨天分桶、
排行榜定位、未成年模式过滤、多地址回退、首轮失败重试、降级后补报、
全部不通时降级 —— 它会把 `config.js` 路由桩掉，所以结果不依赖真实网络。

`test_live.py` 打的是线上真接口，会往 D1 写一条 `live-smoke-<时间戳>` 再删掉。
它必须伪装浏览器 UA：Cloudflare 边缘的机器人防护会用 403 挡 `Python-urllib`
这类默认 UA，那一层在我们的代码之前。

**两个已知局限：**

`test_frontend_parity.mjs` 里前端那份桶名算法和本机计数逻辑是从 `app.js` 抄
过去的（IIFE 没法 import）。改 `app.js` 里 `isoWeek` / `bucketKeys` / `bumpLocal`
时必须同步改测试，否则它测的是旧逻辑。

Windows 上从 Python 调 wrangler 要用 `wrangler.cmd` 并显式指定
`encoding="utf-8"` —— wrangler 输出带颜色转义和 emoji，默认 GBK 解码会抛
`UnicodeDecodeError`，让 `stdout` 变成 `None`，症状是「命令成功了但读不到输出」。
