import {
  mkdir,
  readFile,
  writeFile,
  rename,
  readdir,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import YAML from "yaml";
import MarkdownIt from "markdown-it";
import sanitize from "sanitize-html";
import sharp from "sharp";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const isPageId = id => id === "about:page" || id === "home:page";
export function safeId(id) {
  if (isPageId(id)) return id;
  if (
    typeof id !== "string" ||
    id.length > 240 ||
    !/\.(md|mdx)$/.test(id) ||
    path.basename(id).startsWith("_") ||
    id
      .split("/")
      .some(p => !p || p.startsWith(".") || /[\\:\x00-\x1f<>"|?*]/.test(p))
  )
    throw new HttpError(400, "文章地址不合法");
  return id;
}
export function contentPath(id) {
  safeId(id);
  return isPageId(id)
    ? `src/content/pages/${id.split(":")[0]}.md`
    : `src/content/posts/${id}`;
}
export async function readOptional(file) {
  try {
    return await readFile(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
export async function atomicWrite(file, text) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, text, { mode: 0o600 });
  await rename(temp, file);
}
export async function containedFile(root, relative) {
  const file = path.resolve(root, relative);
  if (!file.startsWith(path.resolve(root) + path.sep))
    throw new HttpError(400, "无效路径");
  const actualRoot = await realpath(root);
  const actual = await realpath(file);
  if (!actual.startsWith(actualRoot + path.sep))
    throw new HttpError(403, "不允许访问目录外的文件");
  return actual;
}
const hash = text => createHash("sha256").update(text).digest("hex");
export function parsePost(text) {
  const match = text.match(
    /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/
  );
  if (!match) throw new HttpError(400, "文章缺少 Markdown 元信息");
  const metadata = YAML.parse(match[1], { maxAliasCount: 20 });
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    throw new HttpError(400, "文章元信息格式错误");
  return { metadata, body: match[2].replace(/^\r?\n/, "") };
}
export function serializePost(post, published = false) {
  if (isPageId(post.id)) {
    return `---\n${YAML.stringify({ ...post.metadata, title: post.title, description: post.description, ...(post.id === "home:page" ? { socials: post.socials } : {}) })}---\n\n${post.body}`;
  }
  const metadata = {
    ...post.metadata,
    title: post.title,
    description: post.description,
    author: post.author,
    tags: post.tags,
    featured: post.featured,
    pubDatetime: new Date(post.pubDatetime).toISOString(),
    draft: !published,
  };
  if (published) metadata.modDatetime = new Date().toISOString();
  return `---\n${YAML.stringify(metadata)}---\n\n${post.body}`;
}
const markdown = new MarkdownIt({ html: false, linkify: true });
export function preview(body) {
  return sanitize(markdown.render(String(body).slice(0, 500000)), {
    allowedTags: [...sanitize.defaults.allowedTags, "img"],
    allowedAttributes: {
      ...sanitize.defaults.allowedAttributes,
      img: ["src", "alt", "title"],
      code: ["class"],
    },
    allowedSchemes: ["http", "https", "mailto"],
  });
}
export class ContentStore {
  constructor(root, data) {
    this.root = path.resolve(root);
    this.data = path.resolve(data);
    if (
      this.data === this.root ||
      ["public", "dist", "src", "cms", "node_modules"].some(name => {
        const dir = path.join(this.root, name);
        return this.data === dir || this.data.startsWith(dir + path.sep);
      })
    )
      throw new Error(
        "CMS_DATA_DIR 必须是独立的私有数据目录，不能放在源码或公开目录中"
      );
    this.busy = false;
  }
  async init() {
    for (const dir of ["drafts", "uploads", "releases"])
      await mkdir(path.join(this.data, dir), { recursive: true, mode: 0o700 });
  }
  async current() {
    const text = await readOptional(path.join(this.data, "current.json"));
    return text ? JSON.parse(text) : null;
  }
  async sourceRoot() {
    const current = await this.current();
    return current ? path.join(this.data, "releases", current.id) : this.root;
  }
  draftFile(id) {
    return path.join(this.data, "drafts", `${hash(safeId(id))}.json`);
  }
  async get(id) {
    safeId(id);
    const draft = await readOptional(this.draftFile(id));
    if (draft) {
      const saved = JSON.parse(draft);
      const release = await this.current();
      const revision =
        release?.publishedDrafts?.[id] ??
        (release?.post?.id === id ? release.post.revision : null);
      if (revision !== saved.revision) return saved;
    }
    const source = await this.sourceRoot();
    let file;
    try {
      file = await containedFile(source, contentPath(id));
    } catch (e) {
      if (e.code === "ENOENT" && id === "home:page" && source !== this.root) {
        file = await containedFile(this.root, contentPath(id));
      } else if (e.code === "ENOENT") throw new HttpError(404, "文章不存在");
      else throw e;
    }
    const text = await readFile(file, "utf8");
    const { metadata, body } = parsePost(text);
    return {
      id,
      kind: isPageId(id) ? "page" : "post",
      revision: hash(text),
      metadata,
      body,
      title: metadata.title,
      description: metadata.description,
      socials: metadata.socials ?? [],
      author: metadata.author ?? "Wenying",
      tags: metadata.tags ?? [],
      featured: metadata.featured ?? false,
      pubDatetime: new Date(metadata.pubDatetime ?? 0).toISOString(),
      status: metadata.draft ? "draft" : "published",
      updatedAt: metadata.modDatetime ?? metadata.pubDatetime,
      format: path.extname(id).slice(1),
    };
  }
  async list() {
    const ids = new Set();
    const walk = async (dir, prefix = "") => {
      for (const item of await readdir(dir, { withFileTypes: true })) {
        if (item.isSymbolicLink() || item.name.startsWith(".")) continue;
        if (item.isDirectory())
          await walk(path.join(dir, item.name), prefix + item.name + "/");
        else if (!item.name.startsWith("_") && /\.(md|mdx)$/.test(item.name))
          ids.add(prefix + item.name);
      }
    };
    await walk(path.join(await this.sourceRoot(), "src/content/posts"));
    for (const file of await readdir(path.join(this.data, "drafts"))) {
      if (file.endsWith(".json"))
        ids.add(
          JSON.parse(
            await readFile(path.join(this.data, "drafts", file), "utf8")
          ).id
        );
    }
    const rows = await Promise.all(
      [...ids]
        .filter(id => !isPageId(id))
        .map(id =>
          this.get(id).catch(e => {
            if (e.status === 404) return null;
            throw e;
          })
        )
    );
    return rows
      .filter(Boolean)
      .map(({ body: _body, metadata: _metadata, ...row }) => row)
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }
  async save(input) {
    if (this.busy) throw new HttpError(409, "正在发布，请稍后保存");
    // Reserve the write across awaits to prevent simultaneous stale writes.
    this.busy = true;
    try {
      safeId(input.id);
      let previous;
      try {
        previous = await this.get(input.id);
      } catch (e) {
        if (e.status !== 404) throw e;
      }
      if ((previous?.revision ?? null) !== (input.revision ?? null))
        throw new HttpError(409, "文章已在其他窗口更新，请重新打开后编辑");
      const title = String(input.title ?? "").trim();
      const description = String(input.description ?? "").trim();
      const body = String(input.body ?? "");
      if (
        !title ||
        title.length > 200 ||
        (!description && !isPageId(input.id)) ||
        description.length > 500 ||
        body.length > 500000
      )
        throw new HttpError(400, "请填写标题和摘要，正文不得超过 50 万字符");
      const pubDatetime = input.pubDatetime || new Date().toISOString();
      if (!Number.isFinite(new Date(pubDatetime).getTime()))
        throw new HttpError(400, "发布时间无效");
      const tags = input.tags ?? [];
      if (
        !Array.isArray(tags) ||
        tags.length > 20 ||
        tags.some(t => typeof t !== "string" || t.length > 60)
      )
        throw new HttpError(400, "标签格式无效");
      const socials = input.socials ?? previous?.socials ?? [];
      if (
        input.id === "home:page" &&
        (!Array.isArray(socials) ||
          socials.length > 4 ||
          socials.some(
            item =>
              !item ||
              !["github", "x", "linkedin", "mail"].includes(item.name) ||
              typeof item.url !== "string" ||
              item.url.length > 2048 ||
              !/^(https?:\/\/[^\s]+|mailto:[^\s@]+@[^\s@]+)$/.test(item.url)
          ))
      )
        throw new HttpError(
          400,
          "社交链接请使用完整的 http/https 地址或 mailto: 邮箱地址"
        );
      const post = {
        id: input.id,
        kind: isPageId(input.id) ? "page" : "post",
        revision: randomUUID(),
        title,
        description,
        socials,
        body,
        author: String(input.author || "Wenying").slice(0, 100),
        pubDatetime,
        tags,
        featured: !!input.featured,
        metadata: previous?.metadata ?? {},
        status: previous && previous.status !== "draft" ? "modified" : "draft",
        updatedAt: new Date().toISOString(),
        format: path.extname(input.id).slice(1),
      };
      await atomicWrite(this.draftFile(input.id), JSON.stringify(post));
      return post;
    } finally {
      this.busy = false;
    }
  }
  async upload(buffer) {
    if (!buffer.length || buffer.length > 8 * 1024 * 1024)
      throw new HttpError(400, "图片大小应在 1 字节到 8 MB 之间");
    try {
      const image = sharp(buffer, { limitInputPixels: 40000000 });
      const meta = await image.metadata();
      if (!["jpeg", "png", "webp", "gif", "avif"].includes(meta.format))
        throw new Error("format");
      const bytes = await image.rotate().webp({ quality: 88 }).toBuffer();
      const name = `${randomUUID()}.webp`;
      await writeFile(path.join(this.data, "uploads", name), bytes, {
        mode: 0o600,
      });
      return {
        url: `/images/cms/${name}`,
        previewUrl: `/admin/api/image/${name}`,
      };
    } catch {
      throw new HttpError(
        400,
        "请上传有效的 JPG、PNG、WebP、GIF 或 AVIF 图片（最多 4000 万像素）"
      );
    }
  }
}
