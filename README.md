# dsh-harmony-remote

> **⚠️ 重要提示 / Important**
>
> **本插件本身没有界面，它只是一个「后端桥」。必须配套一个鸿蒙遥控器前端 App（或任何能调用下面这些 REST 接口的客户端）才有实际用途——单独这一个后端，没人调它的接口，是无用的。**
>
> **This plugin alone has NO user interface — it is only a backend bridge. It becomes useful only when a front-end client (the HarmonyOS remote-control app, a browser page, or a curl script) actually calls its REST endpoints. A backend with no caller does nothing on its own.**

A local REST bridge that lets a **HarmonyOS phone app remote-control this DeepSeek Harness process** —
the same way the dsh web UI does.

It runs inside the dsh host process (it is a Cordis plugin, not a sidecar) and listens on
`127.0.0.1:3100` by default.

## Why it behaves like the web UI

The plugin does **not** reimplement any dsh logic. It calls the very same service the browser calls:

```
ctx.apiProxy.sessions.list | create | history | models | selectModel | prompt | cancel
```

So "switch model", "send a prompt", "read the transcript" and "cancel" have exactly the web UI's
semantics, including its validation, its model catalog, and its error codes.

## Layout

| Path | Role |
| --- | --- |
| `<DSH_HOME>\plugins\dsh-harmony-remote\` | **source of truth** — edit here |
| `...\plugins\dsh-harmony-remote\lib\index.js` | the whole plugin |
| `...\plugins\dsh-harmony-remote\test\smoke.mjs` | self-test (`node test/smoke.mjs`) |
| `<DSH_HOME>\profiles\web\node_modules\dsh-harmony-remote` | junction → source, so the profile can resolve it |
| `...\plugins\dsh-harmony-remote\node_modules\@deepseek-ai` | junction → profile peer packages, so imports resolve |

Both junctions are **additive**; nothing existing was moved or overwritten.

## Enable / disable

The plugin is already mounted in `<DSH_HOME>\profiles\web\cordis.patch.yml`
(backup: `cordis.patch.yml.bak-<timestamp>` in the same folder).

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

Restart dsh to apply. To disable, append `disabled: true` to that row (or remove the block and
restore the backup).

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `host` | `127.0.0.1` | bind address. Keep it loopback unless you set `token`. |
| `port` | `3100` | TCP port. Chosen because 3080 is the web UI. |
| `token` | `''` | when non-empty, every request must send `X-DSH-Token: <token>` |
| `exposeTool` | `true` | register the model-facing `harmony_remote_info` tool |

## API

All responses are `application/json`. Success is `{ "ok": true, ... }`; failure is
`{ "ok": false, "error": { "code", "message", "details"? } }` with a matching HTTP status.

### `GET /health`
Liveness. No session needed.
→ `{ ok, name, version, uptimeMs }`

### `GET /status`
Current model, session, and run state.
Query: `sessionId` (optional).
→ `{ ok, now, uptimeMs, bridge:{name,port,host,authRequired}, sessionId,
     running, agentStatus, model:{current,routable}, agentOptions:{provider,model},
     liveAgents:[{sessionId,status,running}] }`

### `GET /models`
The provider/model catalog the web UI's picker shows.
Query: `sessionId` (optional).
→ `{ ok, sessionId, current, routable, groups, failures }`

### `POST /model`
Switch the session's model.
Body: `{ "provider": "deepseek", "model": "deepseek-reasoner", "reasoningEffort"?, "sessionId"? }`
→ `{ ok, sessionId, selected:{provider,model,reasoningEffort?} }`
Errors: `400 bad-request` (missing field), `409 no-session`, `502 model-unavailable`.

### `POST /send`
Queue a prompt for the session.
Body: `{ "text": "…", "mode"?: "followup" | "steer", "sessionId"? }`

* `followup` (default) — queues an ordinary turn.
* `steer` — interrupts the current step at its next boundary.

→ `{ ok, sessionId, mode, accepted: true }`
Errors: `400 bad-request` (blank text), `409 no-session`, `502 agent-busy`.

### `GET /messages`
The transcript, as flat rows.
Query: `sessionId` (optional), `limit` (default 50, max 500).
→ `{ ok, sessionId, count, hasMore, messages:[{seq,role,text,source?,turn?,step?,interrupted?}] }`

Only `user/message` and `assistant/message` become rows; reasoning and tool blocks are skipped.

### `GET /sessions`
→ `{ ok, count, sessions:[…] }`

### `POST /sessions`
Create and attach a new session.
Body: any of `sessionId`, `cwd`, `workspaceId`, `agentPreset`.
→ `{ ok, sessionId, agentPreset }`

### `POST /cancel`
Stop the running turn, keeping queued work (`keepInbox`).
Body: `{ "sessionId"? }`
→ `{ ok, sessionId, cancelled: true }`

### `GET /tools`
Names of tools currently registered.
→ `{ ok, count, tools:[…] }`

### `GET /`
Alias of `/health`.

## Session targeting

An explicit `sessionId` always wins. Otherwise a session is inferred **only when unambiguous**:

1. this deployment's own session, when it is currently attached;
2. the single attached agent, when there is exactly one;
3. otherwise nothing — the request fails with `409 no-session`.

That conservatism is deliberate: a remote `send` that silently landed in the wrong conversation
would be worse than an error. `GET /status` lists every candidate under `liveAgents`, so the phone
app can offer a picker.

## Security

This API can drive the agent and read every transcript on the machine.

* It binds **loopback only** by default. Do not change `host` without setting `token`.
* Set `token` to a long random string and send it as `X-DSH-Token` before exposing it via any
  tunnel, port-forward, or `adb reverse`.
* `Access-Control-Allow-Origin: *` is set so a browser page can call it during development; the
  token is what actually gates access.

## Self-test

```
cd <DSH_HOME>\plugins\dsh-harmony-remote
node test/smoke.mjs
```

Runs the plugin against stubbed dsh services and exercises every route over a real socket —
auth, envelopes, transcript extraction, error mapping, and the tool schema. It does not need a
running dsh and does not touch the real bridge.
