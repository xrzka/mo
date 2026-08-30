/**
 * 站点运行时配置。纯静态站没有后端，跨用户统计需要一个外部接口。
 *
 * statsApi 留空时，点击统计走「本机模式」：只记在浏览器 localStorage 里，
 * 排行榜只反映你自己在这台设备上的点击，访问人数无法统计（前端拿不到别人的数据）。
 *
 * 填上 Cloudflare Worker 地址后自动切到「全站模式」：
 * 所有人的点击汇总在一起，访问人数也能统计。部署方法见 worker/README.md。
 *   window.MO_CONFIG.statsApi = "https://mo-stats.你的子域.workers.dev";
 */
window.MO_CONFIG = {
  statsApi: "",
};
