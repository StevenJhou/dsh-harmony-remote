/**
 * dsh-harmony-remote — a local REST bridge that lets a HarmonyOS app
 * remote-control this DeepSeek Harness process.
 *
 * Design notes (all API usage below was verified against the installed
 * packages under $DSH_HOME/profiles/node_modules, not guessed):
 *
 *  - The bridge does NOT reimplement dsh logic. It calls the very same
 *    `ctx.apiProxy` service the browser UI calls, so the remote control has
 *    web-UI semantics by construction:
 *        ctx.apiProxy.sessions.list|create|history|models|selectModel|prompt|cancel
 *    Every apiProxy method takes `{ rpcId, payload }` and answers
 *    `{ rpcId, result: { ok: true, value } | { ok: false, error } }`.
 *    `rpcId` is only echoed back, so a plain unique string is sufficient and
 *    this plugin needs no import from the apiproxy package.
 *
 *  - Services are resolved lazily with `ctx.get(...)` inside each request
 *    rather than through a hard `inject`, so a missing service degrades into a
 *    clear JSON error instead of parking the whole plugin in "waiting".
 *
 *  - The listener is a plain `node:http` server so it stays independent of the
 *    dsh web server (which already owns 3080) and cannot disturb it.
 *
 * @module dsh-harmony-remote
 */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name. */
export const name = 'harmony-remote'

/**
 * Only `tools` is a hard dependency (the plugin registers a model-facing tool).
 * `apiProxy` and `agents` are read with `ctx.get` per request so the HTTP
 * listener still starts — and can report a useful error — when one is absent.
 */
export const inject = ['tools']

/** Plugin configuration, validated by the Cordis loader from the row's `config:`. */
export const Config = z.object({
  host: z.string(),
  port: z.number(),
  token: z.string(),
  exposeTool: z.boolean(),
})

const DEFAULTS = {
  host: '127.0.0.1',
  port: 3100,
  token: '',
  exposeTool: true,
}

/** Largest accepted JSON request body, in bytes (every endpoint except /send). */
const MAX_BODY_BYTES = 1_000_000

/**
 * `/send` gets its own, much larger bound: it legitimately carries base64 images
 * (the same wire form the web UI posts), and base64 inflates by ~33%.
 * 32 MB of JSON ≈ a 24 MB source image — far beyond what dsh's own
 * `maxImageBytes` / `maxMessageImageBytes` limits will accept anyway, so those
 * provide the real, meaningful ceiling.
 */
const MAX_SEND_BYTES = 32 * 1024 * 1024

/** Upload cap: 32 MB — a phone photo is easily several MB. */
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024

/** Every upload is written under this subdirectory of the session workspace. */
const UPLOAD_DIR = 'dsh-uploads'

/**
 * Image media types dsh's attachment store accepts.
 * Source: `EncodedImageAttachment.mediaType` in @deepseek-ai/dsh-attachment.
 */
const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** Default page size for GET /messages. */
const DEFAULT_MESSAGE_LIMIT = 50

/** Guess an image media type from a filename; '' when it is not a supported image. */
function imageMediaTypeOf(filename) {
  const lower = String(filename ?? '').toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  return ''
}

/** Strip any path component and unsafe characters from a client-supplied name. */
function safeFilename(rawName) {
  const base = String(rawName ?? 'upload.bin').split(/[\\/]/).pop() ?? 'upload.bin'
  const cleaned = base.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_')
  return cleaned.length === 0 ? 'upload.bin' : cleaned.slice(0, 120)
}

/**
 * Read a request body as raw bytes.
 * Uploads are binary, so this cannot go through the JSON text reader.
 * @param {import('node:http').IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let overflowed = false
    req.on('data', (chunk) => {
      if (overflowed) return
      size += chunk.length
      if (size > maxBytes) {
        // 这里**绝不能** req.destroy()：销毁 socket 会让客户端收不到任何响应，
        // 鸿蒙那边只能报 2300056「Failed to receive data from the peer / 连接被重置」，
        // 完全看不出真实原因。正确做法是把剩余 body 读完丢掉，再干净地回一个 413。
        overflowed = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => {
      if (overflowed) {
        reject(Object.assign(new Error(`body exceeds ${maxBytes} bytes`), { statusCode: 413 }))
        return
      }
      resolve(Buffer.concat(chunks))
    })
  })
}

/**
 * Minimal `multipart/form-data` parser — just enough for one file field.
 *
 * Works directly on Buffers so binary content survives; converting the body to
 * a string first would corrupt any non-UTF-8 byte. Splitting on the boundary
 * Buffer is exact, unlike regex scanning over a decoded string.
 *
 * @param {Buffer} body - the complete request body.
 * @param {string} boundary - the boundary token from the Content-Type header.
 * @returns {Array<{name: string, filename: string, contentType: string, data: Buffer}>}
 */
function parseMultipart(body, boundary) {
  const parts = []
  const delimiter = Buffer.from(`--${boundary}`)
  const headerSeparator = Buffer.from('\r\n\r\n')
  let cursor = body.indexOf(delimiter)
  if (cursor < 0) return parts
  cursor += delimiter.length

  while (cursor < body.length) {
    // A closing `--` right after the boundary ends the body.
    if (body[cursor] === 0x2d && body[cursor + 1] === 0x2d) break
    if (body[cursor] === 0x0d && body[cursor + 1] === 0x0a) cursor += 2

    const headerEnd = body.indexOf(headerSeparator, cursor)
    if (headerEnd < 0) break
    const headerText = body.subarray(cursor, headerEnd).toString('utf8')
    const dataStart = headerEnd + headerSeparator.length

    let nextBoundary = body.indexOf(delimiter, dataStart)
    if (nextBoundary < 0) nextBoundary = body.length
    // The CRLF immediately before the next boundary belongs to the delimiter.
    let dataEnd = nextBoundary
    if (dataEnd >= 2 && body[dataEnd - 2] === 0x0d && body[dataEnd - 1] === 0x0a) dataEnd -= 2

    const part = { name: '', filename: '', contentType: '', data: body.subarray(dataStart, dataEnd) }
    for (const line of headerText.split('\r\n')) {
      const disposition = /^content-disposition:\s*form-data;\s*(.*)$/i.exec(line)
      if (disposition !== null) {
        const nameMatch = /name="([^"]*)"/i.exec(disposition[1])
        if (nameMatch !== null) part.name = nameMatch[1]
        const fileMatch = /filename="([^"]*)"/i.exec(disposition[1])
        if (fileMatch !== null) part.filename = fileMatch[1]
        continue
      }
      const typeMatch = /^content-type:\s*(.+)$/i.exec(line)
      if (typeMatch !== null) part.contentType = typeMatch[1].trim()
    }
    parts.push(part)
    // 关键：游标要跳到分隔符**之后**。若停在分隔符上，下一轮循环会把分隔符
    // 开头的 "--" 误判成结束标记，于是只解析出第一个 part。
    cursor = nextBoundary + delimiter.length
  }
  return parts
}

/** Pull the visible text out of a dsh content-block array. */
function textOfBlocks(blocks) {
  if (!Array.isArray(blocks)) return ''
  let out = ''
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string') out += block.text
  }
  return out
}

/**
 * Convert one session event into a flat transcript row, tolerating both the
 * raw `{ type, data }` envelope and a projected `{ event: { type, data } }`.
 * Unknown event types return null and are skipped.
 */
function transcriptRowOf(event) {
  const type = event?.type ?? event?.event?.type
  const data = event?.data ?? event?.event?.data
  const seq = event?.seq ?? event?.event?.seq
  if (type === 'user/message' && data) {
    return {
      seq: seq ?? null,
      role: 'user',
      text: textOfBlocks(data.content),
      source: data.source?.kind ?? null,
    }
  }
  if (type === 'assistant/message' && data?.message) {
    return {
      seq: seq ?? null,
      role: 'assistant',
      text: textOfBlocks(data.message.content),
      turn: data.turn ?? null,
      step: data.step ?? null,
      interrupted: data.interrupted === true,
    }
  }
  return null
}

/** Turn an apiProxy reply into a plain `{ ok, value }` / `{ ok, error }`. */
function unwrap(reply) {
  const result = reply?.result
  if (result && result.ok === true) return { ok: true, value: result.value }
  if (result && result.ok === false) {
    return {
      ok: false,
      error: result.error ?? { code: 'unknown', message: 'apiProxy returned an error', details: {} },
    }
  }
  return { ok: false, error: { code: 'bad-reply', message: 'apiProxy returned an unrecognised reply', details: {} } }
}

/**
 * Read and JSON-parse a request body, bounded by `maxBytes`.
 *
 * The bound is a parameter because `/send` legitimately carries base64 images
 * and is therefore far larger than every other endpoint.
 */
function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let overflowed = false
    req.on('data', (chunk) => {
      if (overflowed) return
      size += chunk.length
      if (size > maxBytes) {
        // 绝不能 req.destroy()：销毁 socket 会让客户端收不到任何响应，
        // 鸿蒙只能报 2300056「连接被重置」，真实原因完全丢失。
        // 正确做法：把剩余 body 读完丢掉，再干净地回 413。
        overflowed = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => {
      if (overflowed) {
        reject(Object.assign(new Error(`request body exceeds ${maxBytes} bytes`), { statusCode: 413 }))
        return
      }
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') return resolve({})
      try {
        const parsed = JSON.parse(text)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(Object.assign(new Error('body must be a JSON object'), { statusCode: 400 }))
          return
        }
        resolve(parsed)
      } catch (error) {
        reject(Object.assign(new Error(`invalid JSON body: ${String(error)}`), { statusCode: 400 }))
      }
    })
  })
}

/** Small helper for the repeated `{ ok: false, error }` payloads. */
function failure(code, message, details) {
  return { code, message, ...(details === undefined ? {} : { details }) }
}

/**
 * Install the REST bridge and (optionally) the model-facing control tool.
 * @param ctx - registrant context.
 * @param config - validated plugin configuration.
 */
export function apply(ctx, config) {
  const options = { ...DEFAULTS, ...(config ?? {}) }
  const startedAt = Date.now()

  /** Resolve the service the browser UI itself uses; null when unavailable. */
  function apiProxy() {
    return ctx.get('apiProxy') ?? null
  }

  /**
   * Call one apiProxy session method with the standard envelope.
   * @returns `{ ok, value }` or `{ ok, error }`.
   */
  async function callSession(method, payload) {
    const api = apiProxy()
    if (api === null || typeof api.sessions?.[method] !== 'function') {
      return {
        ok: false,
        error: failure(
          'service-unavailable',
          `session.${method} is unavailable: this deployment mounts no api-proxy service`,
        ),
      }
    }
    try {
      return unwrap(await api.sessions[method]({ rpcId: `harmony-${randomUUID()}`, payload }))
    } catch (error) {
      return { ok: false, error: failure('internal', String(error?.message ?? error)) }
    }
  }

  /** Live agents, tolerating a missing `agents` service. */
  function liveAgents() {
    const agents = ctx.get('agents')
    if (agents === undefined) return []
    try {
      return agents.list() ?? []
    } catch {
      return []
    }
  }

  /**
   * Pick the session a request applies to.
   *
   * Auto-targeting is deliberately conservative: a remote `send` that guessed
   * the wrong conversation would be worse than an error. So a session is
   * inferred only when the choice cannot be ambiguous — this deployment's own
   * attached session, or exactly one attached agent. With several sessions open
   * the caller must name one (`?sessionId=` / `sessionId`), and `GET /status`
   * lists every candidate in `liveAgents`.
   */
  function resolveSessionId(requested) {
    if (typeof requested === 'string' && requested.length > 0) return requested
    const agents = liveAgents()
    const fromEnv = typeof process.env.DSH_SESSION_ID === 'string' ? process.env.DSH_SESSION_ID : ''
    if (fromEnv !== '' && agents.some((agent) => String(agent.id) === fromEnv)) return fromEnv
    if (agents.length === 1) return String(agents[0].id)
    // No attached agent: fall back to the deployment-declared session so
    // read-only routes (history/models) can still reach stored sessions.
    if (agents.length === 0 && fromEnv !== '') return fromEnv
    return null
  }

  /** `GET /status` — model, session, and run state. */
  async function handleStatus(query) {
    const sessionId = resolveSessionId(query.sessionId)
    const agents = liveAgents()
    const agent = sessionId === null ? undefined : agents.find((a) => String(a.id) === sessionId)

    let model = null
    if (sessionId !== null) {
      const models = await callSession('models', { sessionId })
      if (models.ok) {
        model = { current: models.value.current ?? null, routable: models.value.routable ?? null }
      }
    }

    return {
      ok: true,
      now: new Date().toISOString(),
      uptimeMs: Date.now() - startedAt,
      bridge: { name, port: options.port, host: options.host, authRequired: options.token !== '' },
      sessionId,
      running: agent === undefined ? null : agent.status === 'running',
      agentStatus: agent === undefined ? null : agent.status,
      // 运行态判据补充：前端靠这几个字段确认"任务是不是真的停了"，
      // 而不是只看一次请求的返回。idle 为 true 就可以把「停止」键恢复成「发送」。
      idle: agent === undefined ? null : agent.status !== 'running',
      // 取消默认 keepInbox，所以排队里的消息不会被丢掉 —— 这个数字就是还剩几条。
      hasPending: agent === undefined ? null : (agent.inbox?.hasPending === true),
      queuedTurns: agent === undefined ? null : (agent.inbox?.nextTurn?.length ?? 0),
      model,
      agentOptions: agent === undefined ? null : { provider: agent.options?.provider ?? null, model: agent.options?.model ?? null },
      liveAgents: agents.map((a) => ({ sessionId: String(a.id), status: a.status, running: a.status === 'running' })),
    }
  }

  /** `GET /models` — the provider/model catalog the web UI's picker shows. */
  async function handleModels(query) {
    const sessionId = resolveSessionId(query.sessionId)
    if (sessionId === null) {
      return { httpStatus: 409, body: { ok: false, error: failure('no-session', 'no session is available; pass ?sessionId=') } }
    }
    const reply = await callSession('models', { sessionId })
    if (!reply.ok) return { httpStatus: 502, body: { ok: false, sessionId, error: reply.error } }
    return {
      ok: true,
      sessionId,
      current: reply.value.current ?? null,
      routable: reply.value.routable ?? null,
      groups: reply.value.groups ?? [],
      failures: reply.value.failures ?? [],
    }
  }

  /** `POST /model` — switch the session's model exactly like the web UI does. */
  async function handleSelectModel(body) {
    const sessionId = resolveSessionId(body.sessionId)
    if (sessionId === null) {
      return { httpStatus: 409, body: { ok: false, error: failure('no-session', 'no session is available; pass sessionId') } }
    }
    const provider = typeof body.provider === 'string' ? body.provider : undefined
    const model = typeof body.model === 'string' ? body.model : undefined
    if (provider === undefined || model === undefined) {
      return {
        httpStatus: 400,
        body: { ok: false, error: failure('bad-request', 'both `provider` and `model` are required', { provider, model }) },
      }
    }
    const payload = { sessionId, provider, model }
    if (typeof body.reasoningEffort === 'string' && body.reasoningEffort.length > 0) {
      payload.reasoningEffort = body.reasoningEffort
    }
    const reply = await callSession('selectModel', payload)
    if (!reply.ok) return { httpStatus: 502, body: { ok: false, sessionId, error: reply.error } }
    return { ok: true, sessionId, selected: reply.value.selected ?? null }
  }

  /** `POST /send` — queue a prompt (or steering message) for the session. */
  /**
   * Resolve the workspace directory a session's agent reads from.
   * `SessionHeader.cwd` is the very directory the agent's own file tools see,
   * so writing there is what makes an upload readable by the agent.
   */
  function sessionCwd(sessionId) {
    const agents = ctx.get('agents')
    if (agents === undefined) return null
    try {
      const agent = agents.get(sessionId)
      const cwd = agent?.session?.header?.cwd
      return typeof cwd === 'string' && cwd.length > 0 ? cwd : null
    } catch {
      return null
    }
  }

  async function handleSend(body) {
    const sessionId = resolveSessionId(body.sessionId)
    if (sessionId === null) {
      return { httpStatus: 409, body: { ok: false, error: failure('no-session', 'no session is available; pass sessionId') } }
    }
    const text = typeof body.text === 'string' ? body.text : typeof body.content === 'string' ? body.content : ''
    const fileRefs = Array.isArray(body.fileRefs)
      ? body.fileRefs.filter((ref) => typeof ref === 'string' && ref.length > 0)
      : []
    const images = Array.isArray(body.images) ? body.images : []
    if (text.trim() === '' && fileRefs.length === 0 && images.length === 0) {
      return {
        httpStatus: 400,
        body: { ok: false, error: failure('bad-request', '`text` must be non-empty unless files or images are attached') },
      }
    }

    // Build the exact content shape the web UI sends. apiProxy's
    // durablePromptContent() runs admitEncodedImages() over the image parts, so
    // they become durable attachments the model genuinely sees — this is the
    // same wire form the browser uses, not a private protocol.
    let promptText = text
    if (fileRefs.length > 0) {
      promptText += (promptText.trim() === '' ? '' : '\n\n')
        + '[已上传到工作区的文件，可直接读取]\n'
        + fileRefs.map((ref) => `- ${ref}`).join('\n')
    }
    const content = []
    if (promptText !== '') content.push({ type: 'text', text: promptText })
    for (const image of images) {
      if (image === null || typeof image !== 'object') continue
      if (typeof image.mediaType !== 'string' || typeof image.data !== 'string') continue
      content.push({
        type: 'image',
        mediaType: image.mediaType,
        data: image.data,
        ...(typeof image.name === 'string' && image.name.length > 0 ? { name: image.name } : {}),
      })
    }

    // `mode: 'steer'` interrupts the current step; anything else queues a turn.
    const mode = body.mode === 'steer' ? 'steer' : 'followup'
    const reply = await callSession('prompt', { sessionId, mode, content })
    if (!reply.ok) return { httpStatus: 502, body: { ok: false, sessionId, error: reply.error } }
    return {
      ok: true,
      sessionId,
      mode,
      accepted: reply.value.accepted === true,
      fileRefs,
      imageCount: content.filter((part) => part.type === 'image').length,
    }
  }

  /**
   * `POST /upload` — put a file where the session's agent can read it.
   *
   * Two content types are accepted:
   *   · multipart/form-data — field `file`, plus optional field `sessionId`
   *   · application/json    — `{ name, dataBase64, mediaType?, sessionId? }`
   *
   * Bytes land in `<session cwd>/dsh-uploads/<stamp>-<name>`, the directory the
   * agent's own file tools read. For images the reply ALSO carries the base64
   * form `{ mediaType, data, name }` — the `EncodedImageAttachment` shape the web
   * UI's prompt path uses — so the client can post it straight back through
   * `/send` and the model actually sees the picture.
   */
  async function handleUpload(req, query) {
    const contentType = String(req.headers['content-type'] ?? '')
    let filename = ''
    let declaredType = ''
    let bytes = null
    let sessionIdHint = query.sessionId

    const raw = await readRawBody(req, MAX_UPLOAD_BYTES)
    if (raw.length === 0) {
      return { httpStatus: 400, body: { ok: false, error: failure('empty-body', 'the upload body was empty') } }
    }

    const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
    if (contentType.toLowerCase().startsWith('multipart/form-data') && boundaryMatch !== null) {
      const boundary = String(boundaryMatch[1] ?? boundaryMatch[2] ?? '').trim()
      const parts = parseMultipart(raw, boundary)
      for (const part of parts) {
        if (part.filename !== '' || part.name === 'file') {
          filename = part.filename !== '' ? part.filename : part.name
          declaredType = part.contentType
          bytes = part.data
        } else if (part.name === 'sessionId') {
          sessionIdHint = part.data.toString('utf8').trim()
        }
      }
      if (bytes === null) {
        return { httpStatus: 400, body: { ok: false, error: failure('no-file', 'no `file` part found in the multipart body') } }
      }
    } else if (contentType.toLowerCase().startsWith('application/json')) {
      let parsed
      try {
        parsed = JSON.parse(raw.toString('utf8'))
      } catch (error) {
        return { httpStatus: 400, body: { ok: false, error: failure('bad-json', String(error)) } }
      }
      if (parsed === null || typeof parsed !== 'object') {
        return { httpStatus: 400, body: { ok: false, error: failure('bad-request', 'body must be a JSON object') } }
      }
      filename = typeof parsed.name === 'string' ? parsed.name : 'upload.bin'
      declaredType = typeof parsed.mediaType === 'string' ? parsed.mediaType : ''
      if (typeof parsed.dataBase64 !== 'string' || parsed.dataBase64.length === 0) {
        return { httpStatus: 400, body: { ok: false, error: failure('no-file', '`dataBase64` must be a non-empty base64 string') } }
      }
      if (typeof parsed.sessionId === 'string' && parsed.sessionId.length > 0) {
        sessionIdHint = parsed.sessionId
      }
      bytes = Buffer.from(parsed.dataBase64, 'base64')
    } else {
      return {
        httpStatus: 415,
        body: {
          ok: false,
          error: failure('unsupported-type', 'send multipart/form-data, or application/json with { name, dataBase64 }'),
        },
      }
    }

    const sessionId = resolveSessionId(sessionIdHint)
    if (sessionId === null) {
      return { httpStatus: 409, body: { ok: false, error: failure('no-session', 'no session is available; pass sessionId') } }
    }
    const cwd = sessionCwd(sessionId)
    if (cwd === null) {
      return {
        httpStatus: 409,
        body: {
          ok: false,
          sessionId,
          error: failure('no-workspace', `session "${sessionId}" has no workspace directory attached`),
        },
      }
    }

    const safeName = safeFilename(filename)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const storedName = `${stamp}-${safeName}`
    let target
    try {
      const dir = join(cwd, UPLOAD_DIR)
      mkdirSync(dir, { recursive: true })
      target = join(dir, storedName)
      writeFileSync(target, bytes)
    } catch (error) {
      return {
        httpStatus: 500,
        body: {
          ok: false,
          sessionId,
          error: failure('write-failed', `could not write into the session workspace: ${String(error)}`),
        },
      }
    }

    const mediaType = IMAGE_MEDIA_TYPES.includes(declaredType) ? declaredType : imageMediaTypeOf(safeName)
    const relPath = `${UPLOAD_DIR}/${storedName}`
    console.error(`[harmony-remote] upload ${relPath} (${bytes.length} B) -> ${target}`)
    return {
      ok: true,
      sessionId,
      kind: mediaType === '' ? 'file' : 'image',
      file: { name: safeName, storedName, bytes: bytes.length, path: target, relPath, mediaType },
      image: mediaType === '' ? null : { mediaType, data: bytes.toString('base64'), name: safeName },
    }
  }

  /** `GET /messages` — the same transcript rows the web UI renders. */
  async function handleMessages(query) {
    const sessionId = resolveSessionId(query.sessionId)
    if (sessionId === null) {
      return { httpStatus: 409, body: { ok: false, error: failure('no-session', 'no session is available; pass ?sessionId=') } }
    }
    const rawLimit = Number.parseInt(String(query.limit ?? ''), 10)
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : DEFAULT_MESSAGE_LIMIT

    // beforeSeq: 往前翻页 —— 只要 seq 严格小于它的更早消息。不传就是最新一页。
    // App 端首屏只拉最新的一小页，用户往上滑时再带 oldestSeq 来取更早的。
    const payload = { sessionId, maxMessages: limit }
    const rawBefore = Number.parseInt(String(query.beforeSeq ?? ''), 10)
    if (Number.isFinite(rawBefore) && rawBefore >= 0) {
      payload.beforeSeq = rawBefore
    }

    const reply = await callSession('history', payload)
    if (!reply.ok) return { httpStatus: 502, body: { ok: false, sessionId, error: reply.error } }

    const events = Array.isArray(reply.value.events) ? reply.value.events : []
    const messages = []
    for (const event of events) {
      const row = transcriptRowOf(event)
      if (row !== null) messages.push(row)
    }
    return {
      ok: true,
      sessionId,
      count: messages.length,
      hasMore: reply.value.hasMore === true,
      messages,
    }
  }

  /** `GET /sessions` — visible sessions, newest first as the roster returns them. */
  async function handleSessions() {
    const reply = await callSession('list', {})
    if (!reply.ok) return { httpStatus: 502, body: { ok: false, error: reply.error } }
    const items = Array.isArray(reply.value.items) ? reply.value.items : []
    return { ok: true, count: items.length, sessions: items }
  }

  /** `POST /sessions` — create (and attach) a new session. */
  async function handleCreateSession(body) {
    const payload = {}
    for (const key of ['sessionId', 'cwd', 'workspaceId', 'agentPreset']) {
      if (typeof body[key] === 'string' && body[key].length > 0) payload[key] = body[key]
    }
    const reply = await callSession('create', payload)
    if (!reply.ok) return { httpStatus: 502, body: { ok: false, error: reply.error } }
    return { ok: true, sessionId: reply.value.sessionId ?? null, agentPreset: reply.value.agentPreset ?? null }
  }

  /** `POST /cancel` — stop the running turn, keeping queued work. */
  async function handleCancel(body) {
    const sessionId = resolveSessionId(body.sessionId)
    if (sessionId === null) {
      return { httpStatus: 409, body: { ok: false, error: failure('no-session', 'no session is available; pass sessionId') } }
    }
    const reply = await callSession('cancel', { sessionId })
    if (!reply.ok) return { httpStatus: 502, body: { ok: false, sessionId, error: reply.error } }
    return { ok: true, sessionId, cancelled: reply.value.accepted === true }
  }

  /** Route one request. Returns `{ httpStatus?, body }`. */
  async function route(req, url) {
    const path = url.pathname.replace(/\/+$/, '') || '/'
    const query = Object.fromEntries(url.searchParams.entries())
    const method = req.method ?? 'GET'

    if (method === 'OPTIONS') return { httpStatus: 204, body: null }
    if (path === '/' || path === '/health') {
      return { ok: true, name, version: '0.1.0', uptimeMs: Date.now() - startedAt }
    }
    if (method === 'GET' && path === '/status') return handleStatus(query)
    if (method === 'GET' && path === '/models') return handleModels(query)
    if (method === 'GET' && path === '/messages') return handleMessages(query)
    if (method === 'GET' && path === '/sessions') return handleSessions()
    if (method === 'GET' && path === '/tools') {
      // The `tools` service exposes register/restrict/guard/presentAs but no
      // enumeration, so the full catalog cannot be listed from here. Report
      // this plugin's own contribution and say so, rather than a bare zero.
      const names = options.exposeTool === false ? [] : ['harmony_remote_info']
      return {
        ok: true,
        count: names.length,
        tools: names,
        note: 'dsh exposes no tool-enumeration API; this lists only the tools this plugin registered.',
      }
    }
    if (method === 'POST') {
      // /upload reads its own (possibly binary) body, so it must NOT go through
      // the JSON text reader.
      if (path === '/upload') return handleUpload(req, query)
      // /send 要承载 base64 图片，body 天然比别的接口大得多，给它单独的上限。
      const bodyLimit = (path === '/send') ? MAX_SEND_BYTES : MAX_BODY_BYTES
      const body = await readJsonBody(req, bodyLimit)
      if (path === '/model') return handleSelectModel(body)
      if (path === '/send') return handleSend(body)
      if (path === '/sessions') return handleCreateSession(body)
      if (path === '/cancel') return handleCancel(body)
    }
    return {
      httpStatus: 404,
      body: {
        ok: false,
        error: failure('not-found', `no route for ${method} ${path}`),
        routes: [
          'GET  /health',
          'GET  /status',
          'GET  /models',
          'GET  /messages',
          'GET  /sessions',
          'GET  /tools',
          'POST /model',
          'POST /send',
          'POST /upload',
          'POST /sessions',
          'POST /cancel',
        ],
      },
    }
  }

  const server = createServer((req, res) => {
    const send = (status, payload) => {
      const body = payload === null ? '' : JSON.stringify(payload, null, 2)
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, X-DSH-Token',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      })
      res.end(body)
    }

    let url
    try {
      url = new URL(req.url ?? '/', `http://${options.host}:${options.port}`)
    } catch {
      send(400, { ok: false, error: failure('bad-request', 'malformed request URL') })
      return
    }

    if (options.token !== '' && req.headers['x-dsh-token'] !== options.token) {
      send(401, { ok: false, error: failure('unauthorized', 'missing or wrong X-DSH-Token header') })
      return
    }

    Promise.resolve()
      .then(() => route(req, url))
      .then((outcome) => send(outcome.httpStatus ?? 200, outcome.body ?? outcome))
      .catch((error) => {
        const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500
        // A 4xx is a caller mistake with a self-explanatory body; only a real
        // server fault deserves a stack trace in the host log.
        if (status >= 500) ctx.logger?.warn?.(`harmony-remote: ${String(error?.stack ?? error)}`)
        let code = status >= 500 ? 'internal' : 'bad-request'
        let message = String(error?.message ?? error)
        if (status === 413) {
          code = 'body-too-large'
          message = `${message}。图片请先用 POST /upload 上传，再在 /send 里用 fileRefs 引用路径，不要内联 base64。`
        }
        send(status, { ok: false, error: failure(code, message) })
      })
  })

  ctx.effect(() => {
    const loopback = options.host === '127.0.0.1' || options.host === 'localhost' || options.host === '::1'
    if (!loopback && options.token === '') {
      ctx.logger?.warn?.(
        `harmony-remote: binding ${options.host}:${options.port} with NO token — every device on this network can drive the agent and read every transcript. Set a non-empty \`token\` in cordis.patch.yml.`,
      )
    }
    server.on('error', (error) => {
      ctx.logger?.error?.(`harmony-remote: listener failed on ${options.host}:${options.port}: ${String(error)}`)
    })
    server.listen(options.port, options.host, () => {
      ctx.logger?.info?.(
        `harmony-remote: REST bridge listening on http://${options.host}:${options.port} (auth ${options.token === '' ? 'OFF' : 'token required'})`,
      )
    })
    return () => {
      server.close()
    }
  }, 'dsh-harmony-remote.http')

  if (options.exposeTool !== false) {
    ctx.tools.register(defineTool({
      name: 'harmony_remote_info',
      description:
        'Report the address and authentication state of the local REST bridge that lets a paired HarmonyOS phone remote-control this harness. Use it when the user asks how to connect the phone app, or which URL/port/token the bridge is serving on.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            url: { type: 'string', required: true },
            port: { type: 'integer', required: true },
            host: { type: 'string', required: true },
            authRequired: { type: 'boolean', required: true },
            endpoints: { type: 'array', required: true, items: { type: 'string' } },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `HarmonyOS remote bridge: ${value.url} (auth ${value.authRequired ? 'required' : 'off'})` }],
      },
      execute() {
        return Promise.resolve({
          url: `http://${options.host}:${options.port}`,
          port: options.port,
          host: options.host,
          authRequired: options.token !== '',
          endpoints: [
            'GET /status', 'GET /models', 'GET /messages', 'GET /sessions', 'GET /tools', 'GET /health',
            'POST /model', 'POST /send', 'POST /sessions', 'POST /cancel',
          ],
        })
      },
    }))
  }
}
