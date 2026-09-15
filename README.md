# dsh-harmony-remote

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

### `GET /events`
Long poll for confirmation requests. Query: `since` (cursor, `0` on first call).
Holds the request up to 25 s; returns immediately when an event arrives.
→ `{ ok, cursor, events:[{ cursor, type:'confirm_request'|'confirm_resolved', id, kind:'approval'|'question', payload }] }`

`payload` for `kind:'approval'` is `{ toolName, reason, sessionId }`;
for `kind:'question'` it is `{ sessionId, questions:[{ id, header, question, options?, multiSelect?, detail? }] }`.

`multiSelect` and `detail` must travel with the question. Without them a client cannot know that a
question accepts several answers, nor show the plan a `plan-review` question is asking about — so it
degrades to "tap one option and it is submitted", with no way to change your mind.

**A `confirm_request` is only returned while it is still pending.** Once it is answered, withdrawn,
or expired it disappears from the stream (its `confirm_resolved` receipt stays). Without that filter
a client starting at `since=0` replays the whole backlog and pops dialogs for requests that no longer
exist — tapping one can only ever fail with `404 unknown-confirm`.

### `POST /confirm`
Answer a mirrored confirmation from the phone.
Body: `{ "id": "cf-…", "answer": … }` where `answer` is `{ outcome }` for approvals
(`allowed-once` | `rejected` | `cancelled`) or `{ answers:[{ id, selected:[…], custom? }] }` for questions.
→ `{ ok, id }`
Errors: `400 bad-request`, `404 unknown-confirm` (expired or never issued), `409 already-resolved`.

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

## Approval / question mirroring

DSH's two "ask a human" paths are mirrored to the phone; the desktop dialog stays up and the first
answer wins. Both are installed from `ctx.effect`, so unloading the plugin restores the originals.

* **Approval** — a listener on the `approval/request` waterfall, wrapped *outside* the web UI's own
  listener. Only `allowed-once` / `rejected` / `cancelled` are accepted; anything else is discarded
  and the native dialog decides. Sandbox semantics are untouched: this can never widen a deny.
* **Questions** — `userQuestions.ask` is wrapped (a second `registerProvider` would throw
  `DUPLICATE_PROVIDER`). The wrapper must resolve to **`{ answers: [...] }`**, because
  `dsh-tool-ask-user` reads `(await ask(...)).answers`; each item needs `id` (not `questionId`) and
  `selected`. `normalizeAnswers()` enforces both, accepting `questionId` for older app builds.

Two constants matter and must not be conflated:

| constant | value | meaning |
| --- | --- | --- |
| `EVENT_HOLD_MS` | 25 s | how long one `GET /events` request may hang (keep it under the client's 30 s read timeout) |
| `ANSWER_TIMEOUT_MS` | 5 min | how long a human has to answer before the pending record is discarded |

Whoever answers first wins, and the loser's request is **withdrawn**: a late tap on the losing side
gets `409 already-resolved` instead of a success that quietly did nothing. Dismissing the phone
dialog sends **nothing** — replying `cancelled` would genuinely cancel an approval instead of
deferring to the desktop.

**The desktop dialog closes when the phone answers.** The web UI drops its wait on a
`question/resolved` / `approval/resolved` mux frame, and the only host-side trigger for those is the
abort listener apiproxy registers on the request's signal. So the bridge hands the native path a
signal of its own (`desktopOnlySignal()`) and aborts it once the phone's answer has won:

* The **caller's** signal is never aborted. Aborting it would make `dsh-user-approval` race its own
  outcome to `'cancelled'` — the user's "allow once" would silently become a cancellation.
* The abort happens **after** `Promise.race` settles. Aborting earlier lets the downstream
  settlement (approval `'cancelled'` / question `ASK_ABORTED`) reach the race first and win.
* Questions take a copy of the request (`{...request, signal}`); approvals cannot, because cordis's
  waterfall `next()` takes no arguments — there `req.signal` is replaced in place. The only runtime
  listener on `approval/request` is apiproxy's, and `dsh-user-approval` captured the original signal
  before entering the waterfall, so the blast radius is exactly the desktop dialog.

The approval bridge **must** register with `{ prepend: true }`. cordis dispatches waterfalls as a
chain: apiproxy's listener returns its own promise without calling `next()` whenever it matches an
approval, and this plugin is inserted after every bundle — registered normally it would sit *behind*
apiproxy and never run at all, so no approval would ever reach the phone.

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
