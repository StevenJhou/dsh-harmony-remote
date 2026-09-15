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

### `GET /events` — 确认事件长轮询（confirm 多端同步）

> 用于**多端同步确认问答**：手机端轮询这个接口，就能收到和电脑端同时弹的确认对话框。
> English: Long-poll for confirmation requests. A phone polls this to receive the same dialogs the desktop shows.
> Query: `since`（游标，首次传 `0` / cursor, `0` on first call）
> 单次最长挂起 25 秒；有事件到达立即返回。Holds the request up to 25 s; returns immediately when an event arrives.
→ `{ ok, cursor, events:[{ cursor, type:'confirm_request'|'confirm_resolved', id, kind:'approval'|'question', payload }] }`

* `kind: 'approval'`（审批）的 `payload`: `{ toolName, reason, sessionId }`
* `kind: 'question'`（提问）的 `payload`: `{ sessionId, questions:[{ id, header, question, options?, multiSelect?, detail? }] }`

> 说明：`multiSelect` 和 `detail` 必须随问题一起发出，否则客户端无法知道该问题可多选、也无法展示 `plan-review` 类问题要看的方案详情。**`confirm_request` 只在请求仍「待处理」时返回**；一旦已被回答/撤销/过期，就从流里消失（其 `confirm_resolved` 回执仍在）。这样从 `since=0` 开始轮询的客户端不会重放历史积压、弹一堆已失效的框。

### `POST /confirm` — 提交手机端确认结果

> 手机端对镜像的确认框作答后回传，让 DSH 继续执行。
> English: Answer a mirrored confirmation from the phone.
> Body: `{ "id": "cf-…", "answer": … }`
> 其中 `answer` 对于审批(approval)是 `{ outcome }`（取 `allowed-once` | `rejected` | `cancelled`）；
> 对于提问(question)是 `{ answers:[{ id, selected:[…], custom? }] }`。
→ `{ ok, id }`
错误 / Errors: `400 bad-request`, `404 unknown-confirm`（已过期或从未发出）, `409 already-resolved`（已被另一端答过）

### `GET /tools` — 已注册工具列表

> 返回当前注册的工具名。
→ `{ ok, count, tools:[…] }`

### `GET /` — 根路径

> 是 `/health` 的别名（Alias of `/health`）。

## 确认问答镜像 / Approval & question mirroring

> 中文：DSH 的两套「问人」机制——**审批（approval）**和**提问（ask_user_question）**——会被**镜像**到手机端；电脑端的原生对话框仍然保留，**谁先回答谁生效**。
>
> English: DSH's two "ask a human" paths are mirrored to the phone; the desktop dialog stays up and the first answer wins.

两者都通过 `ctx.effect` 安装，**卸载插件即恢复原状**。

* **审批 Approval**：监听 `approval/request` waterfall，挂在 Web UI 自己的监听器**外层（prepend）**。只接受 `allowed-once` / `rejected` / `cancelled`，其余一律丢弃并让原生对话框决定。**沙箱语义不变——绝不会放宽一个 deny。**
* **提问 Question**：`userQuestions.ask` 被包裹（第二次 `registerProvider` 会抛 `DUPLICATE_PROVIDER`，所以只能包裹不可重复注册）。包裹器必须解析成 `{ answers: [...] }`，因为 `dsh-tool-ask-user` 读的是 `(await ask(...)).answers`；每条需要 `id`（不是 `questionId`）和 `selected`。`normalizeAnswers()` 会强制这两点，同时为旧版 App 兼容 `questionId`。

两个关键常量 / two constants:

| constant | value | 含义 / meaning |
| --- | --- | --- |
| `EVENT_HOLD_MS` | 25 s | 一次 `GET /events` 最多挂起多久（须小于客户端 30s 读超时） |
| `ANSWER_TIMEOUT_MS` | 5 min | 人类有多长作答时间，超时该待处理的记录会被丢弃 |

> 谁先答谁赢，输的一侧请求被**撤销（withdrawn）**：事后补点会收到 `409 already-resolved`，而不是「看似成功实则没生效」。**手机端对话框被关闭时什么都不发**——回 `cancelled` 会真的取消一个审批，而不是让电脑端继续处理。
>
> **手机端作答后，电脑端对话框会关闭。** Web UI 依赖 `question/resolved` / `approval/resolved` 的 mux 帧来停止等待，而宿主侧唯一能触发这些的是 apiproxy 在请求 signal 上注册的中止监听器。所以桥会**给原生路径一个自己的 signal**（`desktopOnlySignal()`），当手机端答案胜出后把它 abort：
> * 调用方的 signal **从不**被 abort（否则 `dsh-user-approval` 会把结果竞态成 `'cancelled'`，用户的允许会悄悄变成取消）
> * abort 发生在 `Promise.race` 落定**之后**（提前 abort 会让下游的 `'cancelled'` / `ASK_ABORTED` 先到并胜出）
> * 提问会复制一份 request（`{...request, signal}`）；审批不能，因为 cordis 的 waterfall `next()` 不带参数，只能原地替换 `req.signal`。运行时唯一在 `approval/request` 上的监听器是 apiproxy 的，且 `dsh-user-approval` 进入 waterfall 前已捕获了原始 signal，所以影响范围正好是电脑端那个对话框。
>
> 审批桥**必须以 `{ prepend: true }` 注册**：cordis 把 waterfall 当链派发，apiproxy 的监听器一旦匹配某个审批就返回自己的 promise 且不调用 `next()`；本插件是后插入的，如果正常注册会**排到 apiproxy 后面永远不执行**，那样审批就永远不会到达手机端。

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
