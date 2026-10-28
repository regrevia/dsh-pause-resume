// spike: a minimal OpenAI-compatible chat-completions server used only by the
// host-live spike. It is NOT part of the shipped plugin and nothing imports it
// from index.js / lib/. Two behaviours matter here:
//   - normal mode: stream a short answer and close, so a turn can finish;
//   - hold mode: stream a few deltas then keep the connection open, so a real
//     Host turn stays `running` long enough to be paused and killed.
// Every request is counted and logged so a resumed turn can be told apart from
// a replayed one by the *server's* own record, not by the Host's claims.
//
// Standalone: `node acceptance/mock-llm.mjs [--hold N] [--text S]` prints
// `ready <port>` and serves until SIGTERM/SIGINT.
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

const DEFAULT_TEXT = 'MOCK_LLM_OK'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function chunk(id, model, delta, finishReason = null) {
  return `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`
}

function usageChunk(id, model, promptChars, completionChars) {
  // Approximate token counts; the Host only needs sane non-zero numbers.
  const promptTokens = Math.max(1, Math.ceil(promptChars / 4))
  const completionTokens = Math.max(1, Math.ceil(completionChars / 4))
  return `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  })}\n\n`
}

/**
 * Start the mock server.
 * @param {object} [options]
 * @param {number} [options.holdRequests] hold this many requests open (FIFO); later ones finish.
 * @param {string} [options.text] answer text streamed as deltas.
 * @param {number} [options.deltas] how many content deltas the answer is split into.
 * @param {number} [options.port] 0 picks a free port.
 */
export async function startMockLlm(options = {}) {
  const {
    holdRequests = 0,
    text = DEFAULT_TEXT,
    deltas = 6,
    port = 0,
  } = options

  /** @type {Array<{n:number, at:string, path:string, model:string|null, stream:boolean, messages:number, held:boolean}>} */
  const requests = []
  /** @type {Set<{release:() => void}>} */
  const held = new Set()
  let heldSoFar = 0

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] }))
      return
    }
    if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `mock-llm: no route ${req.method} ${url.pathname}` } }))
      return
    }

    let raw = ''
    for await (const part of req) raw += part
    let body = {}
    try {
      body = JSON.parse(raw)
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'mock-llm: request body is not JSON' } }))
      return
    }

    const model = typeof body.model === 'string' ? body.model : 'mock-model'
    const stream = body.stream === true
    const messageCount = Array.isArray(body.messages) ? body.messages.length : 0
    const promptChars = raw.length
    const isHeld = heldSoFar < holdRequests
    if (isHeld) heldSoFar += 1

    const n = requests.length + 1
    const record = {
      n,
      at: new Date().toISOString(),
      path: url.pathname,
      model,
      stream,
      messages: messageCount,
      lastRole: Array.isArray(body.messages) ? body.messages.at(-1)?.role ?? null : null,
      lastText: lastTextOf(body.messages),
      allText: allTextOf(body.messages),
      held: isHeld,
    }
    requests.push(record)
    process.stderr.write(`mock-llm request ${n}: ${JSON.stringify(record)}\n`)

    if (!stream) {
      // Non-streaming path: answer at once. The Host uses it for summarization
      // and other one-shot calls; nothing here needs to hold.
      const content = `${text} (non-stream)`
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: `mock-${n}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: Math.max(1, Math.ceil(promptChars / 4)),
          completion_tokens: Math.max(1, Math.ceil(content.length / 4)),
          total_tokens: Math.max(1, Math.ceil((promptChars + content.length) / 4)),
        },
      }))
      return
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-mock-llm-request': String(n),
    })
    const id = `mock-${n}`
    const parts = splitText(text, deltas)
    let released = false
    let closed = false
    req.on('close', () => { closed = true })
    const gate = { release: () => { released = true } }
    if (isHeld) held.add(gate)

    try {
      res.write(chunk(id, model, { role: 'assistant', content: '' }))
      const head = isHeld ? Math.max(1, parts.length - 2) : parts.length
      for (let i = 0; i < head; i += 1) {
        if (closed) return
        res.write(chunk(id, model, { content: parts[i] }))
        await sleep(40)
      }
      if (isHeld) {
        // Hold the turn open: SSE comments keep the socket warm without
        // producing deltas. release() lets the answer finish.
        record.heldAt = new Date().toISOString()
        while (!released && !closed) {
          res.write(': mock-llm holding\n\n')
          await sleep(200)
        }
        record.releasedAt = new Date().toISOString()
        if (closed) return
        for (let i = head; i < parts.length; i += 1) res.write(chunk(id, model, { content: parts[i] }))
      }
      res.write(usageChunk(id, model, promptChars, text.length))
      res.write(chunk(id, model, {}, 'stop'))
      res.write('data: [DONE]\n\n')
      record.finishedAt = new Date().toISOString()
      res.end()
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error)
      try { res.destroy() } catch { /* already gone */ }
    } finally {
      held.delete(gate)
      record.closed = closed
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  const boundPort = typeof address === 'object' && address !== null ? address.port : port

  return {
    port: boundPort,
    baseURL: `http://127.0.0.1:${boundPort}/v1`,
    requests,
    /** Release the oldest still-held stream (and all later releases are no-ops). */
    release() {
      const [first] = held
      if (first !== undefined) first.release()
      return first !== undefined
    },
    releaseAll() {
      for (const gate of held) gate.release()
      return held.size
    },
    async close() {
      this.releaseAll()
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

function lastTextOf(messages) {
  if (!Array.isArray(messages)) return ''
  const last = messages.at(-1)
  const content = last?.content
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join(' ')
      : ''
  return text.slice(0, 160)
}

function allTextOf(messages) {
  if (!Array.isArray(messages)) return ''
  return messages.map((message) => {
    const content = message?.content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join(' ')
    return ''
  }).join('\n').slice(0, 20_000)
}

function splitText(text, parts) {
  const count = Math.max(1, Math.min(parts, text.length || 1))
  const size = Math.ceil(text.length / count)
  const out = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out.length > 0 ? out : ['']
}

// Standalone entry point: `node acceptance/mock-llm.mjs [--hold N] [--text S]`
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2)
  const flag = (name, fallback) => {
    const index = argv.indexOf(name)
    return index === -1 ? fallback : argv[index + 1]
  }
  const mock = await startMockLlm({
    holdRequests: Number.parseInt(flag('--hold', '0'), 10),
    text: flag('--text', DEFAULT_TEXT),
  })
  process.stdout.write(`ready ${mock.port}\n`)
  const stop = async () => {
    await mock.close()
    process.exit(0)
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}
