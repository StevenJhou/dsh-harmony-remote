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

  /* ======================================================================
   * confirm-approval 模块
   * ----------------------------------------------------------------------
   * 把 DSH 的两套「问人」机制旁路一份到鸿蒙端，电脑端原生框照常保留，
   * 任意一端先答先生效。全部走插件机制，不改 DSH 本体源码。
   *
   * 已核对的真实接口（读的是本地装的 dsh-user-approval / dsh-user-questions /
   * dsh-host-apiproxy，不是照任务书描述写的）：
   *   · 审批走**瀑布事件** `approval/request`，签名
   *       (this: Scoped<ApprovalService>, req: ApprovalRequest,
   *        next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome>
   *     结局取值只有 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'。
   *     **网页端那个审批框就是 dsh-host-apiproxy 里注册的同类监听器** —— 我们的
   *     监听器包在它外面，next() 即「让原生框继续」，两者天然并行。
   *   · ask_user_question 走 `ctx.userQuestions.ask()`，而 UserQuestionService
   *     **只允许一个 provider**（网页端已注册，再注册抛 DUPLICATE_PROVIDER）——
   *     所以这里包装服务的 ask 方法：对所有调用方生效，且不受注册先后影响。
   *
   * 通道：插件本来只有 HTTP 轮询，无法实时推送。这里加**长轮询** GET /events
   *（不用 WebSocket）—— 实时性与 SSE/WS 等价（请求挂着，事件一到立刻返回），
   * 但客户端用普通 HTTP 就行，不引入新协议、不引入任何依赖。
   * ==================================================================== */

  /** 长轮询最长挂多久（毫秒）。挂太久容易被中间设备掐断。 */
  const EVENT_HOLD_MS = 25000

  /**
   * 等人作答的最长窗口（毫秒）。**必须与 EVENT_HOLD_MS 分开**。
   *
   * 之前两个都用 25000，结果是：手机弹出框后用户只要看题超过 25 秒，
   * 服务端就把待确认删掉了，用户再点选项 → POST /confirm 返回 404
   * unknown-confirm → 手机上看到「回填失败：没有这条待确认（可能已超时）」。
   * 长轮询的一次请求挂 25 秒是对的，但「给人思考的时间」显然不能也是 25 秒。
   */
  const ANSWER_TIMEOUT_MS = 5 * 60 * 1000

  /** 待决确认（审批 / 问答）：id -> 记录。 */
  const pendingConfirms = new Map()

  /** 已处理的 id -> 处理时间，用于回「已被处理」。 */
  const resolvedConfirms = new Map()

  /** 未取走的事件队列 + 自增游标。 */
  let eventCursor = 0
  const eventLog = []

  /** 挂着的长轮询唤醒器。 */
  const eventWaiters = new Set()

  function wakeEventWaiters() {
    for (const wake of Array.from(eventWaiters)) {
      try {
        wake()
      } catch {
        /* 唤醒失败无所谓，超时后它自己会返回 */
      }
    }
    eventWaiters.clear()
  }

  /** 入队一个事件。旧版鸿蒙端不认识新 type 会直接忽略，不会报错。 */
  function emitEvent(event) {
    eventCursor += 1
    eventLog.push({ cursor: eventCursor, ...event })
    while (eventLog.length > 200) eventLog.shift()
    wakeEventWaiters()
  }

  /** 清理过期的已处理记录（10 分钟）。 */
  function sweepResolved() {
    const cutoff = Date.now() - 10 * 60 * 1000
    for (const entry of Array.from(resolvedConfirms.entries())) {
      if (entry[1] < cutoff) resolvedConfirms.delete(entry[0])
    }
  }

  /** 永不 settle 的 Promise：配合 Promise.race 表示「这一侧不参与竞争」。 */
  function neverSettle() {
    return new Promise(() => {})
  }

  /**
   * 派发给鸿蒙端并等它作答。
   * 无人作答 / 超时 / 被取消时 reject —— 调用方靠 race 让原生框接管，
   * 所以手机不在线绝不会拖住 DSH。
   */
  function askRemote(kind, payload, signal) {
    const id = `cf-${randomUUID()}`
    let settleOk
    let settleNo
    const promise = new Promise((resolve, reject) => {
      settleOk = resolve
      settleNo = reject
    })
    const record = { id, kind, payload, resolve: settleOk, reject: settleNo, timer: null, startedAt: Date.now() }
    record.timer = setTimeout(() => {
      pendingConfirms.delete(id)
      // 这条日志是「手机上点了没反应 / 报回填失败」的第一现场：
      // 一旦出现它，就说明人在规定时间内没作答，之后 POST /confirm 必然 404。
      ctx.logger?.warn?.(
        `harmony-remote: confirm ${id} (${kind}) 等了 ${Math.round(ANSWER_TIMEOUT_MS / 1000)}s 没人作答，已作废`,
      )
      settleNo(new Error('harmony remote did not answer in time'))
    }, ANSWER_TIMEOUT_MS)

    /**
     * 另一端（电脑端原生框）先作答时，把这条从待确认里撤下来。
     *
     * 不撤的话，手机上那个框还挂着，用户点下去会拿到 200 —— 但那边早就
     * 尘埃落定了，等于「提示成功、其实什么都没发生」。撤下来之后，
     * 迟到的作答会得到 409 already-resolved，App 会明确告诉他另一端先答了。
     */
    record.withdraw = (by) => {
      if (!pendingConfirms.delete(id)) return
      clearTimeout(record.timer)
      resolvedConfirms.set(id, Date.now())
      emitEvent({ type: 'confirm_resolved', id, by })
      settleNo(new Error(`withdrawn by ${by}`))
    }

    pendingConfirms.set(id, record)
    emitEvent({ type: 'confirm_request', id, kind, payload })
    ctx.logger?.info?.(`harmony-remote: confirm ${id} (${kind}) 已推送给鸿蒙端，等待作答`)
    if (signal !== undefined) {
      signal.addEventListener('abort', () => {
        const rec = pendingConfirms.get(id)
        if (rec !== undefined) {
          pendingConfirms.delete(id)
          clearTimeout(rec.timer)
          settleNo(new Error('cancelled'))
        }
      }, { once: true })
    }
    return { id, promise, withdraw: record.withdraw }
  }

  /** 鸿蒙端作答。 */
  function resolveConfirm(id, answer) {
    sweepResolved()
    if (resolvedConfirms.has(id)) {
      // 双端同时作答：后到的这端被明确告知「已被处理」
      return { ok: false, httpStatus: 409, code: 'already-resolved', message: '这条确认已被处理（另一端先作答了）' }
    }
    const record = pendingConfirms.get(id)
    if (record === undefined) {
      ctx.logger?.warn?.(`harmony-remote: POST /confirm ${id} 落空（没有这条待确认，多半是超时作废了）`)
      return { ok: false, httpStatus: 404, code: 'unknown-confirm', message: '没有这条待确认（可能已超时）' }
    }
    pendingConfirms.delete(id)
    resolvedConfirms.set(id, Date.now())
    clearTimeout(record.timer)
    record.resolve(answer)
    emitEvent({ type: 'confirm_resolved', id, by: 'harmony' })
    ctx.logger?.info?.(
      `harmony-remote: confirm ${id} 由鸿蒙端作答（等了 ${Date.now() - record.startedAt}ms）`,
    )
    return { ok: true }
  }

  /**
   * 造一条「只给电脑端用」的信号，并把它接到调用方原本的信号上。
   *
   * 用途：手机先答之后，用它去 abort 电脑端那条路，**把电脑上的框关掉**。
   * 网页端弹框是被 mux 广播关掉的（`dsh-client-runtime` 收到
   * `question/resolved` / `approval/resolved` 就 settle 掉等待），而宿主侧
   * 唯一的触发口就是 apiproxy 注册在 signal 上的 abort 监听器。
   *
   * 关键：**被 abort 的必须是这条替身，绝不能是调用方原本的信号**。
   * 原本那条一旦 abort，`dsh-user-approval` 自己 race 出来的结局会变成
   * 'cancelled' —— 用户手机上明明点了「允许一次」，到头来变成取消。替身
   * 只被下游那个「网页端弹框」监听器看着，abort 它只影响那个框的去留。
   *
   * @param original 调用方原本的信号；它一 abort，替身立刻跟着 abort（透传取消）。
   */
  function desktopOnlySignal(original) {
    const controller = new AbortController()
    if (original !== undefined && original !== null) {
      if (original.aborted === true) controller.abort()
      else original.addEventListener('abort', () => controller.abort(), { once: true })
    }
    return controller
  }

  /**
   * 审批桥：包在网页端监听器外面。
   *
   * 原生框（next()）与鸿蒙端同时进行，谁先给出**合法结局**谁生效。
   * 这里只接受 allowed-once / rejected / cancelled —— 任何意外值都被丢弃、
   * 把决定权交回原生框。**沙箱语义一点没动**：我们只可能额外「允许一次」或
   * 「拒绝」，不可能把 deny 放宽成 allow，fail-closed 也完全保持。
   */
  function installApprovalBridge() {
    /**
     * 必须是 `{ prepend: true }` —— 这条是整个审批桥能不能跑起来的关键。
     *
     * cordis 的 waterfall 是**链式**的：第 1 个监听器拿到 `next()`，它不调
     * `next()` 就轮到第 2 个。而 apiproxy 那个「网页端弹框」监听器
     *（dsh-host-apiproxy:1903）一旦匹配到审批就 `return new Promise(...)`
     * 且**不调 next()**。本插件由 cordis.patch.yml 的 insert 挂载、排在
     * 所有 bundle 之后，默认注册顺序必然在 apiproxy **后面** ——
     * 那样这个监听器永远轮不到执行，审批一个都推不到手机。
     * `register()` 是 `options.prepend ? 'unshift' : 'push'`，prepend 之后
     * 我们稳定地包在 apiproxy 外面，与加载顺序无关。
     */
    return ctx.on('approval/request', (req, next) => {
      // 给下游的「网页端弹框」换一条我们控制的信号。cordis 的 waterfall
      // `next()` 不收参数（`const next = () => (...)(...args)`），没法换
      // request 对象，只能就地改 `req.signal`。爆炸半径是可枚举的：
      // 全仓库监听 `approval/request` 的运行时监听器只有 apiproxy 那一个，
      // 而 `dsh-user-approval` 早在进 waterfall 之前就把原信号存成局部变量了
      // （lib/index.js:186），所以它自己的 race 不受影响。
      const desktop = desktopOnlySignal(req.signal)
      try {
        req.signal = desktop.signal
      } catch {
        // 万一 request 被冻结（strict mode 下赋值会抛）：放弃关框，
        // 这只是体验，绝不能因此影响审批本身的正确性。
      }

      let native = Promise.resolve().then(() => next())
      let remote
      let remoteWon = false
      try {
        const asking = askRemote('approval', {
          toolName: typeof req.toolName === 'string' ? req.toolName : '',
          reason: typeof req.reason === 'string' ? req.reason : '',
          sessionId: req.agent !== undefined ? String(req.agent.id) : '',
        }, req.signal)
        remote = asking.promise.then((answer) => {
          const outcome = (answer !== null && typeof answer === 'object') ? answer.outcome : undefined
          if (outcome === 'allowed-once' || outcome === 'rejected' || outcome === 'cancelled') {
            remoteWon = true
            return outcome
          }
          return undefined
        }).catch(() => undefined)
        // 原生框先出结果就把鸿蒙端那条撤掉（见 askRemote 里的 withdraw 说明）
        native = native.then(
          (outcome) => { asking.withdraw('desktop'); return outcome },
          (error) => { asking.withdraw('desktop'); throw error },
        )
      } catch {
        remote = Promise.resolve(undefined)
      }
      const remoteOrNever = remote.then((outcome) => (outcome === undefined ? neverSettle() : outcome))
      const race = Promise.race([remoteOrNever, native])
      /**
       * 关电脑端那个框的动作必须放在**竞争出结果之后**。
       *
       * abort 会让下游立刻落定（审批 `settle('cancelled')`、问答 reject
       * ASK_ABORTED），而这条落定的排队位置**比 remote 的值更靠前**
       * （remote 还多经过 remoteOrNever 一跳）。要是赶在 race 之前 abort，
       * 赢的就是下游那个 'cancelled'：用户手机上点了「允许一次」，到头来
       * 变成取消 —— 这正是本轮自检抓出来的那个 bug（结局 = cancelled）。
       */
      return race.then((value) => {
        if (remoteWon) desktop.abort()
        return value
      })
    }, { prepend: true })
  }

  /**
   * 问答桥：包装 userQuestions.ask（不能 registerProvider —— 只允许一个 provider）。
   * 同样与原生 provider 并行，谁先答谁生效。
   */
  function installQuestionBridge() {
    const questions = ctx.get('userQuestions')
    if (questions === undefined || typeof questions.ask !== 'function') {
      return () => {}
    }
    const originalAsk = questions.ask.bind(questions)

    /**
     * 把鸿蒙端回填的答案整形成 DSH 真正要求的形状。
     *
     * **这里是之前的致命 bug**：`ask()` 必须 resolve 成 `{ answers: [...] }`
     *（见 dsh-tool-ask-user：`(await ctx.userQuestions.ask(...)).answers.map(...)`），
     * 而旧代码直接 resolve 了裸数组 → `.answers` 是 undefined → 工具里
     * `Cannot read properties of undefined (reading 'map')`。
     * 手机上框能正常弹出、一点选项电脑端就报这个错，就是它。
     *
     * 同时兼容旧版鸿蒙端：它把题目 id 写在 `questionId` 字段上，
     * 而 DSH 的 `AskUserQuestionAnswerItem` 要求字段名是 `id`
     *（`id` 还是 output schema 里的 required string，缺了就过不了校验）。
     * 所以两种写法都收，统一输出成 `id`。
     */
    function normalizeAnswers(raw) {
      const list = Array.isArray(raw) ? raw : []
      const out = []
      for (const item of list) {
        if (item === null || typeof item !== 'object') continue
        const id = (typeof item.id === 'string' && item.id !== '')
          ? item.id
          : ((typeof item.questionId === 'string') ? item.questionId : '')
        if (id === '') continue
        const selected = Array.isArray(item.selected)
          ? item.selected.filter((label) => typeof label === 'string')
          : []
        const custom = typeof item.custom === 'string' ? item.custom.trim() : ''
        if (selected.length === 0 && custom === '') continue
        out.push(custom === '' ? { id, selected } : { id, selected, custom: item.custom })
      }
      return out
    }

    questions.ask = (request) => {
      /**
       * 电脑端那条路用替身信号。
       *
       * 问答这边不用像审批那样就地改对象 —— `ask(request)` 的 request 是
       * 我传进去的，直接给一份改了 `signal` 的副本即可（provider 读的正是
       * 传进 `ask()` 的这个对象，见 dsh-user-questions/lib/index.js:72）。
       * 手机先答 -> abort 替身 -> apiproxy 广播 `question/resolved` ->
       * 网页端那个框自己关掉。
       */
      const desktop = desktopOnlySignal(request.signal)
      let native = Promise.resolve().then(() => originalAsk({ ...request, signal: desktop.signal }))
      let remote
      let remoteWon = false
      try {
        const list = Array.isArray(request.questions) ? request.questions : []
        const asking = askRemote('question', {
          sessionId: request.agent !== undefined ? String(request.agent.id) : '',
          questions: list.map((q) => ({
            id: q.id,
            header: q.header,
            question: q.question,
            ...(Array.isArray(q.options) ? { options: q.options } : {}),
            // multiSelect / detail 必须一起带上：不带的话手机端根本不知道
            // 这道题能多选，也看不到 plan-review 要审的正文，只能退化成
            // 「点一下就提交、还没法改」——这正是用户报的那个 UI 问题。
            ...(q.multiSelect === true ? { multiSelect: true } : {}),
            ...(typeof q.detail === 'string' ? { detail: q.detail } : {}),
          })),
        }, request.signal)
        remote = asking.promise.then((answer) => {
          const raw = (answer !== null && typeof answer === 'object') ? answer.answers : undefined
          const answers = normalizeAnswers(raw)
          if (answers.length === 0) {
            ctx.logger?.warn?.('harmony-remote: 问答桥收到的作答里没有任何可用项，交回电脑端原生框')
            return undefined
          }
          ctx.logger?.info?.(`harmony-remote: 问答桥采用鸿蒙端作答 ${answers.length} 条（id=${answers.map((a) => a.id).join(',')}）`)
          remoteWon = true
          return { answers }
        }).catch((error) => {
          ctx.logger?.info?.(`harmony-remote: 问答桥未取得鸿蒙端作答（${String(error?.message ?? error)}），交回电脑端原生框`)
          return undefined
        })
        // 电脑端原生框先答就把鸿蒙端那条撤掉，免得手机上点了「成功」其实无效
        native = native.then(
          (value) => { asking.withdraw('desktop'); return value },
          (error) => { asking.withdraw('desktop'); throw error },
        )
      } catch {
        remote = Promise.resolve(undefined)
      }
      const remoteOrNever = remote.then((answers) => (answers === undefined ? neverSettle() : answers))
      const race = Promise.race([remoteOrNever, native])
      // 同审批桥：必须等竞争出结果之后再 abort。abort 会让 apiproxy 那边
      // 立刻 reject(ASK_ABORTED)，那条落定排得比 remote 的值更靠前，
      // 提前 abort 就会让 ask() 抛 ASK_ABORTED，手机的作答反而白费。
      return race.then((value) => {
        if (remoteWon) desktop.abort()
        return value
      })
    }
    return () => {
      delete questions.ask
      questions.ask = originalAsk
    }
  }

  // 安装两个桥；返回的 disposer 交给 ctx.effect，插件卸载时自动还原
  ctx.effect(() => {
    const disposeApproval = installApprovalBridge()
    const disposeQuestions = installQuestionBridge()
    return () => {
      try { disposeApproval() } catch { /* 忽略 */ }
      try { disposeQuestions() } catch { /* 忽略 */ }
    }
  }, 'dsh-harmony-remote.confirm-approval')

  /**
   * 取出 `from` 之后**还有效**的事件。
   *
   * 关键在最后那个过滤：`confirm_request` 一旦过期、被另一端作答、或被人
   * 取消，就必须从返回值里消失。否则 App 每次冷启动（`since=0`）都会把
   * 历史队列里那一批**早就作废**的确认重新弹一遍 —— 用户点任何一项，
   * 服务端 `pendingConfirms` 里都没有它，只能得到 404 unknown-confirm，
   * 表现就是「弹窗怎么点都确认不了」。
   *
   * `confirm_resolved` 保留：它是给多端对账用的（谁先答的），并且能覆盖
   * 掉刚被撤下的那条 request 的游标，客户端不会卡在旧位置上。
   */
  function eventsSince(from) {
    return eventLog
      .filter((e) => e.cursor > from)
      .filter((e) => e.type !== 'confirm_request' || pendingConfirms.has(e.id))
  }

  /** `GET /events` —— 长轮询：有事件立刻返回，没有就挂到 EVENT_HOLD_MS。 */
  function handleEvents(query) {
    const raw = Number.parseInt(String(query.since ?? '0'), 10)
    const requested = Number.isFinite(raw) && raw > 0 ? raw : 0
    /**
     * 游标比服务端还大 = 客户端记的是**上一次运行的**游标。
     *
     * `eventCursor` 只活在内存里，dsh 一重启就归零；而客户端（手机 App）
     * 还攥着重启前那个大游标。若照直用 `cursor > 4` 过滤，接着发出去的
     * 事件（游标 1、2…）全部落在过滤线以下 —— 表现就是「重启后手机再也
     * 收不到弹窗」，要等一次 25 秒长轮询超时才自愈。
     * 所以这里直接把它当成「服务端重启过」重置为 0：新纪元的日志本来就
     * 只有新事件，脏的 confirm_request 又已经被过滤掉了，重放是安全的。
     */
    const from = requested > eventCursor ? 0 : requested
    const ready = eventsSince(from)
    if (ready.length > 0) {
      return Promise.resolve({ ok: true, cursor: eventCursor, events: ready })
    }
    return new Promise((resolve) => {
      let settled = false
      let timer = null
      const wake = () => {
        if (settled) return
        settled = true
        if (timer !== null) clearTimeout(timer)
        eventWaiters.delete(wake)
        resolve({ ok: true, cursor: eventCursor, events: eventsSince(from) })
      }
      timer = setTimeout(wake, EVENT_HOLD_MS)
      eventWaiters.add(wake)
    })
  }

  /** `POST /confirm` —— 鸿蒙端作答。 */
  function handleConfirm(body) {
    const id = typeof body.id === 'string' ? body.id : ''
    if (id === '') {
      return { httpStatus: 400, body: { ok: false, error: failure('bad-request', '`id` is required') } }
    }
    const answer = (body.answer !== null && typeof body.answer === 'object') ? body.answer : {}
    const done = resolveConfirm(id, answer)
    if (!done.ok) {
      return { httpStatus: done.httpStatus, body: { ok: false, error: failure(done.code, done.message) } }
    }
    return { ok: true, id }
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
    // 长轮询：给鸿蒙端推 confirm_request（审批 / ask_user_question）
    if (method === 'GET' && path === '/events') return handleEvents(query)
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
      if (path === '/confirm') return handleConfirm(body)
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
            'GET /events', 'POST /model', 'POST /send', 'POST /upload', 'POST /sessions', 'POST /cancel',
            'POST /confirm',
          ],
        })
      },
    }))
  }
}
