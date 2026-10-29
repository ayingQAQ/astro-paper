# Wenying 写作后台

一个单管理员的轻量后台：写 Markdown、上传图片、保存草稿、预览、发布。前台仍使用现有 AstroPaper 页面。无需数据库；复用 YAML、markdown-it、sanitize-html 与 Sharp。

## 本地启动

要求 Node.js 24（建议最新 24.x LTS）、pnpm 11。

```sh
pnpm install --frozen-lockfile
pnpm cms:init
pnpm cms:build
pnpm cms:start
```

`cms:init` 交互设置至少 12 字符密码，输入不回显。后台为 `http://localhost:4444/admin/`，博客为 `http://localhost:4444/`。初始化和首次构建都在服务启动前完成。

原来的 `pnpm dev` / 4321 仍用于开发前台源码；**CMS 发布更新的是 4444 服务的网站**，不会回写开发目录。

可复制 `.env.cms.example` 为 `.env.cms` 调整端口、数据路径和域名。访问地址须与 `CMS_ORIGIN` 一致（localhost 和 127.0.0.1 不等价）。密码只保存为加盐 scrypt 散列。不要把密码放进公开配置或提交 Git。

## 日常写作

1. 登录后选择“写文章”，或打开已有文章。
2. 写正文，可使用工具栏，也可直接写 Markdown。图片可点击上传、拖入或粘贴，最大 8 MB / 4000 万像素。图片转为 WebP 并移除元数据；动图仅保留首帧。
3. 在“文章设置”填写摘要、标签等；文件地址可在首次保存前修改，之后固定。设备本地时间会转换为标准时间保存。
4. “保存草稿”仅保存私有工作副本。修改已发布文章不会立刻影响线上内容。Ctrl/Cmd+S 保存。
5. “预览”查看安全的 Markdown 排版。原始 HTML 不执行，MDX 组件仅以源码方式处理；正式站点仍由 Astro 渲染。既有文章的额外字段保留。
6. “发布”会先保存，再构建新网站和搜索索引；成功后网站切换到新版本，失败时原站点继续工作。构建日志在编辑器下方。构建期间暂不接受其他保存/发布。

**修改关于页：** 在文章列表右上角点击“关于”。可编辑标题、正文和可选摘要，支持同样的图片上传、预览、草稿与发布流程；不会出现文章专用的标签或发布时间。关于页发布后仍位于 `/about/`，也不会混入文章列表。备份/导出时一并保留当前版本的 `src/content/pages`。

**删除文章：** 打开文章，在编辑页底部点击“删除文章”并确认。网站重新构建成功后，文章及对应草稿才会移除；构建失败保留原内容，可重试。历史发布版本仍可用于恢复；图片暂时保留，避免影响其他文章的引用。关于页不能删除。

初版不提供定时任务、多账号、独立媒体库或自动 Git 提交。未来发布时间请先留作草稿，到时手动发布。公开 Git 仓库中的原有文章本来就是公开的；只有新建私有工作副本不对外提供。

## 通用 Linux：原生 Node.js

支持具备 Node.js 24 和所需原生依赖的常见 Linux 系统。应用不调用 apt/yum/dnf，不依赖 systemd。下面的目录可以按自己的系统更改。

1. 将仓库放在 `/opt/wenying`；使用非 root 账号安装依赖。
2. 设置可写私有数据目录（如 `/var/lib/wenying`，权限 700，归服务账号所有）。
3. 设置环境变量，再运行初始化、首次构建、启动命令：

```sh
export CMS_DATA_DIR=/var/lib/wenying
export CMS_ORIGIN=https://blog.example.com
export CMS_HOST=127.0.0.1
export CMS_PORT=4444
pnpm cms:init
pnpm cms:build
pnpm cms:start
```

4. 用 Nginx/Caddy 等将 HTTPS 域名下所有请求代理到 `127.0.0.1:4444`。后台 `/admin/` 与博客同源，不能仅转发 API。参考 `deploy/cms/nginx.conf`；证书由你的反向代理管理。
5. 需要 systemd 时使用 `deploy/cms/wenying.service`，按实际 Node 路径、服务用户、工作目录修改。将上述环境变量放在 `/etc/wenying.env`（限制读取权限），systemd 直接读取它；其他 init 系统使用同一个 `node cms/cli.mjs serve` 命令。

上线前将 `astro-paper.config.ts` 中 `site.url`、作者、个人链接改成实际值，避免 canonical/RSS/sitemap 仍使用模板域名。

## Docker Compose（推荐）

镜像使用 Node 24 的 Debian/glibc 环境，减少宿主发行版差异。需要 Docker Engine 和 Compose 插件。

```sh
export CMS_ORIGIN=https://blog.example.com
docker compose -f deploy/cms/compose.yaml build
docker compose -f deploy/cms/compose.yaml run --rm blog node cms/cli.mjs init
docker compose -f deploy/cms/compose.yaml run --rm blog node cms/cli.mjs build
docker compose -f deploy/cms/compose.yaml up -d
```

数据保存在 `blog-data` 命名卷，端口仅绑定宿主本机。外部 HTTPS 代理配置与原生方式相同。不要使用 `down -v`，它会删除内容数据。不要将 CMS 容器直接暴露在公网 HTTP。

## 备份、更新与恢复

数据目录包含：

- `admin.json`：密码散列；`drafts/`：私有草稿；`uploads/`：暂存图片。
- `releases/<id>/src/content/posts/`：该版本文章；`public/images/cms/`：已发布上传图片；`dist/`：静态站点。
- `current.json`：当前发布版本与上个版本；`last-job.json`：最近发布记录。

备份整个数据目录，并备份配置和代码。勾选「记住此设备 30 天」后，会话以凭证哈希保存在私有目录的 sessions.json，重启后仍有效；未勾选时会话保留 12 小时，服务重启后需重新登录。退出登录、重设密码、绑定或重置验证器会撤销相应会话。数据目录必须在网页根目录之外，不要交给 Nginx 直接作为静态目录公开。

**更新代码：** 先停止后台，备份数据，拉取代码/更新镜像、安装依赖，运行 `cms:build`（容器使用上述一次性 build 命令），成功后启动服务。构建会使用现有已发布文章，而不是仓库中的旧文章。首次构建前才从仓库导入内容。

**密码重置：** 停止后台，再运行 `cms:init`，设置新密码后重启。非交互环境可临时传入 `CMS_PASSWORD`，运行后从环境中移除。

**回退：** 停止服务、备份 `current.json`，将目标成功版本的 `release.json` 复制为数据目录的 `current.json`，再启动服务。每个版本保留源文章和站点，回退后草稿仍在。复制前确保该目录包含 `dist/index.html`。

**导出到 GitHub：** 停止后台，读取 `current.json` 的 `id`，将对应版本的 `src/content/posts` 和 `public/images/cms` 复制到工作仓库，审阅差异后提交。草稿不要复制到公开仓库。初版不会自动同步 GitHub。

发布版本会累积；定期备份后，停止服务再清理不再需要的旧版本和失败版本。至少保留 `current.json` 指向的当前版本与 previous 版本。暂存图片不会自动删除，以防草稿引用丢失。

## 验证与限制

```sh
pnpm cms:test
pnpm lint
pnpm build
```

服务默认仅支持单进程和单数据目录写入，不支持多副本共享写入。文件锁通过心跳阻止重复进程；异常退出后最多等待 30 秒锁过期。容器同样仅运行一个服务实例。构建会使用 CPU/内存，并可能需要联网下载配置的 Google 字体，建议至少 2 GB 内存。Sharp 和 Pagefind 需要支持宿主 CPU/libc；使用容器可减少差异，但没有实测的发行版不视为已验证。

# 首页介绍

文章列表右上角点击「首页」，即可编辑欢迎标题和正文介绍（支持 Markdown 和图片）。展开「页面设置」可以修改 GitHub、X、LinkedIn 和邮箱链接，留空会隐藏相应图标。全部留空则隐藏社交链接区域。保存草稿不会改变网站，点击「发布」并等待构建完成后生效。首页内容与关于页一样独立保存，不出现在文章列表，也不能删除整个页面。

# 验证器动态码

登录后台后，点击顶部「登录安全」，输入管理员密码，用验证器 App 扫码（也可以手动输入密钥），输入 6 位动态码后确认启用。二维码有效期为 10 分钟，超时可返回文章列表再进入重新绑定。二维码由服务器本地生成，不发送给第三方。

绑定后会退出所有后台会话。重新登录时先输入密码，再输入验证器的**下一组**动态码；成功使用过的动态码不能重复使用。验证码每 30 秒更新，服务器应开启系统时间同步。未绑定时保留原来的密码登录。

更换验证器：进入「登录安全」，用密码与新的有效动态码关闭原验证器，再登录并绑定新设备。输错凭据可在原页面重试；多次失败会暂时限制验证。

遗失验证器：通过 SSH 登录服务器，**先停止 CMS 服务**，在项目目录执行 `pnpm cms:reset-totp`，再启动服务并重新绑定。Docker 部署可在停止服务后执行 `docker compose run --rm blog pnpm cms:reset-totp`（使用部署目录的 compose 文件和相同数据卷）。此命令只重置验证器，不改变管理员密码或文章；`pnpm cms:init` 重设密码会保留验证器。

验证码密钥保存在私有数据目录的 `admin.json`，请限制该目录及备份的读取权限。迁移服务器时一并迁移私有数据目录。不需要新增数据库、短信或邮件服务。
