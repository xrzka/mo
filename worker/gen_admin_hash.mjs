/**
 * 生成 ADMIN_PASSWORD_HASH，给 `./wr.sh secret put ADMIN_PASSWORD_HASH` 用。
 *
 * 密码从 stdin 读，不走命令行参数 —— 参数会进 shell 历史和进程列表。
 * 输出格式 pbkdf2$迭代次数$盐hex$派生hex，自带参数，以后调迭代次数不会让旧哈希失效。
 *
 * 跑法：echo -n '你的密码' | node gen_admin_hash.mjs
 */
import { pbkdf2Sync, randomBytes } from "node:crypto";

const ITER = 100000;   // 与 index.js 的 PBKDF2_ITER 保持一致

const password = await new Promise((resolve) => {
  let buf = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (d) => (buf += d));
  process.stdin.on("end", () => resolve(buf.replace(/\r?\n$/, "")));
});

if (!password) {
  console.error("没读到密码。用法：echo -n '你的密码' | node gen_admin_hash.mjs");
  process.exit(1);
}
if (password.length < 8) {
  console.error(`密码只有 ${password.length} 位，建议至少 8 位。`);
  process.exit(1);
}

const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, ITER, 32, "sha256");
console.log(`pbkdf2$${ITER}$${salt.toString("hex")}$${hash.toString("hex")}`);
