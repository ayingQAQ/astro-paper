import {
  cp,
  mkdir,
  readdir,
  lstat,
  symlink,
  writeFile,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  HttpError,
  atomicWrite,
  serializePost,
  contentPath,
  readOptional,
  parsePost,
} from "./content.mjs";

// Copy regular files only: never follow a content symlink out of its tree.
export async function copyTree(from, to, exclude = new Set()) {
  await mkdir(to, { recursive: true });
  for (const item of await readdir(from, { withFileTypes: true })) {
    if (exclude.has(item.name) || item.isSymbolicLink()) continue;
    const src = path.join(from, item.name),
      dst = path.join(to, item.name);
    if (item.isDirectory()) await copyTree(src, dst, exclude);
    else if (item.isFile()) await cp(src, dst);
  }
}
function command(bin, args, cwd, onLog) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd,
      windowsHide: true,
      env: {
        ...process.env,
        NODE_ENV: "production",
        ASTRO_TELEMETRY_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        child.kill("SIGKILL");
      },
      10 * 60 * 1000
    );
    child.stdout.on("data", b => onLog(b.toString()));
    child.stderr.on("data", b => onLog(b.toString()));
    child.on("error", e => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", code => {
      clearTimeout(timer);
      code === 0
        ? resolve()
        : reject(
            new Error(
              timedOut
                ? "构建超时，请检查网络与服务器资源"
                : `构建失败（退出码 ${code}）`
            )
          );
    });
  });
}
export async function buildSite(stage, onLog) {
  const require = createRequire(path.join(stage, "package.json"));
  const astro = path.join(
    path.dirname(require.resolve("astro/package.json")),
    "bin/astro.mjs"
  );
  const pagefind = path.join(stage, "node_modules/pagefind/lib/runner/bin.cjs");
  await command(astro, ["build"], stage, onLog);
  await command(pagefind, ["--site", "dist"], stage, onLog);
}
export class Publisher {
  constructor(store, build = buildSite) {
    this.store = store;
    this.build = build;
    this.job = null;
  }
  async publish(id, revision, { remove = false } = {}) {
    if (this.store.busy) throw new HttpError(409, "正在发布，请稍后再试");
    this.store.busy = true;
    this.job = {
      id: randomUUID(),
      status: "running",
      startedAt: new Date().toISOString(),
      message: "正在准备发布",
      log: "",
      operation: remove ? "delete" : "publish",
      postId: id,
    };
    const stage = path.join(this.store.data, "releases", this.job.id);
    let promoted = false;
    try {
      await atomicWrite(
        path.join(this.store.data, "last-job.json"),
        JSON.stringify(this.job)
      );
      const post = id ? await this.store.get(id) : null;
      if (remove && (!post || ["about:page", "home:page"].includes(id)))
        throw new HttpError(400, "不能删除此页面");
      if (post && post.revision !== revision)
        throw new HttpError(409, "文章已更新，请重新保存后发布");
      if (!remove && post && new Date(post.pubDatetime).getTime() > Date.now())
        throw new HttpError(400, "发布时间不能晚于现在；未来文章请先保存草稿");
      await mkdir(stage, { recursive: true });
      await copyTree(
        path.join(this.store.root, "src"),
        path.join(stage, "src")
      );
      const source = await this.store.sourceRoot();
      // Start with the current published content, not stale checkout posts.
      if (source !== this.store.root) {
        const { rm } = await import("node:fs/promises");
        await rm(path.join(stage, "src/content/posts"), {
          recursive: true,
          force: true,
        });
        await copyTree(
          path.join(source, "src/content/posts"),
          path.join(stage, "src/content/posts")
        );
        await copyTree(
          path.join(source, "src/content/pages"),
          path.join(stage, "src/content/pages")
        );
      }
      await copyTree(
        path.join(this.store.root, "public"),
        path.join(stage, "public"),
        new Set(["pagefind"])
      );
      if (source !== this.store.root) {
        try {
          await copyTree(
            path.join(source, "public/images/cms"),
            path.join(stage, "public/images/cms")
          );
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
      }
      for (const file of await readdir(this.store.root)) {
        if (
          /^(astro.*\.ts|tsconfig\.json|package\.json|pnpm-lock\.yaml)$/.test(
            file
          )
        )
          await cp(path.join(this.store.root, file), path.join(stage, file));
      }
      if (post && remove) {
        await unlink(path.join(stage, contentPath(post.id))).catch(e => {
          if (e.code !== "ENOENT") throw e;
        });
      }
      if (post && !remove) {
        const file = path.join(stage, contentPath(post.id));
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, serializePost(post, true));
        const images = new Set(
          post.body.match(/\/images\/cms\/[a-f0-9-]{36}\.webp/g) ?? []
        );
        for (const url of images) {
          const dest = path.join(stage, "public", url);
          await mkdir(path.dirname(dest), { recursive: true });
          const src = path.join(this.store.data, "uploads", path.basename(url));
          try {
            await cp(src, dest);
          } catch (e) {
            if (e.code !== "ENOENT") throw e;
            await lstat(dest);
          }
        }
      }
      // No shell interpolation. Dependencies are shared read-only with the isolated build.
      try {
        await symlink(
          path.join(this.store.root, "node_modules"),
          path.join(stage, "node_modules"),
          process.platform === "win32" ? "junction" : "dir"
        );
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      let unpublishedDeletion = false;
      if (remove && (await this.store.current())) {
        const publishedSource = await readOptional(
          path.join(source, contentPath(id))
        );
        unpublishedDeletion =
          publishedSource === null ||
          parsePost(publishedSource).metadata.draft === true;
      }
      if (unpublishedDeletion) {
        this.job.message = "正在删除草稿";
        // Drafts do not contribute pages or search entries. Preserve the entire
        // public snapshot while atomically promoting the updated content tree.
        await copyTree(path.join(source, "dist"), path.join(stage, "dist"));
      } else {
        this.job.message = "正在生成页面";
        await this.build(stage, text => {
          this.job.log = (this.job.log + text).slice(-16000);
          if (text.includes("Pagefind")) this.job.message = "正在更新搜索索引";
        });
      }
      await lstat(path.join(stage, "dist/index.html"));
      const previous = await this.store.current();
      const publishedDrafts = { ...previous?.publishedDrafts };
      if (previous?.post)
        publishedDrafts[previous.post.id] = previous.post.revision;
      if (post) publishedDrafts[post.id] = post.revision;
      const manifest = {
        id: this.job.id,
        previous: previous?.id ?? null,
        publishedAt: new Date().toISOString(),
        publishedDrafts,
      };
      await atomicWrite(
        path.join(stage, "release.json"),
        JSON.stringify(manifest)
      );
      await atomicWrite(
        path.join(this.store.data, "current.json"),
        JSON.stringify(manifest)
      );
      promoted = true;
      if (post)
        await unlink(this.store.draftFile(post.id)).catch(e => {
          if (e.code !== "ENOENT") throw e;
        });
      this.job.status = "success";
      this.job.message = remove
        ? "文章已删除，网站已更新"
        : "发布完成，网站已更新";
    } catch (e) {
      this.job.status = promoted ? "success" : "failed";
      this.job.message = promoted
        ? "网站已更新；草稿清理失败，请重新打开文章确认"
        : e.message;
    } finally {
      this.store.busy = false;
      this.job.finishedAt = new Date().toISOString();
      await atomicWrite(
        path.join(this.store.data, "last-job.json"),
        JSON.stringify(this.job)
      );
    }
    return this.job;
  }
}
