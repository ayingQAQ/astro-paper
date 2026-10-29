# 当前线上部署

- 域名：https://blog.pwbing.com
- 后台：https://blog.pwbing.com/admin/
- SSH：`ssh zouter`
- 仓库：`/opt/wenying`
- Compose 项目：`wenying`；配置：`deploy/cms/compose.yaml`；环境文件：`deploy/cms/.env`
- 数据卷：`wenying_blog-data`，含管理员信息、草稿、图片和发布版本。不要执行 `down -v`。
- Caddy 站点配置：`/etc/caddy/wenying.caddy`，通过现有 Caddyfile 导入；自动管理 HTTPS。
- 初始密码：服务器 `/root/wenying-admin-password`，权限仅 root 可读。登录后可绑定验证器。

在服务器仓库目录运行：

```sh
docker compose --env-file deploy/cms/.env -p wenying -f deploy/cms/compose.yaml ps
docker compose --env-file deploy/cms/.env -p wenying -f deploy/cms/compose.yaml logs --tail 100 blog
```

更新前备份数据卷，再停止容器、拉取代码、重建镜像、运行一次性构建并启动。具体流程见 CMS.md。停止服务后才能运行密码或验证器重置命令。

## Linux 构建兼容

CMS 发布目录通过符号链接共享 node_modules。Astro 7 在 Linux 下需要 `vite.resolve.preserveSymlinks: true` 保持编译模块路径一致；同时使用 pnpm 的 `nodeLinker: hoisted`，保证依赖内的传递导入可解析。两项配置需一起保留。

Docker 中提前调整 node_modules 所有者并缓存该层，后续仅修改源码时无需重新遍历依赖目录。

## 验收（2026-10-29）

已完成 Linux 容器实际构建、HTTPS 首页与后台访问、未登录 API 返回 401、密码登录及一次首页原内容重新发布；发布成功后正常退出测试会话。服务器 15 项 CMS 测试通过，本地 Astro check 为 0 错误、0 警告（2 项提示）。
