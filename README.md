# DeepSeek Harness Docker 自托管镜像

基于官方 npm 包 [`@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh) 构建的自托管 Docker 镜像,内置一个轻量的登录认证代理(`auth-proxy.js`,纯 Node、零依赖),并提供自动化构建与版本更新。

## 功能

- **前端登录页认证**:代替 basic auth 浏览器弹窗,提供独立的登录页面 + HttpOnly 签名会话 Cookie(HMAC 无状态,默认 7 天有效)
- **防爆破**:同一 IP 连错 5 次锁定 60 秒;支持 Cloudflare Tunnel 场景下按真实客户端 IP(`Cf-Connecting-Ip`)统计
- **双端口访问**:
  - `3080` HTTP:供反向代理 / 隧道回源 / SSH 隧道使用
  - `8443` HTTPS(可选):供局域网直连,启动时自动生成自签名证书
- **版本自动跟随**:GitHub Actions 自动查询 npm 最新版本并重建镜像,也可手动指定版本
- **可复现构建**:基础镜像 digest 固定,全部构建源码在仓库内

## 架构

```
浏览器 ──► auth-proxy (0.0.0.0:3080 HTTP / 0.0.0.0:8443 HTTPS)
              │  登录页 + 会话校验 + Host/Origin 改写
              ▼
          dsh web (127.0.0.1:3081, 仅回环监听)
```

`dsh web` 出于安全考虑只允许监听 `127.0.0.1`(禁止 `0.0.0.0`),因此对外访问统一由 `auth-proxy.js` 转发;转发时会改写 `Host`/`Origin` 为回环地址,以满足 dsh 内置的浏览器信任围栏(`/api` 防 DNS rebinding / 跨站请求,已实测不会被绕过)。

## 访问方式

| 场景 | 地址 | 说明 |
|---|---|---|
| 局域网直连 | `https://NAS_IP:8443` | 需设置 `HTTPS_ACCESS_HOST`;自签名证书,浏览器首次访问点一次"继续前往" |
| 外网(Cloudflare Tunnel 等) | 回源 `http://NAS_IP:3080` | 回源为明文 HTTP,无需"忽略证书"配置;浏览器连接的是隧道边缘的正式 HTTPS |
| SSH 隧道 | `http://localhost:3080` | `ssh -N -L 3080:127.0.0.1:3080 用户@NAS_IP` |

> 为什么局域网直连需要 HTTPS:`dsh` 前端会调用浏览器的 `crypto.randomUUID()`,它只在安全上下文(HTTPS 或 localhost)中可用。纯 HTTP 的 `http://NAS_IP:3080` 直连会导致 UI 报错。若以明文 HTTP 且非 localhost 方式打开登录页,页面会显示提示条提醒改用 HTTPS。

## 快速开始

### 方式一:GitHub Actions 自动构建(推荐)

仓库自带 `.github/workflows/build.yml`,推送到 GitHub 后自动构建并推送到 GHCR:

```
ghcr.io/<用户名>/dsh-nas:<版本>   (默认方案, 双端口)
ghcr.io/<用户名>/dsh-nas:latest
```

触发方式:

- 推送到 `main`(涉及 Dockerfile 等构建文件时)
- 每日 2 点自动巡检,有新版本才重建(版本未变自动跳过)
- Actions 页面手动 **Run workflow**,可指定版本与 npm 镜像

### 方式二:本地构建

```bash
./build.sh                    # 构建 npm latest 版本
./build.sh next               # 构建 npm next 版本 (尝鲜)
DSH_VERSION=0.1.0-rc.8 ./build.sh
NPM_REGISTRY=https://registry.npmmirror.com ./build.sh   # 国内 npm 镜像
```

### 部署(docker compose)

复制 `.env.example` 为 `.env` 并填写,然后:

```bash
docker compose up -d
```

`.env` 关键配置:

```env
DSH_AUTH_USERNAME=你的用户名
DSH_AUTH_PASSWORD=足够长的独立密码(至少12位)
HTTPS_ACCESS_HOST=192.168.1.100     # NAS 局域网 IP 或域名, 用于 8443 自签名证书
DSH_DATA_PATH=/实际路径/.../data     # 数据目录 (含对话记录)
WORKSPACE_PATH=/实际路径/.../workspace
```

## 配置项

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_AUTH_USERNAME` / `DSH_AUTH_PASSWORD` | 空 | 启用登录页认证;不设置则无认证(仅限可信网络) |
| `HTTPS_ACCESS_HOST` | 空 | 设置后启用 8443 HTTPS,自动生成该 IP/域名的自签名证书 |
| `DSH_SESSION_DAYS` | `7` | 会话有效期(天) |
| `DSH_AUTH_DEBUG` | `0` | 设为 `1` 输出登录调试日志 |
| `DSH_IMAGE` | `dsh-nas:latest` | compose 中指定镜像(如 `ghcr.io/<用户名>/dsh-nas:latest`) |

## 更新版本

```bash
# 方式一: 仓库 Actions 页面点 Run workflow (可指定版本)
# 方式二: 本地重新构建
./build.sh
docker compose up -d --force-recreate
```

## 镜像变体

| 镜像 | 说明 |
|---|---|
| `ghcr.io/<用户名>/dsh-nas` | 默认方案:auth-proxy 双端口(HTTP 3080 + HTTPS 8443) |
| `ghcr.io/<用户名>/dsh-nas-https` | Caddy 变体:单 HTTPS 端口 8443 + basic auth,适用于只需要一个 HTTPS 入口的场景 |

## 安全注意事项

- **公网访问必须设置 `DSH_AUTH_USERNAME/DSH_AUTH_PASSWORD`**,否则等于裸奔
- `dsh` 会执行项目命令,**只挂载允许 AI 操作的目录**,不要挂载 NAS 根目录
- 会话 Cookie 未设置 `Secure` 标志(以便双端口共用同一会话),局域网内明文传输,请仅在可信网络使用
- 会话密钥在容器启动时随机生成,容器重启后所有会话失效,重新登录即可
- 自签名证书仅用于局域网直连,首次访问需手动信任
- 修改环境变量后需 `docker compose up -d --force-recreate` 重建容器(仅 restart 不生效)

## 文件说明

| 文件 | 说明 |
|---|---|
| `Dockerfile` / `entrypoint.sh` | 默认方案构建与启动(双端口) |
| `auth-proxy.js` | 登录认证代理(纯 Node,零依赖) |
| `docker-compose.yml` / `.env.example` | compose 部署示例 |
| `build.sh` | 本地一键查版本 + 构建 + 打 latest 标签 |
| `.github/workflows/build.yml` | GitHub Actions 自动构建推送 |
| `Dockerfile.caddy` / `Caddyfile` / `entrypoint.caddy.sh` / `docker-compose.caddy.yml` | Caddy 变体构建与启动 |
