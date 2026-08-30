/**
 * 站点运行时配置。纯静态站没有后端，跨用户统计需要一个外部接口。
 *
 * 现在是「全站模式」：所有访客的点击汇总到同一个 Cloudflare D1 库，
 * 访问人数也能统计。后端代码与部署说明见 worker/README.md。
 *
 * statsApi 可以是数组，前端按顺序试，第一个通的就用。
 * pages.dev 放在前面是因为 workers.dev 在国内被墙（DNS 污染 + IP 不可达），
 * 访客的浏览器连不上；两个地址读写的是同一个 D1 库，数据完全一致。
 *
 * 改成空字符串即退回「本机模式」：点击只记在浏览器 localStorage 里，
 * 排行榜只反映当前设备，访问人数不可用。所有地址都不通时也会自动退回，
 * 页面不受影响。
 */
window.MO_CONFIG = {
  statsApi: [
    "https://mo-stats.pages.dev",
    "https://mo-stats.werneruszcb71.workers.dev",
  ],
};
