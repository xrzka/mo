/**
 * 站点运行时配置。纯静态站没有后端，跨用户统计需要一个外部接口。
 *
 * 现在是「全站模式」：所有访客的点击汇总到同一个 Cloudflare D1 库，
 * 访问人数也能统计。后端代码与部署说明见 worker/README.md。
 *
 * 把 statsApi 改回空字符串即退回「本机模式」：点击只记在浏览器
 * localStorage 里，排行榜只反映当前设备，访问人数不可用。
 * 接口不可达时前端也会自动退回本机模式，页面不受影响。
 */
window.MO_CONFIG = {
  statsApi: "https://mo-stats.werneruszcb71.workers.dev",
};
