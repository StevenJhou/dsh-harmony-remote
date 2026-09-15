/**
 * Self-test for dsh-harmony-remote.
 *
 * Runs the plugin against a STUBBED `apiProxy`/`agents`/`tools` (the real ones
 * only exist inside a booted dsh host), then exercises every HTTP route over a
 * real socket. This proves the bridge itself — routing, auth, JSON envelopes,
 * transcript extraction, error mapping — without needing a dsh restart.
 *
 * Usage:  node test/smoke.mjs
 */
import { apply, name as pluginName, Config, inject } from '../lib/index.js'
import { tmpdir } from 'node:os'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const PORT = 3199
const BASE = `http://127.0.0.1:${PORT}`
const TOKEN = 'smoke-token'

/** Build the `{ rpcId, result }` envelope apiProxy uses. */
const okReply = (req, value) => ({ rpcId: req.rpcId, result: { ok: true, value } })
const errReply = (req, code, message) => ({ rpcId: req.rpcId, result: { ok: false, error: { code, message, details: {} } } })

/** Recorded calls, so the test can assert what the plugin actually asked for. */
const calls = []

const apiProxyStub = {
  sessions: {
    async list(req) {
      calls.push(['list', req.payload])
      return okReply(req, { items: [{ sessionId: 'session-a', title: 'Demo' }, { sessionId: 'session-b', title: 'Other' }] })
    },
    async models(req) {
      calls.push(['models', req.payload])
      return okReply(req, {
        current: { provider: 'deepseek', model: 'deepseek-flash' },
        routable: true,
        groups: [{ provider: 'deepseek', models: [{ model: 'deepseek-flash' }, { model: 'deepseek-reasoner' }] }],
        failures: [],
      })
    },
    async selectModel(req) {
      calls.push(['selectModel', req.payload])
      if (req.payload.model === 'nope') return errReply(req, 'model-unavailable', 'no such model')
      return okReply(req, { selected: { provider: req.payload.provider, model: req.payload.model } })
    },
    async prompt(req) {
      calls.push(['prompt', req.payload])
      return okReply(req, { accepted: true })
    },
    async history(req) {
      calls.push(['history', req.payload])
      return okReply(req, {
        hasMore: false,
        events: [
          { seq: 0, type: 'turn/start', data: { turn: 1 } },
          { seq: 1, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '帮我看下首页' }], source: { kind: 'user' } } },
          { seq: 2, type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '好的' }, { type: 'reasoning', text: '（思考）' }, { type: 'text', text: '，先读文件。' }] } } },
          { seq: 3, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' } },
          { seq: 4, type: 'assistant/message', data: { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: '改好了。' }] }, interrupted: true } },
        ],
      })
    },
    async create(req) {
      calls.push(['create', req.payload])
      return okReply(req, { sessionId: req.payload.sessionId ?? 'session-new', agentPreset: 'standard' })
    },
    async cancel(req) {
      calls.push(['cancel', req.payload])
      return okReply(req, { accepted: true })
    },
  },
}

/**
 * 上传会真的落盘，用系统临时目录，绝不碰任何工程目录。
 * 注：测试刻意不做删除清理 —— 任务的安全红线禁止一切删除类操作，
 * 临时目录交给操作系统自己回收。
 */
const WORKSPACE = join(tmpdir(), 'dsh-harmony-remote-smoke')
mkdirSync(WORKSPACE, { recursive: true })

const agentsStub = {
  list: () => [{ id: 'session-a', status: 'running', options: { provider: 'deepseek', model: 'deepseek-flash' } }],
  // sessionCwd() 读的是 agent.session.header.cwd —— 上传就写进这个目录
  get: (id) => (id === 'session-a'
    ? { id: 'session-a', status: 'running', options: {}, session: { header: { cwd: WORKSPACE } } }
    : undefined),
}

const registeredTools = []
let disposeEffect = null

/** confirm-approval 注册的事件监听器（审批桥），供断言用。 */
const eventListeners = []

/** userQuestions 桩：真实服务只允许一个 provider，这里模拟「网页端已注册」。 */
let questionProviderAsk = async () => [{ questionId: 'q1', selected: ['native'] }]
const userQuestionsStub = {
  ask(request) {
    return questionProviderAsk(request)
  },
}

const ctx = {
  get(service) {
    if (service === 'apiProxy') return apiProxyStub
    if (service === 'agents') return agentsStub
    if (service === 'tools') return { list: () => registeredTools }
    if (service === 'userQuestions') return userQuestionsStub
    return undefined
  },
  // confirm-approval 模块用 ctx.on('approval/request', ...) 装审批桥
  on(event, listener, options) {
    eventListeners.push({ event, listener, options })
    return () => {}
  },
  effect(fn) {
    const d = fn()
    if (typeof d === 'function') disposeEffect = d
    return { dispose: () => {} }
  },
  tools: { register: (definition) => { registeredTools.push(definition); return () => {} } },
  logger: { info: (m) => console.log(`  [dsh log] ${m}`), warn: (m) => console.log(`  [dsh warn] ${m}`), error: (m) => console.log(`  [dsh err] ${m}`) },
}

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`)
  } else {
    failures++
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`)
  }
}

async function req(method, path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  let json = null
  try {
    json = text === '' ? null : JSON.parse(text)
  } catch {
    json = { __unparsed: text }
  }
  return { status: res.status, json }
}

async function main() {
  console.log(`\n=== dsh-harmony-remote self-test ===`)
  check('exports name', pluginName === 'harmony-remote', pluginName)
  check('exports inject', Array.isArray(inject) && inject.includes('tools'), inject)
  check('exports Config schema', typeof Config === 'function')

  apply(ctx, { host: '127.0.0.1', port: PORT, token: TOKEN, exposeTool: true })
  await new Promise((r) => setTimeout(r, 400))

  console.log('\n-- auth --')
  const noToken = await req('GET', '/health')
  check('rejects a request without the token', noToken.status === 401, noToken)

  const auth = { 'X-DSH-Token': TOKEN }

  console.log('\n-- GET /health --')
  const health = await req('GET', '/health', undefined, auth)
  check('health 200 ok', health.status === 200 && health.json.ok === true, health)

  console.log('\n-- GET /status --')
  const status = await req('GET', '/status', undefined, auth)
  check('status resolves model + running state', status.json.ok && status.json.model?.current?.model === 'deepseek-flash' && status.json.running === true, status.json)
  check('status reports agent options', status.json.agentOptions?.model === 'deepseek-flash', status.json.agentOptions)

  console.log('\n-- GET /models --')
  const models = await req('GET', '/models', undefined, auth)
  check('models lists the catalog', models.json.ok && models.json.groups.length === 1 && models.json.routable === true, models.json)

  console.log('\n-- POST /model --')
  const switched = await req('POST', '/model', { provider: 'deepseek', model: 'deepseek-reasoner' }, auth)
  check('model switch succeeds', switched.json.ok && switched.json.selected.model === 'deepseek-reasoner', switched.json)

  const badModel = await req('POST', '/model', { provider: 'deepseek', model: 'nope' }, auth)
  check('model failure surfaces as 502 + error', badModel.status === 502 && badModel.json.error.code === 'model-unavailable', badModel.json)

  const missingField = await req('POST', '/model', { model: 'deepseek-flash' }, auth)
  check('missing provider -> 400', missingField.status === 400 && missingField.json.error.code === 'bad-request', missingField.json)

  console.log('\n-- POST /send --')
  const sent = await req('POST', '/send', { text: '你好，看看首页' }, auth)
  const sentCall = calls.filter((c) => c[0] === 'prompt').pop()
  check('send accepted', sent.json.ok && sent.json.accepted === true, sent.json)
  check('send forwards text as a text block', sentCall?.[1]?.content?.[0]?.text === '你好，看看首页', sentCall?.[1])
  check('send defaults to followup mode', sentCall?.[1]?.mode === 'followup', sentCall?.[1])

  const steer = await req('POST', '/send', { text: '停一下', mode: 'steer' }, auth)
  const steerCall = calls.filter((c) => c[0] === 'prompt').pop()
  check('steer mode passed through', steer.json.ok && steerCall?.[1]?.mode === 'steer', steerCall?.[1])

  const empty = await req('POST', '/send', { text: '   ' }, auth)
  check('empty text -> 400', empty.status === 400 && empty.json.error.code === 'bad-request', empty.json)

  console.log('\n-- GET /messages --')
  const messages = await req('GET', '/messages', undefined, auth)
  check('messages extracts user + assistant rows only', messages.json.ok && messages.json.count === 3, messages.json)
  check('user text extracted', messages.json.messages?.[0]?.role === 'user' && messages.json.messages[0].text === '帮我看下首页', messages.json.messages?.[0])
  check('assistant text blocks joined, reasoning excluded', messages.json.messages?.[1]?.text === '好的，先读文件。', messages.json.messages?.[1])
  check('interrupted flag carried', messages.json.messages?.[2]?.interrupted === true, messages.json.messages?.[2])

  console.log('\n-- GET /sessions + POST /sessions --')
  const sessions = await req('GET', '/sessions', undefined, auth)
  check('sessions listed', sessions.json.ok && sessions.json.count === 2, sessions.json)

  const created = await req('POST', '/sessions', { agentPreset: 'standard' }, auth)
  const createCall = calls.filter((c) => c[0] === 'create').pop()
  check('session created', created.json.ok && created.json.sessionId === 'session-new', created.json)
  check('create forwards agentPreset', createCall?.[1]?.agentPreset === 'standard', createCall?.[1])
  check('create drops unknown keys', createCall?.[1]?.bogus === undefined, createCall?.[1])

  console.log('\n-- POST /cancel --')
  const cancelled = await req('POST', '/cancel', {}, auth)
  check('cancel accepted', cancelled.json.ok && cancelled.json.cancelled === true, cancelled.json)

  console.log('\n-- routing --')
  const notFound = await req('GET', '/nope', undefined, auth)
  check('unknown route -> 404 with route list', notFound.status === 404 && Array.isArray(notFound.json.routes), notFound.json)

  const badJson = await fetch(`${BASE}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth }, body: '{not json' })
  check('malformed JSON -> 400', badJson.status === 400, badJson.status)

  console.log('\n-- POST /upload (multipart, 手搓真实二进制体) --')
  const textContent = '这是一份测试文本\nline2\n'
  const boundary = '----dshSmokeBoundary1234567890'
  const multipartBody = Buffer.concat([
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from('Content-Disposition: form-data; name="sessionId"\r\n\r\n'),
    Buffer.from('session-a\r\n'),
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from('Content-Disposition: form-data; name="file"; filename="note.txt"\r\n'),
    Buffer.from('Content-Type: text/plain\r\n\r\n'),
    Buffer.from(textContent, 'utf8'),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  const upRes = await fetch(`${BASE}/upload`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, ...auth },
    body: multipartBody,
  })
  const uploaded = JSON.parse(await upRes.text())
  check('multipart upload accepted', upRes.status === 200 && uploaded.ok === true, uploaded)
  check('text file classified as kind=file', uploaded.kind === 'file', uploaded.kind)
  check('no image payload for a text file', uploaded.image === null, uploaded.image)
  check('sessionId from the form field is honoured', uploaded.sessionId === 'session-a', uploaded.sessionId)
  check('file landed inside the session workspace', existsSync(uploaded.file?.path), uploaded.file?.path)
  check('workspace path is under dsh-uploads',
    typeof uploaded.file?.path === 'string' && uploaded.file.path.includes('dsh-uploads'), uploaded.file?.path)
  check('written bytes round-trip exactly',
    existsSync(uploaded.file?.path) && readFileSync(uploaded.file.path, 'utf8') === textContent,
    uploaded.file?.path)
  check('relPath is workspace-relative',
    typeof uploaded.file?.relPath === 'string' && uploaded.file.relPath.startsWith('dsh-uploads/'),
    uploaded.file?.relPath)

  console.log('\n-- POST /upload (JSON + base64, 最小 1x1 PNG) --')
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const upJson = await req('POST', '/upload',
    { name: 'dot.png', dataBase64: pngBase64, sessionId: 'session-a' }, auth)
  check('json upload accepted', upJson.json.ok === true, upJson.json)
  check('png classified as kind=image', upJson.json.kind === 'image', upJson.json.kind)
  check('image mediaType detected from extension', upJson.json.image?.mediaType === 'image/png', upJson.json.image?.mediaType)
  check('image returned as base64 for /send', upJson.json.image?.data === pngBase64, String(upJson.json.image?.data).slice(0, 16))

  console.log('\n-- POST /send 携带附件 --')
  const sendWithFiles = await req('POST', '/send', {
    text: '看看这个文件',
    fileRefs: [uploaded.file.relPath],
    images: [{ mediaType: upJson.json.image.mediaType, data: upJson.json.image.data, name: 'dot.png' }],
  }, auth)
  const attachCall = calls.filter((c) => c[0] === 'prompt').pop()
  check('send with attachments accepted', sendWithFiles.json.ok === true, sendWithFiles.json)
  check('reply reports the image count', sendWithFiles.json.imageCount === 1, sendWithFiles.json.imageCount)
  check('text part tells the agent where the file is',
    attachCall?.[1]?.content?.[0]?.text?.includes(uploaded.file.relPath) === true,
    String(attachCall?.[1]?.content?.[0]?.text).slice(0, 140))
  check('image part uses the web-UI wire shape (type/mediaType/data)',
    attachCall?.[1]?.content?.[1]?.type === 'image'
      && attachCall[1].content[1].mediaType === 'image/png'
      && attachCall[1].content[1].data === pngBase64,
    attachCall?.[1]?.content?.[1])

  const imageOnly = await req('POST', '/send',
    { text: '', images: [{ mediaType: 'image/png', data: pngBase64 }] }, auth)
  check('image-only send allowed (text may be empty)', imageOnly.json.ok === true, imageOnly.json)

  const stillEmpty = await req('POST', '/send', { text: '   ' }, auth)
  check('truly empty send still rejected', stillEmpty.status === 400, stillEmpty.json)

  console.log('\n-- upload 的拒绝路径 --')
  const badType = await fetch(`${BASE}/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', ...auth },
    body: Buffer.from('xx'),
  })
  check('unsupported content-type -> 415', badType.status === 415, badType.status)

  const noAuthUpload = await fetch(`${BASE}/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'x.txt', dataBase64: 'aGk=' }),
  })
  check('upload without token -> 401', noAuthUpload.status === 401, noAuthUpload.status)

  const noFilePart = await fetch(`${BASE}/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data; boundary=zzz', ...auth },
    body: Buffer.from('--zzz\r\nContent-Disposition: form-data; name="sessionId"\r\n\r\nsession-a\r\n--zzz--\r\n'),
  })
  check('multipart without a file part -> 400', noFilePart.status === 400, noFilePart.status)

  console.log('\n-- GET /status 的运行态字段 --')
  const st = await req('GET', '/status?sessionId=session-a', undefined, auth)
  check('status exposes idle=false while running', st.json.idle === false, st.json.idle)
  check('status exposes hasPending', st.json.hasPending === false, st.json.hasPending)
  check('status exposes queuedTurns', st.json.queuedTurns === 0, st.json.queuedTurns)

  console.log('\n-- 超大 body：必须干净回 413，而不是掐断连接 --')
  // 回归测试：原来这里调 req.destroy() 直接把 socket 干掉，客户端只能看到
  // 鸿蒙的 2300056「连接被重置」，真实原因完全丢失。
  const tooBig = await fetch(`${BASE}/model`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024) }),
  })
  const tooBigJson = await tooBig.json().catch(() => null)
  check('超出上限 -> HTTP 413（不是连接重置）', tooBig.status === 413, tooBig.status)
  check('413 带可读的错误码', tooBigJson?.error?.code === 'body-too-large', tooBigJson?.error?.code)
  check('413 的提示里给出替代做法',
    typeof tooBigJson?.error?.message === 'string' && tooBigJson.error.message.includes('/upload'),
    tooBigJson?.error?.message)

  console.log('\n-- /send 的上限已单独放宽（要装得下 base64 图片）--')
  const bigSend = await req('POST', '/send', { text: 'x'.repeat(2 * 1024 * 1024) }, auth)
  check('2MB 的 /send 能被接受（旧的 1MB 上限会拒）',
    bigSend.status === 200 && bigSend.json.ok === true, bigSend.status)

  console.log('\n-- 服务端重启过：客户端攥着超前的旧游标也不能漏事件 --')
  {
    // 模拟 dsh 刚重启：服务端 eventCursor=0，而手机 App 还记着重启前的游标 999。
    // 若服务端照直按 `cursor > 999` 过滤，紧接着发出的事件（游标 1）会被静默吞掉。
    questionProviderAsk = () => new Promise(() => {})
    const polling = req('GET', '/events?since=999', undefined, auth)
    await new Promise((r) => setTimeout(r, 50))
    const raced = userQuestionsStub.ask({
      questions: [{ id: 'qc', question: '重启后第一条', options: [{ label: 'A' }] }],
      agent: { id: 'session-a' },
    })
    const ev = await polling
    const live = (ev.json.events ?? []).filter((e) => e.type === 'confirm_request')
    check('超前游标被判定为「服务端重启过」并重置，事件照收', live.length === 1, ev.json)
    check('响应里的 cursor 也把客户端拉回新纪元', typeof ev.json.cursor === 'number' && ev.json.cursor <= 2, ev.json.cursor)
    if (live.length === 1) {
      await req('POST', '/confirm', { id: live[0].id, answer: { answers: [{ id: 'qc', selected: ['A'] }] } }, auth)
    }
    await raced
  }

  console.log('\n-- confirm-approval：审批桥 --')
  check('已注册 approval/request 监听器',
    eventListeners.some((e) => e.event === 'approval/request'),
    eventListeners.map((e) => e.event))
  const approvalHook = eventListeners.find((e) => e.event === 'approval/request')
  const approvalListener = approvalHook?.listener
  // 回归：必须是 prepend。cordis 的 waterfall 是链式的，apiproxy 的监听器
  // 排在前面且匹配到审批就不调 next()；不 prepend 的话这个桥永远轮不到执行。
  check('审批桥用 { prepend: true } 注册（否则被 apiproxy 截胡，永远不执行）',
    approvalHook?.options?.prepend === true, approvalHook?.options)

  {
    // 场景 1：鸿蒙端先答 -> 鸿蒙的 allowed-once 生效（原生框故意慢 1.5s）
    // 同时模拟 apiproxy 的「网页端弹框」监听器：它只认收到的那个 req.signal，
    // 一旦 abort 就 conclude（广播 approval/resolved，框自己关掉）。
    let desktopSettled = false
    let desktopSignal = null
    const native = (req) => new Promise((r) => {
      desktopSignal = req.signal
      if (req.signal !== undefined) {
        req.signal.addEventListener('abort', () => { desktopSettled = true; r('cancelled') }, { once: true })
      }
      setTimeout(() => r('rejected'), 1500)
    })
    const callerA = new AbortController()
    const reqA = { toolName: 'pwsh', reason: '需要提权', agent: { id: 'session-a' }, signal: callerA.signal }
    const raced = approvalListener(reqA, () => native(reqA))

    const ev = await req('GET', '/events?since=0', undefined, auth)
    const confirmEvent = (ev.json.events ?? []).filter((e) => e.type === 'confirm_request').pop()
    check('鸿蒙端收到 confirm_request', confirmEvent !== undefined, ev.json.events)
    check('confirm_request 带 toolName/reason',
      confirmEvent?.payload?.toolName === 'pwsh' && confirmEvent?.payload?.reason === '需要提权',
      confirmEvent?.payload)
    check('审批桥给下游换了一条替身信号（不是调用方原本那条）',
      desktopSignal !== null && desktopSignal !== undefined && desktopSignal !== callerA.signal,
      typeof desktopSignal)

    const ans = await req('POST', '/confirm', { id: confirmEvent.id, answer: { outcome: 'allowed-once' } }, auth)
    check('POST /confirm 接受作答', ans.json.ok === true, ans.json)
    const outcome = await raced
    check('鸿蒙端先答 -> 结局 = allowed-once', outcome === 'allowed-once', outcome)
    check('手机先答 -> 下游（网页端弹框）收到 abort，框会被关掉', desktopSettled === true, desktopSettled)
    // 安全属性：abort 的必须是替身。原本那条一旦被 abort，dsh-user-approval
    // 自己 race 出来的结局会变成 'cancelled' —— 用户点的「允许」就白点了。
    check('调用方原本的信号没有被 abort', callerA.signal.aborted === false, callerA.signal.aborted)
  }

  {
    // 场景 1b：鸿蒙端不答 -> 绝不能去 abort 下游，否则会把电脑上的框无辜关掉
    let desktopSettled = false
    const native = (req) => new Promise((r) => {
      if (req.signal !== undefined) {
        req.signal.addEventListener('abort', () => { desktopSettled = true; r('cancelled') }, { once: true })
      }
      setTimeout(() => r('rejected'), 300)
    })
    const reqB = { toolName: 'pwsh', agent: { id: 'session-a' } }
    const outcome = await approvalListener(reqB, () => native(reqB))
    check('鸿蒙端静默不答时下游不被 abort', outcome === 'rejected' && desktopSettled === false,
      `${outcome}/${desktopSettled}`)
  }

  {
    // 场景 2：鸿蒙端不答 -> 原生框接管（DSH 绝不因手机静默而卡死）
    const native = () => new Promise((r) => setTimeout(() => r('rejected'), 300))
    const outcome = await approvalListener({ toolName: 'pwsh', agent: { id: 'session-a' } }, native)
    check('鸿蒙端不答 -> 原生框的 rejected 生效（fail-closed）', outcome === 'rejected', outcome)
  }

  {
    // 场景 3：双端同时作答 -> 后到的返回 409
    const native = () => new Promise((r) => setTimeout(() => r('rejected'), 2000))
    const raced = approvalListener({ toolName: 'pwsh', agent: { id: 'session-a' } }, native)
    const ev = await req('GET', '/events?since=0', undefined, auth)
    const id = ev.json.events.filter((e) => e.type === 'confirm_request').pop().id
    await req('POST', '/confirm', { id, answer: { outcome: 'allowed-once' } }, auth)
    const again = await req('POST', '/confirm', { id, answer: { outcome: 'rejected' } }, auth)
    check('重复作答 -> 409 already-resolved',
      again.status === 409 && again.json.error?.code === 'already-resolved', again.json)
    await raced
  }

  {
    // 场景 4：非法 outcome 一律丢弃，绝不能让鸿蒙端放宽沙箱
    const native = () => new Promise((r) => setTimeout(() => r('rejected'), 400))
    const raced = approvalListener({ toolName: 'pwsh', agent: { id: 'session-a' } }, native)
    const ev = await req('GET', '/events?since=0', undefined, auth)
    const id = ev.json.events.filter((e) => e.type === 'confirm_request').pop().id
    await req('POST', '/confirm', { id, answer: { outcome: 'allowed-forever' } }, auth)
    const outcome = await raced
    check('非法 outcome 被丢弃 -> 仍走原生框的 rejected', outcome === 'rejected', outcome)
  }

  {
    const noAuth = await fetch(`${BASE}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'x', answer: {} }),
    })
    check('POST /confirm 无 token -> 401', noAuth.status === 401, noAuth.status)
  }

  console.log('\n-- confirm-approval：ask_user_question 桥 --')
  check('userQuestions.ask 已被包装', typeof userQuestionsStub.ask === 'function', typeof userQuestionsStub.ask)
  {
    questionProviderAsk = () => new Promise((r) => setTimeout(() => r([{ questionId: 'q1', selected: ['native'] }]), 800))
    const raced = userQuestionsStub.ask({
      questions: [{ id: 'q1', header: '选择', question: '选哪个方案？', options: [{ label: 'A' }, { label: 'B' }] }],
      agent: { id: 'session-a' },
    })
    const ev = await req('GET', '/events?since=0', undefined, auth)
    const confirmEvent = ev.json.events.filter((e) => e.type === 'confirm_request' && e.kind === 'question').pop()
    check('问答请求推到了鸿蒙端', confirmEvent !== undefined, ev.json.events.map((e) => e.kind))
    check('问答请求带上了 questions 与 options',
      confirmEvent?.payload?.questions?.[0]?.question === '选哪个方案？'
        && confirmEvent?.payload?.questions?.[0]?.options?.length === 2,
      confirmEvent?.payload?.questions)

    await req('POST', '/confirm',
      { id: confirmEvent.id, answer: { answers: [{ questionId: 'q1', selected: ['B'] }] } }, auth)
    const answers = await raced
    // 回归：ask() 必须 resolve 成 { answers: [...] } —— dsh-tool-ask-user 里是
    // `(await ctx.userQuestions.ask(...)).answers.map(...)`，裸数组会让它
    // 「Cannot read properties of undefined (reading 'map')」。这里断言外层壳。
    check('远端作答 resolve 成 { answers: [...] } 而不是裸数组',
      Array.isArray(answers) === false && Array.isArray(answers?.answers),
      answers)
    check('鸿蒙端的选择生效', answers?.answers?.[0]?.selected?.[0] === 'B', answers)
    // 旧版鸿蒙端把题目 id 写在 questionId 上，服务端要替它改名成 id
    check('questionId 被规范成 id（兼容旧版 App）', answers?.answers?.[0]?.id === 'q1', answers)
  }
  {
    // 新式写法（id）也要能过，且 selected 与 custom 都要保留
    questionProviderAsk = () => new Promise(() => {})
    const raced = userQuestionsStub.ask({
      questions: [{ id: 'q7', question: '还继续吗？', options: [{ label: '继续' }] }],
      agent: { id: 'session-a' },
    })
    const ev = await req('GET', '/events?since=0', undefined, auth)
    const confirmEvent = ev.json.events.filter((e) => e.type === 'confirm_request' && e.kind === 'question').pop()
    await req('POST', '/confirm',
      { id: confirmEvent.id, answer: { answers: [{ id: 'q7', selected: [], custom: '  就这样  ' }] } }, auth)
    const answers = await raced
    check('id 写法可用', answers?.answers?.[0]?.id === 'q7', answers)
    check('custom 原样保留（不丢空格外的内容）', answers?.answers?.[0]?.custom === '  就这样  ', answers)
  }
  {
    // 完全答非所问（没有 id 也没有 questionId）时，不能 resolve 成空壳骗过工具，
    // 必须回落给原生框：race 只等 native。
    questionProviderAsk = () => new Promise((r) => setTimeout(() => r({ answers: [] }), 600))
    const raced = userQuestionsStub.ask({
      questions: [{ id: 'q9', question: '??', options: [{ label: 'A' }] }],
      agent: { id: 'session-a' },
    })
    const ev = await req('GET', '/events?since=0', undefined, auth)
    const confirmEvent = ev.json.events.filter((e) => e.type === 'confirm_request' && e.kind === 'question').pop()
    await req('POST', '/confirm', { id: confirmEvent.id, answer: { answers: [{ selected: ['A'] }] } }, auth)
    const answers = await raced
    check('缺 id 的作答被丢弃、回落原生框', answers?.answers?.length === 0, answers)
  }

  {
    console.log('\n-- 冷启动不重放僵尸确认（截图上那个 404 unknown-confirm）--')
    questionProviderAsk = () => new Promise((r) => setTimeout(() => r({ answers: [{ id: 'qa', selected: ['A'] }] }), 3000))
    const raced = userQuestionsStub.ask({
      questions: [{ id: 'qa', question: '重放测试', options: [{ label: 'A' }] }],
      agent: { id: 'session-a' },
    })
    const ev = await req('GET', '/events?since=0', undefined, auth)
    const id = ev.json.events.filter((e) => e.type === 'confirm_request' && e.kind === 'question').pop().id
    await req('POST', '/confirm', { id, answer: { answers: [{ id: 'qa', selected: ['A'] }] } }, auth)
    await raced

    // 关键断言：已作答的 confirm_request 不能再出现在 /events 里。
    // 旧行为是 `since=0` 把整个历史队列原样吐回去，App 冷启动就会把这些
    // 早就作废的请求重新弹一遍，用户点了必然 404。
    const replay = await req('GET', '/events?since=0', undefined, auth)
    const events = replay.json.events ?? []
    check('已作答的 confirm_request 不再被重放',
      events.filter((e) => e.type === 'confirm_request').length === 0, events)
    check('作答回执 confirm_resolved 仍然保留（多端对账要用）',
      events.some((e) => e.type === 'confirm_resolved' && e.id === id), events)

    const bogus = await req('POST', '/confirm', { id: 'cf-不存在', answer: {} }, auth)
    check('未知 id -> 404 unknown-confirm',
      bogus.status === 404 && bogus.json.error?.code === 'unknown-confirm', bogus.json)
  }
  {
    console.log('\n-- 电脑端先答 -> 撤下鸿蒙端那条 --')
    questionProviderAsk = () => new Promise((r) => setTimeout(() => r({ answers: [] }), 500))
    const raced = userQuestionsStub.ask({
      questions: [{ id: 'qb', question: '撤回测试', options: [{ label: 'A' }] }],
      agent: { id: 'session-a' },
    })
    const ev = await req('GET', '/events?since=0', undefined, auth)
    const id = ev.json.events.filter((e) => e.type === 'confirm_request' && e.kind === 'question').pop()?.id
    check('撤回前请求是可见的', typeof id === 'string' && id.startsWith('cf-'), id)
    await raced

    const late = await req('POST', '/confirm', { id, answer: { answers: [{ id: 'qb', selected: ['A'] }] } }, auth)
    check('电脑端先答后，迟到的鸿蒙端作答 -> 409（而不是「假成功」）',
      late.status === 409 && late.json.error?.code === 'already-resolved', late.json)
    const replay = await req('GET', '/events?since=0', undefined, auth)
    check('被撤下的请求也不再重放',
      (replay.json.events ?? []).every((e) => e.type !== 'confirm_request'), replay.json.events)
  }

  {
    // 手机先答 -> 原生 provider 收到的那条信号必须被 abort，
    // 否则电脑网页上那个问框会一直挂着（就是用户报的那个现象）。
    let seenSignal = null
    // 忠实模拟 apiproxy 的问答 provider：它挂在传进来的 signal 上，
    // abort 就 claimQuestion + reject(ASK_ABORTED)。
    questionProviderAsk = (request) => new Promise((resolve, reject) => {
      seenSignal = request.signal
      if (request.signal !== undefined) {
        request.signal.addEventListener('abort', () => reject(new Error('ASK_ABORTED')), { once: true })
      }
    })
    const callerQ = new AbortController()
    const raced = userQuestionsStub.ask({
      questions: [{ id: 'qg', question: '关框测试', options: [{ label: 'A' }] }],
      agent: { id: 'session-a' },
      signal: callerQ.signal,
    })
    const ev = await req('GET', '/events?since=0', undefined, auth)
    const confirmEvent = ev.json.events.filter((e) => e.type === 'confirm_request' && e.kind === 'question').pop()
    check('原生 provider 拿到的是替身信号（不是调用方那条）',
      seenSignal !== null && seenSignal !== callerQ.signal, typeof seenSignal)
    check('作答之前的替身信号还没被 abort', seenSignal?.aborted === false, seenSignal?.aborted)

    await req('POST', '/confirm',
      { id: confirmEvent.id, answer: { answers: [{ id: 'qg', selected: ['A'] }] } }, auth)
    const answers = await raced
    check('手机先答 -> 原生那条替身信号被 abort（网页端收到 question/resolved 自己关框）',
      seenSignal?.aborted === true, seenSignal?.aborted)
    check('调用方原本的信号没有被 abort', callerQ.signal.aborted === false, callerQ.signal.aborted)
    check('同时作答结果照常生效', answers?.answers?.[0]?.selected?.[0] === 'A', answers)
  }
  {
    // 手机静默不答 -> 绝不能 abort 原生那条，否则电脑上的框会被无辜关掉
    let seenSignal = null
    questionProviderAsk = (request) => {
      seenSignal = request.signal
      return new Promise((r) => setTimeout(() => r({ answers: [] }), 300))
    }
    const raced = userQuestionsStub.ask({
      questions: [{ id: 'qh', question: '静默测试', options: [{ label: 'A' }] }],
      agent: { id: 'session-a' },
      signal: new AbortController().signal,
    })
    await raced
    check('手机静默不答 -> 原生那条信号不被 abort', seenSignal?.aborted === false, seenSignal?.aborted)
  }

  console.log('\n-- tool registration --')
  check('registered the harmony_remote_info tool', registeredTools.some((t) => t.name === 'harmony_remote_info'), registeredTools.map((t) => t.name))
  const tool = registeredTools[0]
  check('tool output schema forbids extra properties', tool?.output?.schema?.additionalProperties === false, tool?.output?.schema?.additionalProperties)

  if (typeof disposeEffect === 'function') disposeEffect()
  await new Promise((r) => setTimeout(r, 200))

  console.log(`\n=== ${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} ===\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('self-test crashed:', error)
  process.exit(1)
})
