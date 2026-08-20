# 自建 DeepSeek Harness — 无 Caddy / 无强制 HTTPS / 前端登录页 / 可追新版本

针对 `ghcr.io/kanzuori197/deepseek-harness-nas` 的痛点重写:
**① 去掉 Caddy 和强制 HTTPS/自签名证书** → 局域网直接访问 `http://NAS_IP:3080`;
**② 告别 basic auth 浏览器弹窗** → 前端登录页面 + 会话 Cookie;
**③ 不锁死旧 rc 版本** → `build.sh` 或 GitHub Actions 自动追 npm 最新版。

## 为什么还需要一层反代?

官方 `dsh web` 出于安全考虑**禁止绑定 `0.0.0.0`**(实测报错:
"would expose remote code execution to the network"),`--host` 只接受
`127.0.0.1`。所以对外访问必须由本地进程转发——本方案用容器内的
**`auth-proxy.js`(纯 Node, 零依赖)** 同时承担:登录页 + 会话认证 + 转发。
不想在容器里跑反代的话,也可以用 SSH 隧道(见文末)。

## 认证方式(前端登录页, 非 basic auth)

- 设置了 `DSH_AUTH_USERNAME/DSH_AUTH_PASSWORD` → 打开 `http://NAS_IP:3080`
  先看到**登录页面**(表单, 不是浏览器弹窗),登录后发 **HttpOnly + SameSite
  签名 Cookie**(HMAC 无状态会话, 默认 7 天, 可用 `DSH_SESSION_DAYS` 改),
  页面右下角/`/logout` 可退出;
- 防爆破: 同一 IP 连错 5 次锁 60 秒(`DSH_AUTH_DEBUG=1` 可看登录日志);
- 不设账号密码 → **纯转发无认证**,只适合可信局域网。

## 浏览器信任围栏(已实测验证)

`dsh` 的 `/api` 有防 DNS rebinding / 跨站请求围栏,规则是:
- `Host` 必须是回环地址(或 `--trusted-host` 声明的地址);
- 浏览器标记(`Origin`、`Sec-Fetch-Site`)必须同源。

`auth-proxy.js` 转发时把 `Host` 和 `Origin` 都改写为上游回环地址,实测:
页面 + API 同源访问全部放行,而 `Host=LAN IP` 或 `Sec-Fetch-Site: cross-site`
的请求仍被 `403` 拦截——围栏没有被绕过。

## 端口分配(容器内部)

```
dsh web       127.0.0.1:3081   (仅回环, 官方禁止 0.0.0.0)
auth-proxy    0.0.0.0:3080     (对外: 登录页 + 转发)
```

## 快速开始

```bash
cd /workspace/projects/dsh-nas   # 拷到 NAS 后在此目录执行
cp .env.example .env             # 编辑 .env: 用户名/密码/路径
./build.sh                       # 构建 npm latest 版本 (当前 rc.7)
docker compose up -d
```

浏览器访问 `http://NAS_IP:3080`,先登录再使用。

## 更新版本(不再定死)

```bash
./build.sh            # 追 npm "latest" (稳定)
./build.sh next       # 追 npm "next" (最新尝鲜, 如 rc.8, 可能不稳)
DSH_VERSION=0.1.0-rc.8 ./build.sh   # 指定精确版本
docker compose up -d --force-recreate   # 重建容器应用新版本
```

`build.sh` 会用 docker 临时跑一个 `node:22-alpine` 去 npm 查最新版本号,再带
`DSH_VERSION` 参数构建,所以每次更新就是两行命令。国内网络可加
`NPM_REGISTRY=https://registry.npmmirror.com ./build.sh`。

## 内网穿透(节点小宝等)

回源填 `http://NAS_IP:3080` 即可,不再需要"跳过证书验证"。
**穿透到公网必须设置认证**,否则等于裸奔。

## 安全注意

- 明文 HTTP 只适合局域网;公网访问请务必开认证或挂你自己的 HTTPS 反代。
- 会话 Cookie 是签名无状态的,没有服务端存储;容器重启后随机密钥变化,
  所有会话失效,重新登录即可(可接受)。
- `dsh` 会**执行项目命令**,只挂载允许 AI 操作的目录,不要挂 NAS 根目录。
- 修改环境变量后需 `docker compose up -d --force-recreate`,只 restart 不生效。
- 构建需要网络(拉基础镜像 + npm 装包),国内建议配 docker 镜像加速 + npm 镜像。

## 文件说明

| 文件 | 用途 |
|---|---|
| `Dockerfile` / `entrypoint.sh` | 默认方案: auth-proxy 登录页 + 转发, `3080` 端口 |
| `auth-proxy.js` | 登录认证代理 (纯 Node 零依赖, 已在真实 dsh web 上实测) |
| `docker-compose.yml` / `.env.example` | 默认方案 compose |
| `build.sh` | 一键查版本 + 构建 + 打 latest 标签 |
| `Dockerfile.caddy` / `Caddyfile` / `entrypoint.caddy.sh` / `docker-compose.caddy.yml` | 可选 HTTPS 变体, 等价于 ghcr.io 原镜像 |

## 对比 ghcr.io/kanzuori197/deepseek-harness-nas

| | ghcr.io 原镜像 | 本方案 (默认) |
|---|---|---|
| 协议 | HTTPS 自签名证书 | 纯 HTTP |
| 访问 | `https://NAS:8443` + 证书警告 | `http://NAS:3080` 无警告 |
| 版本 | 固定 0.1.0-rc.6 | `build.sh`/Actions 一键追 latest/next |
| 认证 | basic auth 浏览器弹窗 | 前端登录页 + 会话 Cookie |
| 反代 | Caddy | Node auth-proxy (或 SSH 隧道) |
| 可复现 | 仓库无 Dockerfile | 全部源码在本目录, 基础镜像 digest 固定 |

## 不想在容器里跑反代?SSH 隧道方案

本机(客户端)执行,不向局域网开放任何端口:

```bash
ssh -N -L 3080:127.0.0.1:3080 用户名@NAS_IP
# 然后浏览器访问 http://localhost:3080
```

此时 dsh web 仍在容器里只监听 127.0.0.1, 隧道转发本地请求, 围栏天然通过。

## GitHub Actions 自动构建(推荐, 不依赖本机 Docker)

本目录自带 `.github/workflows/build.yml`,把整个目录推到 GitHub 后会自动:
1. 查询 npm 上 `@deepseek-ai/dsh` 的最新版本;
2. 构建两个镜像并推送到你的 GHCR:
   - `ghcr.io/<你的用户名>/dsh-nas:<版本>` + `:latest` (登录页方案)
   - `ghcr.io/<你的用户名>/dsh-nas-https:<版本>` + `:latest` (Caddy HTTPS 方案)
3. 每天 2 点自动检查一次, 有新版本才重建(版本没变会自动跳过);
   也可以去 Actions 页面点 **Run workflow** 手动指定版本构建。

使用步骤:

```bash
# 1. 在 GitHub 新建一个空仓库 (public 或 private 都行)
# 2. 把本目录所有文件(含 .github/)提交推送
# 3. 等 Actions 跑完, NAS 上:
cd 你的部署目录
DSH_IMAGE=ghcr.io/你的用户名/dsh-nas:latest docker compose up -d
# 或写进 .env: DSH_IMAGE=ghcr.io/你的用户名/dsh-nas:latest
```

注意:
- **public 仓库** → GHCR 镜像公开, NAS 直接拉取无需登录;
- **private 仓库** → 镜像也是 private, NAS 上要先
  `docker login ghcr.io -u 你的用户名`(用 PAT, 需 `write:packages` 权限)。
- 构建环境用 GitHub 官方 ubuntu runner, 无需你本机装 Docker。
