import path from "node:path";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { ContentStore } from "./content.mjs";
import { initializeAdmin, resetTotp } from "./auth.mjs";
import { Publisher } from "./publish.mjs";
import { createApp } from "./server.mjs";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const data = path.resolve(process.env.CMS_DATA_DIR || path.join(root, ".cms"));
const store = new ContentStore(root, data);
await store.init();
let unlock;
async function acquire() {
  unlock = await lockfile.lock(data, {
    lockfilePath: path.join(data, "writer.lock"),
    stale: 30000,
    update: 5000,
  });
}
async function release() {
  if (unlock) {
    await unlock().catch(() => {});
    unlock = null;
  }
}
try {
  await acquire();
  const command = process.argv[2] || "serve";
  if (command === "init") {
    let password = process.env.CMS_PASSWORD;
    if (!password) {
      if (!process.stdin.isTTY)
        throw new Error(
          "请交互运行 pnpm cms:init，或通过 CMS_PASSWORD 环境变量提供密码"
        );
      process.stdout.write("设置管理员密码（至少 12 个字符，输入不显示）：");
      const hidden = new Writable({
        write(_chunk, _enc, done) {
          done();
        },
      });
      const rl = createInterface({
        input: process.stdin,
        output: hidden,
        terminal: true,
      });
      password = await rl.question("");
      rl.close();
      process.stdout.write("\n");
    }
    await initializeAdmin(data, password);
    delete process.env.CMS_PASSWORD;
    process.stdout.write("管理员密码已设置。运行 pnpm cms:start 启动后台。\n");
    await release();
  } else if (command === "reset-totp") {
    await resetTotp(data);
    process.stdout.write("验证器已重置。启动后台后请用密码登录并重新绑定。\n");
    await release();
  } else if (command === "build") {
    const publisher = new Publisher(store);
    const result = await publisher.publish();
    process.stdout.write(result.log + "\n" + result.message + "\n");
    await release();
    if (result.status !== "success") process.exitCode = 1;
  } else if (command === "serve") {
    const port = Number(process.env.CMS_PORT || 4444);
    const host = process.env.CMS_HOST || "127.0.0.1";
    const origin = new URL(process.env.CMS_ORIGIN || `http://localhost:${port}`)
      .origin;
    const secure = origin.startsWith("https:");
    if (
      !secure &&
      !["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname)
    )
      throw new Error("公开后台必须配置 HTTPS 的 CMS_ORIGIN");
    const server = await createApp({ store, origin, secure });
    server.listen(port, host, () =>
      process.stdout.write(`Wenying CMS: ${origin}/admin/\n`)
    );
    const stop = () => {
      server.close(async () => {
        await release();
        process.exit(0);
      });
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    server.on("error", async e => {
      process.stderr.write(e.message + "\n");
      await release();
      process.exit(1);
    });
  } else throw new Error("命令：init | serve | build | reset-totp");
} catch (e) {
  process.stderr.write(
    (e.code === "ELOCKED"
      ? "后台已运行，或异常退出后的锁尚未过期；请停止服务或等待 30 秒重试"
      : e.message) + "\n"
  );
  await release();
  process.exitCode = 1;
}
