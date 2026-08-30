/**
 * Cloudflare Pages Functions 入口。
 *
 * 为什么要有这一层：`*.workers.dev` 在国内被墙（DNS 污染 + IP 不可达），
 * 访客的浏览器连不上，统计会静默退回本机模式。`*.pages.dev` 实测可以直连，
 * 所以把同一份逻辑挂到 Pages 上。
 *
 * 业务逻辑完全复用 ../../index.js，没有第二份实现 —— 那份还有测试盯着。
 * 这里只做入口适配：Pages 给的是 onRequest({request, env})，
 * Worker 给的是 fetch(request, env)。
 */
import worker from "../../index.js";

export const onRequest = (context) => worker.fetch(context.request, context.env);
