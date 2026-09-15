# dsh-harmony-remote

> **⚠️ 重要提示 / Important**
>
> **本插件本身没有界面，它只是一个「后端桥」。必须配套一个鸿蒙遥控器前端 App（或任何能调用下面这些 REST 接口的客户端）才有实际用途——单独这一个后端，没人调它的接口，是无用的。**
>
> **This plugin alone has NO user interface — it is only a backend bridge. It becomes useful only when a front-end client (the HarmonyOS remote-control app, a browser page, or a curl script) actually calls its REST endpoints. A backend with no caller does nothing on its own.**

## 简介 / Introduction

> 中文：这是一个本地 REST 桥（bridge），让**鸿蒙手机 App 能像 dsh 自带的 Web UI 一样，远程操控本机的 DeepSeek Harness**。
>
> English: A local REST bridge that lets a **HarmonyOS phone app remote-control this DeepSeek Harness process** — the same way the dsh web UI does.

它运行在 dsh 宿主进程之内（是一个 **Cordis 插件**，不是独立旁路进程），默认监听 `127.0.0.1:3100`。

It runs inside the dsh host process (it is a Cordis plugin, not a sidecar) and listens on `127.0.0.1:3100` by default.

## 为什么行为和 Web UI 一致 / Why it behaves like the web UI

> 中文：本插件**没有重新实现** dsh 的任何逻辑，它调用的是浏览器在用的同一套服务。
>
> English: The plugin does **not** reimplement any dsh logic. It calls the very same service the browser calls:

```
ctx.apiProxy.sessions.list | create | history | models | selectModel | prompt | cancel
```

所以"切换模型 / 发送提示 / 读取会话 / 取消执行"这些操作，和 Web UI 的语义**完全一致**（包括校验、模型目录、错误码）。

## 目录结构 / Layout

> 说明：下表是插件在本机 DSH 里的常见放置方式。`<DSH_HOME>` 是你的 DSH 数据/配置目录根路径。

| Path | 作用 / Role |
| --- | --- |
| `<DSH_HOME>\plugins\dsh-harmony-remote\` | **源码主目录** — 在这里改代码（**source of truth — edit here**） |
| `...\plugins\dsh-harmony-remote\lib\index.js` | 整个插件的实现（the whole plugin） |
| `...\plugins\dsh-harmony-remote\test\smoke.mjs` | 自测脚本（self-test，用 `node test/smoke.mjs` 跑） |
| `<DSH_HOME>\profiles\web\node_modules\dsh-harmony-remote` | 一个 **junction（链接）** 指回源码目录，让 profile 能解析到该包 |
| `...\plugins\dsh-harmony-remote\node_modules\@deepseek-ai` | 另一个 **junction** 指向 profile 的 peer 包，让 import 能解析 |

那两个 junction 都是**增量添加**的（additive），不会移动或覆盖你已有的任何东西。

## 启用与停用 / Enable / disable

> 说明：插件默认已挂载在 `<DSH_HOME>\profiles\web\cordis.patch.yml`（同目录下有备份 `cordis.patch.yml.bak-<时间戳>`）。

```yaml
- insert:
    - id: harmony-remote
      name: 'dsh-harmony-remote'
      config:
        host: '127.0.0.1'
        port: 3100
        token: ''
        exposeTool: true
```

改完后**重启 dsh** 生效。若要停用，在该行加 `disabled: true`（或删掉这段并恢复备份）。

## 配置项 / Configuration

| Key | Default | 含义 / Meaning |
| --- | --- | --- |
| `host` | `127.0.0.1` | 绑定地址。**保持 loopback（本机回环）**，除非你设置了 `token`。 |
| `port` | `3100` | TCP 端口。选 3100 是因为 Web UI 用了 3080。 |
| `token` | `''` | 非空时，**每次请求必须带 `X-DSH-Token: <token>`** |
| `exposeTool` | `true` | 是否注册面向模型的 `harmony_remote_info` 工具 |

## 接口说明 / API

> 所有响应都是 `application/json`。成功返回 `{ "ok": true, ... }`；失败返回 `{ "ok": false, "error": { "code", "message", "details"? } }`，并配以对应的 HTTP 状态码。

### `GET /health` — 存活探测

> 心跳检测，无需会话。
> Liveness. No session needed.
→ `{ ok, name, version, uptimeMs }`

### `GET /status` — 当前状态

> 查询当前模型、会话和运行状态。
> Query: `sessionId` (可选/optional).
→ `{ ok, now, uptimeMs, bridge:{name,port,host,authRequired}, sessionId, running, agentStatus, model:{current,routable}, agentOptions:{provider,model}, liveAgents:[{sessionId,status,running}] }`

### `GET /models` — 模型列表

> Web UI 选择器里显示的 provider / model 目录。
> Query: `sessionId` (可选/optional).
→ `{ ok, sessionId, current, routable, groups, failures }`

### `POST /model` — 切换模型

> 切换当前会话的模型。
> Body: `{ "provider": "deepseek", "model": "deepseek-reasoner", "reasoningEffort"?, "sessionId"? }`
→ `{ ok, sessionId, selected:{provider,model,reasoningEffort?} }`
错误 / Errors: `400 bad-request`（缺字段）, `409 no-session`, `502 model-unavailable`.

### `POST /send` — 发送提示

> 往会话里投递一条 prompt。
> Body: `{ "text": "…", "mode"?: "followup" | "steer", "sessionId"? }`

* `followup`（默认）— 排队一个普通对话轮次（an ordinary turn）
* `steer` — 在当前 step 的下一个边界**打断**它（interrupts the current step at its next boundary）

→ `{ ok, sessionId, mode, accepted: true }`
错误 / Errors: `400 bad-request`（文本为空）, `409 no-session`, `502 agent-busy`.

### `GET /messages` — 读取会话记录

> 把会话原文展开成扁平行。
> Query: `sessionId` (可选/optional), `limit` (默认 50，最大 500).
→ `{ ok, sessionId, count, hasMore, messages:[{seq,role,text,source?,turn?,step?,interrupted?}] }`

只有 `user/message` 和 `assistant/message` 才会作为行返回；推理块和工具块会被跳过。

### `GET /sessions` — 会话列表

→ `{ ok, count, sessions:[…] }`

### `POST /sessions` — 新建/挂接会话

> Body: `sessionId`、`cwd`、`workspaceId`、`agentPreset` 均可选传一个。
→ `{ ok, sessionId, agentPreset }`

### `POST /cancel` — 取消当前执行

> 停止正在运行的 turn，保留排队中的任务（keepInbox）。
> Body: `{ "sessionId"? }`
→ `{ ok, sessionId, cancelled: true }`

### `GET /tools` — 已注册工具列表

> 返回当前注册的工具名。
→ `{ ok, count, tools:[…] }`

### `GET /` — 根路径

> 是 `/health` 的别名（Alias of `/health`）。

## 会话定位 / Session targeting

> 规则：显式传了 `sessionId` 就优先用它。否则只有当**没有歧义**时才自动推断：

1. 本部署自己的会话（当前已挂接的那个）；
2. 只有一个挂接 agent 时，就用那唯一的一个；
3. 都不满足时——**不强猜**，返回 `409 no-session`。

这种保守是**故意的**：一个远程 `send` 如果静默发到了错误的会话，比直接报错更糟。`GET /status` 会在 `liveAgents` 里列出所有候选，供手机 App 弹出选择器。

## 安全 / Security

> ⚠️ 这套 API 能操控 agent，并读取本机上的**所有会话原文**。

* 默认**只绑定 loopback**。请勿在不设 `token` 的情况下改 `host`。
* 设置一长串随机字符串作为 `token`，并在通过任何隧道（tunnel）、端口转发（port-forward）或 `adb reverse` 暴露前，用 `X-DSH-Token` 头带上它。
* 已设置 `Access-Control-Allow-Origin: *`，方便浏览器在开发期调用；真正管访问控制的是那个 `token`。

## 自测 / Self-test

```
cd <DSH_HOME>\plugins\dsh-harmony-remote
node test/smoke.mjs
```

> 这个脚本会**用桩（stub）dsh 服务跑一遍所有路由**（鉴权、信封、会话抽取、错误映射、工具 schema），走真实 socket。不需要一个正在运行的 dsh，也不会碰到真实的桥接实例。
