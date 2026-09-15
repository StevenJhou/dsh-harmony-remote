/**
 * Dev harness: run the bridge with STUBBED dsh services so the REST API can be
 * curled without restarting the live dsh host.
 *
 *   node test/serve.mjs [port]
 *   curl http://127.0.0.1:3199/status
 *
 * This is a development tool only. The real bridge is started by dsh itself
 * from cordis.patch.yml.
 */
import { apply } from '../lib/index.js'

const PORT = Number.parseInt(process.argv[2] ?? '3199', 10)
const ok = (req, value) => ({ rpcId: req.rpcId, result: { ok: true, value } })

const apiProxy = {
  sessions: {
    list: async (r) => ok(r, { items: [{ sessionId: 'stub-session', title: 'Stub session' }] }),
    models: async (r) => ok(r, {
      current: { provider: 'deepseek', model: 'deepseek-flash' },
      routable: true,
      groups: [{ provider: 'deepseek', models: [{ model: 'deepseek-flash' }, { model: 'deepseek-reasoner' }] }],
      failures: [],
    }),
    selectModel: async (r) => ok(r, { selected: { provider: r.payload.provider, model: r.payload.model } }),
    prompt: async (r) => { console.log('  [stub] prompt:', JSON.stringify(r.payload)); return ok(r, { accepted: true }) },
    create: async (r) => ok(r, { sessionId: r.payload.sessionId ?? 'stub-new', agentPreset: 'standard' }),
    cancel: async (r) => { console.log('  [stub] cancel:', JSON.stringify(r.payload)); return ok(r, { accepted: true }) },
    history: async (r) => ok(r, {
      hasMore: false,
      events: [
        { seq: 1, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '帮我看下首页渲染' }], source: { kind: 'user' } } },
        { seq: 2, type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '好的，先读 Index.ets。' }] } } },
      ],
    }),
  },
}

const ctx = {
  get: (s) => (s === 'apiProxy' ? apiProxy : s === 'agents' ? { list: () => [{ id: 'stub-session', status: 'idle', options: { provider: 'deepseek', model: 'deepseek-flash' } }] } : s === 'tools' ? { list: () => [] } : undefined),
  effect: (fn) => { fn(); return { dispose: () => {} } },
  tools: { register: () => () => {} },
  logger: { info: (m) => console.log(`  [dsh] ${m}`), warn: (m) => console.log(`  [dsh warn] ${m}`), error: (m) => console.log(`  [dsh err] ${m}`) },
}

apply(ctx, { host: '127.0.0.1', port: PORT, token: '', exposeTool: true })
console.log(`stub bridge on http://127.0.0.1:${PORT} — ctrl-c to stop`)
