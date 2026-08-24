# dsh 救急手册（RESCUE MANUAL）

> 本手册写给"dsh web 起不来 / GUI 打不开"时的你。
> 所有改动和救急工具都在持久卷 **`/data/dsh`** 下，**容器重建也不会丢**。
> 本文件位置：`/data/dsh/rescue/README.md`（host 侧绑定的就是同一份）。

---

## 0. 背景：这套环境改过什么（2026-08-21）

目的：给模型启用 `web_fetch`（网页抓取工具）。共 4 处改动：

| # | 改动 | 位置 | 当前状态 |
|---|------|------|---------|
| 1 | profile patch 插入 `web-fetch-http` provider | `/data/dsh/profiles/web/cordis.patch.yml` | ✅ 已启用（验证过） |
| 2 | 默认 agent preset 改为 `standard-fetch` | `/data/dsh/settings.yaml` | ✅ 已设置 |
| 3 | 自定义 preset「标准模式（含网页抓取）」 | `/data/dsh/.agent-presets/standard-fetch/` | ✅ 已创建 |
| 4 | 手工安装的 fetch 插件包 + 符号链接 | `/data/dsh/profiles/web/node_modules/@deepseek-ai/dsh-web-fetch-http/` 和 `/data/dsh/profiles/node_modules/` 下的同名链接 | ✅ 已安装 |

**重启前预检已通过**：完整状态在隔离环境真实 boot 成功（HTTP 200、稳定 50 秒+、无错误日志）。

---

## 1. 判断：服务为什么起不来

```bash
# 看容器日志，找这两行特征
docker logs <容器名> 2>&1 | tail -50
# 特征1: fatal load failure: ...
# 特征2: plugin(s) failed to load: ...
```

**原因 90% 是**：profile patch 里引用的插件包加载失败。dsh 的 fail-loud 机制是**硬编码**的——插件加载失败 = 进程直接退出，**没有降级开关**，所以必须回滚配置而不是"绕过"。

---

## 2. 救急步骤（从轻到重，每步做完重启试一次）

### 步骤 1：patch 恢复空层（最小动作，通常这一步就够）
```bash
cp /data/dsh/rescue/cordis.patch.yml.safe /data/dsh/profiles/web/cordis.patch.yml
# 等价于把 cordis.patch.yml 内容改成:
#   []
```

### 步骤 2：settings 恢复出厂（去掉默认 preset 覆盖）
```bash
cp /data/dsh/rescue/settings.yaml.safe /data/dsh/settings.yaml
```

### 步骤 3：一键全量回滚（含删 preset、删包、删符号链接）
```bash
sh /data/dsh/rescue/rescue.sh
# 会先把当前现场备份到 /data/dsh/rescue/backup/crash-<时间戳>/ 再动手
# 想先看它会做什么: DRY_RUN=1 sh /data/dsh/rescue/rescue.sh
```

> 步骤 1 + 2 已足够让 GUI 回来；步骤 3 是彻底回到"装 web_fetch 之前"的干净状态。

---

## 3. 容器挂了，怎么执行上面的命令（三种途径）

**途径 A：容器还活着（只是 GUI 崩了）**
```bash
docker exec -it <容器名> sh /data/dsh/rescue/rescue.sh
```

**途径 B：容器起不来，但 /data/dsh 是 host 的 bind mount**
直接在 host 上改文件（`/data/dsh/...` 就是 host 上的路径），例如：
```bash
# host 侧执行
cp /data/dsh/rescue/cordis.patch.yml.safe /data/dsh/profiles/web/cordis.patch.yml
```
改完 `docker start <容器名>`。

**途径 C：临时容器挂载卷来跑脚本**
```bash
docker run --rm -v /data/dsh:/data/dsh <镜像名> sh /data/dsh/rescue/rescue.sh
```

**补充**：`docker cp` 也可以往**已停止**的容器里覆盖文件：
```bash
docker cp /data/dsh/rescue/cordis.patch.yml.safe <容器名>:/data/dsh/profiles/web/cordis.patch.yml
```

---

## 4. 救回来之后：恢复 web_fetch

```bash
sh /data/dsh/rescue/restore-web-fetch.sh
# 从 /data/dsh/rescue/backup-good/ 恢复全部 4 处改动（patch + settings + preset + 包 + 符号链接）
# 然后重启 dsh web 服务
```

素材来源 `/data/dsh/rescue/backup-good/`（救急前的可用状态备份，含包本体），**请勿删除**。

---

## 5. 关键文件清单

| 路径 | 作用 | 安全值/备注 |
|------|------|------------|
| `/data/dsh/profiles/web/cordis.patch.yml` | profile 补丁层（主开关） | `[]` = 出厂空层 |
| `/data/dsh/settings.yaml` | 用户设置 | 仅 `permission.defaultPreset: danger-full-access` |
| `/data/dsh/.agent-presets/standard-fetch/` | 自定义 preset | 删掉 = 回到系统自带标准模式 |
| `/data/dsh/profiles/web/node_modules/@deepseek-ai/dsh-web-fetch-http/` | 手工安装的包（持久卷内） | 删掉 = 失去 fetch provider |
| `/data/dsh/profiles/node_modules/@deepseek-ai/dsh-web-fetch-http` | 解析链符号链接 → 指向上面 | 指向持久副本 |
| `/data/dsh/profiles/web/node_modules/@deepseek-ai/dsh-fileserve/` | 本地文件服务插件（/files/ 只读文本查看产物） | 删掉 = 链接打不开 |
| `/data/dsh/profiles/web/node_modules/@deepseek-ai/dsh-balance/` | /balance 命令插件（实时余额+用量+费用预估） | 删掉 = /balance 命令消失 |
| `/data/dsh/profiles/web/node_modules/@deepseek-ai/dsh-pwa/` | iOS 主屏安装（apple-touch-icon + standalone manifest） | 删掉 = iOS 添加主屏失效 |
| `/data/dsh/profiles/web/node_modules/@deepseek-ai/dsh-notify/` | 任务完成推送（Bark + Synology Chat） | 删掉 = 不推送 |
| `/data/dsh/rescue/` | 救急工具包（本手册 + 脚本 + 备份） | **不要删** |

---

## 6. 技术原理（给想排查的人，3 分钟版）

1. **插件解析锚点是 profile 目录，不是 dsh 安装目录**。loader 用 `baseUrl = /data/dsh/profiles/web/cordis.yml` 解析插件包名。
2. 启动时 `healProfilesModuleFallback` 只给 dsh 应用**依赖图内**的包在 `/data/dsh/profiles/node_modules/` 建符号链接；`dsh-web-fetch-http` 不在依赖图里，所以**必须**把包本体放进 `/data/dsh/profiles/web/node_modules/@deepseek-ai/`（解析链第一优先，且位于持久卷）。
3. 曾踩的坑：把包放进 `/usr/local/lib/node_modules/...`（镜像层）——容器**重建**会整体冲掉，必须放持久卷。
4. fail-loud：插件加载失败 → `assertEntriesLoaded` 抛错 / `installFailLoud` 退出进程，**无环境变量可关闭**，只能回滚配置。
5. agent preset 的 `tool-web` 行才是模型侧 `web_fetch` 的真正开关（host 平面的 tool-web 行是禁用的）；shipped preset 每个进程只挂载一次，改文件不生效，必须新建用户 preset。

---

## 7. 常见问题

- **Q：步骤 1+2 做完 GUI 还是打不开？**
  A：看 `docker logs`，把 `fatal load failure` 那一整行记下来；大概率是其它问题（端口、凭据、磁盘），不是本手册范围。

- **Q：暂时不想要 web_fetch 了？**
  A：只做步骤 1 + 2 即可；包和 preset 留着无害，GUI 照常。

- **Q：恢复 web_fetch 后新对话里还是没这个工具？**
  A：工具在会话启动时绑定，**必须新开对话**；确认 GUI 右上角/设置里当前预设是「标准模式（含网页抓取）」。

- **Q：怎么确认当前配置组合正确？**
  ```bash
  dsh --profile web --dump-config | grep -A4 web-fetch-http
  # 应看到 id: web-fetch-http / name: @deepseek-ai/dsh-web-fetch-http / timeoutMs: 60000
  ```

---

*最后更新：2026-08-21（救急工具包 + 预检完成）*
