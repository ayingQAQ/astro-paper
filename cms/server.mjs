import { createServer } from "node:http";
import { readFile, stat, open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import QRCode from "qrcode";
import { TOTP } from "otpauth";
import { Auth } from "./auth.mjs";
import { Publisher } from "./publish.mjs";
import { containedFile, HttpError, preview, readOptional } from "./content.mjs";

const ui = fileURLToPath(new URL("./ui/", import.meta.url));
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".xml": "application/xml",
  ".txt": "text/plain",
  ".wasm": "application/wasm",
};
function json(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}
async function body(req, limit = 1024 * 1024) {
  if (Number(req.headers["content-length"]) > limit)
    throw new HttpError(413, "上传内容过大");
  const parts = [];
  let total = 0;
  for await (const part of req) {
    total += part.length;
    if (total > limit) throw new HttpError(413, "上传内容过大");
    parts.push(part);
  }
  return Buffer.concat(parts);
}
async function payload(req) {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    throw new HttpError(415, "请使用 JSON 请求");
  try {
    return JSON.parse((await body(req)).toString("utf8"));
  } catch (e) {
    if (e.status) throw e;
    throw new HttpError(400, "请求格式错误");
  }
}
async function serve(res, req, root, relative, publicFile = false) {
  let file = await containedFile(root, relative);
  if ((await stat(file)).isDirectory())
    file = await containedFile(root, path.join(relative, "index.html"));
  const handle = await open(file);
  const info = await handle.stat();
  if (publicFile) {
    res.setHeader(
      "Cache-Control",
      relative.startsWith("_astro/")
        ? "public, max-age=31536000, immutable"
        : "no-cache"
    );
    const etag = `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`;
    res.setHeader("ETag", etag);
    if (
      req.headers["if-none-match"]
        ?.split(",")
        .map(value => value.trim())
        .includes(etag)
    ) {
      await handle.close();
      res.writeHead(304);
      return res.end();
    }
  }
  res.writeHead(200, {
    "Content-Type": mime[path.extname(file)] ?? "application/octet-stream",
    "Content-Length": info.size,
  });
  if (req.method === "HEAD") {
    await handle.close();
    res.end();
  } else handle.createReadStream().pipe(res);
}
export async function createApp({
  store,
  origin,
  secure = true,
  publisher = new Publisher(store),
}) {
  const auth = new Auth(store.data);
  await readFile(path.join(store.data, "admin.json")); // Fail closed until initialized.
  const last = await readOptional(path.join(store.data, "last-job.json"));
  if (last) publisher.job = JSON.parse(last);
  if (publisher.job?.status === "running") {
    const succeeded = (await store.current())?.id === publisher.job.id;
    publisher.job.status = succeeded ? "success" : "failed";
    publisher.job.message = succeeded
      ? "发布已完成"
      : "上次发布因服务退出而中断，原网站保持不变，可以重试";
  }
  const cookie = (token, maxAge) =>
    `wenying_session=${token}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
  const server = createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cache-Control", "no-cache");
    try {
      const url = new URL(req.url, origin);
      const pathname = decodeURIComponent(url.pathname);
      if (
        pathname.includes("\\") ||
        pathname.includes("\0") ||
        pathname.split("/").some(p => p.startsWith("."))
      )
        throw new HttpError(404, "页面不存在");
      if (pathname.startsWith("/admin")) {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Robots-Tag", "noindex, nofollow");
        res.setHeader(
          "Content-Security-Policy",
          "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: http:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
        );
      }
      if (pathname.startsWith("/admin/api/")) {
        const route = pathname.slice("/admin/api/".length);
        const write = !["GET", "HEAD"].includes(req.method);
        if (write && req.headers.origin !== origin)
          throw new HttpError(403, "请求来源无效，请使用配置的后台地址");
        if (route === "login" && req.method === "POST") {
          const value = await payload(req);
          const session = await auth.login(value.password, value.code);
          if (session.requiresTotp) return json(res, 200, session);
          res.setHeader("Set-Cookie", cookie(session.token, 43200));
          return json(res, 200, { csrf: session.csrf });
        }
        const session = auth.get(req);
        if (write && req.headers["x-csrf-token"] !== session.csrf)
          throw new HttpError(403, "会话校验失败，请刷新页面");
        if (route === "session" && req.method === "GET")
          return json(res, 200, { csrf: session.csrf });
        if (route === "security" && req.method === "GET")
          return json(res, 200, await auth.status());
        if (route === "security/setup" && req.method === "POST")
          return json(
            res,
            200,
            await auth.beginSetup(session, (await payload(req)).password)
          );
        if (route === "security/qr" && req.method === "GET") {
          const pending = session.pendingTotp;
          if (!pending || pending.expires <= Date.now())
            throw new HttpError(404, "绑定已过期");
          const uri = new TOTP({
            issuer: "Wenying",
            label: "管理员",
            secret: pending.secret,
          }).toString();
          const svg = await QRCode.toString(uri, {
            type: "svg",
            width: 224,
            margin: 4,
          });
          res.writeHead(200, { "Content-Type": "image/svg+xml" });
          return res.end(svg);
        }
        if (route === "security/confirm" && req.method === "POST") {
          const result = await auth.confirmSetup(
            session,
            (await payload(req)).code
          );
          res.setHeader("Set-Cookie", cookie("", 0));
          return json(res, 200, result);
        }
        if (route === "security/disable" && req.method === "POST") {
          const value = await payload(req);
          const result = await auth.disable(
            value.password,
            value.code,
            session
          );
          res.setHeader("Set-Cookie", cookie("", 0));
          return json(res, 200, result);
        }
        if (route === "logout" && req.method === "POST") {
          auth.sessions.delete(session.token);
          res.setHeader("Set-Cookie", cookie("", 0));
          return json(res, 200, { ok: true });
        }
        if (route === "posts" && req.method === "GET")
          return json(res, 200, await store.list());
        if (route === "post" && req.method === "GET")
          return json(res, 200, await store.get(url.searchParams.get("id")));
        if (route === "post" && req.method === "PUT")
          return json(res, 200, await store.save(await payload(req)));
        if (route === "preview" && req.method === "POST") {
          const value = await payload(req);
          const html = preview(value.body).replace(
            /src="\/images\/cms\/([a-f0-9-]{36}\.webp)"/g,
            'src="/admin/api/image/$1"'
          );
          return json(res, 200, { html });
        }
        if (route === "upload" && req.method === "POST")
          return json(
            res,
            200,
            await store.upload(await body(req, 8 * 1024 * 1024))
          );
        if (
          /^image\/[a-f0-9-]{36}\.webp$/.test(route) &&
          req.method === "GET"
        ) {
          const name = path.basename(route);
          try {
            return await serve(
              res,
              req,
              path.join(store.data, "uploads"),
              name
            );
          } catch (e) {
            if (e.code !== "ENOENT") throw e;
            return await serve(
              res,
              req,
              path.join(await store.sourceRoot(), "public/images/cms"),
              name
            );
          }
        }
        if (
          (route === "publish" || route === "delete") &&
          req.method === "POST"
        ) {
          const value = await payload(req);
          if (store.busy) throw new HttpError(409, "正在发布，请稍后再试");
          if (!value.id || !value.revision)
            throw new HttpError(400, "请先保存文章");
          const post = await store.get(value.id);
          if (
            route === "delete" &&
            ["about:page", "home:page"].includes(value.id)
          )
            throw new HttpError(400, "此页面不能删除");
          if (post.revision !== value.revision)
            throw new HttpError(409, "文章已更新，请重新打开");
          void publisher
            .publish(value.id, value.revision, { remove: route === "delete" })
            .catch(() => {});
          return json(res, 202, publisher.job);
        }
        if (route === "job" && req.method === "GET")
          return json(res, 200, publisher.job);
        throw new HttpError(404, "接口不存在");
      }
      if (!["GET", "HEAD"].includes(req.method))
        throw new HttpError(405, "不支持此操作");
      if (pathname === "/admin") {
        res.writeHead(302, { Location: "/admin/" });
        return res.end();
      }
      if (pathname === "/admin/")
        return await serve(res, req, ui, "index.html");
      if (["/admin/app.js", "/admin/style.css"].includes(pathname))
        return await serve(res, req, ui, path.basename(pathname));
      if (pathname.startsWith("/admin/"))
        throw new HttpError(404, "页面不存在");
      const current = await store.current();
      const root = current
        ? path.join(store.data, "releases", current.id, "dist")
        : path.join(store.root, "dist");
      return await serve(
        res,
        req,
        root,
        pathname === "/" ? "index.html" : pathname.slice(1),
        true
      );
    } catch (e) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const status =
        e.status ?? (e.code === "ENOENT" || e.code === "ENOTDIR" ? 404 : 500);
      json(res, status, {
        error:
          status === 500 ? "服务暂时无法完成操作，请检查服务器日志" : e.message,
      });
      if (status === 500) process.stderr.write(`${e.stack}\n`);
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return server;
}
