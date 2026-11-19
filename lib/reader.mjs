// 用本机 Chrome（CDP）渲染页面并抽取干净 markdown。
// 零第三方依赖：CDP 走 Node 内置 WebSocket，chrome 用系统已安装的浏览器。
// 所有落盘都写 D 盘缓存目录，绝不写 C 盘。

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'

/**
 * 缓存根目录——跨平台自适应，包内不写死任何盘符。
 * 优先级：DSH_WEB_READER_CACHE_DIR > DSH_HOME/cache/web-reader > 系统临时目录。
 * DSH 会话必然带 DSH_HOME，因此实际总是落在 DSH 自己的数据目录下。
 * 可用环境变量覆盖到任意目录（例如本机铁律要求只写 D 盘时）。
 */
export const CACHE_DIR = process.env.DSH_WEB_READER_CACHE_DIR
  ?? (process.env.DSH_HOME
    ? join(process.env.DSH_HOME, 'cache', 'web-reader')
    : join(tmpdir(), 'dsh-web-reader'))
/** 诊断日志目录：与缓存同源，默认在缓存目录下。 */
export const LOG_DIR = process.env.DSH_WEB_READER_LOG_DIR ?? CACHE_DIR
const PROFILE_DIR = join(CACHE_DIR, 'chrome-profile')

const CHROME_CANDIDATES = [
  process.env.DSH_CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter((value) => typeof value === 'string' && value.length > 0)

/** 找到第一个存在的浏览器可执行文件；找不到返回 undefined。 */
export function findBrowser() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {}
  }
  return undefined
}

function ensureDirs() {
  mkdirSync(CACHE_DIR, { recursive: true })
  mkdirSync(PROFILE_DIR, { recursive: true })
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('no free port'))))
    })
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 浏览器进程池：一个常驻 headless Chrome，串行处理渲染请求。 */
class Browser {
  constructor(executable) {
    this.executable = executable
    this.child = undefined
    this.port = 0
    this.booting = undefined
  }

  async ensure() {
    if (this.child !== undefined && this.port > 0) return this.port
    if (this.booting === undefined) {
      this.booting = this.start().finally(() => {
        this.booting = undefined
      })
    }
    return await this.booting
  }

  async start() {
    ensureDirs()
    // 共享的 user-data-dir 一旦被另一个 Chrome 占用（例如另一个进程/会话已经在跑，
    // 或者上一次的浏览器还没退出），新进程会把启动参数转发给旧实例然后直接退出，
    // CDP 端口就永远不会出现。所以失败时退回带 PID 的独立 profile 再试一次。
    const profiles = [PROFILE_DIR, `${PROFILE_DIR}-${process.pid}`]
    let lastError
    for (const profile of profiles) {
      try {
        return await this.launch(profile)
      } catch (error) {
        lastError = error
        this.dispose()
      }
    }
    throw lastError ?? new Error('chrome 启动失败')
  }

  async launch(profileDir) {
    const port = await freePort()
    const child = spawn(
      this.executable,
      [
        '--headless=new',
        `--remote-debugging-port=${port}`,
        '--remote-allow-origins=*',
        `--user-data-dir=${profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-breakpad',
        '--disable-crash-reporter',
        '--mute-audio',
        '--hide-scrollbars',
        '--window-size=1440,900',
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
    )
    let exited = false
    child.once('exit', () => {
      exited = true
      if (this.child === child) {
        this.child = undefined
        this.port = 0
      }
    })
    this.child = child
    this.port = port
    const deadline = Date.now() + 12_000
    while (Date.now() < deadline) {
      if (exited) throw new Error(`chrome 进程已退出（profile 被占用？）: ${profileDir}`)
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`)
        if (response.ok) {
          await response.json()
          return port
        }
      } catch {}
      await sleep(150)
    }
    throw new Error(`chrome did not expose CDP on port ${port}`)
  }

  dispose() {
    const child = this.child
    this.child = undefined
    this.port = 0
    if (child !== undefined) {
      try {
        child.kill()
      } catch {}
    }
  }
}

let browser

function getBrowser() {
  if (browser === undefined) {
    const executable = findBrowser()
    if (executable === undefined) throw new Error('未找到 Chrome/Edge 可执行文件；可用 DSH_CHROME_PATH 指定')
    browser = new Browser(executable)
  }
  return browser
}

/** 极简 CDP 会话：够用的请求/事件收发。 */
class CdpSession {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Set()
    socket.addEventListener('message', (event) => this.receive(event.data))
  }

  static async open(url) {
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true })
      socket.addEventListener('error', () => reject(new Error('CDP socket error')), { once: true })
    })
    return new CdpSession(socket)
  }

  receive(data) {
    let message
    try {
      message = JSON.parse(typeof data === 'string' ? data : String(data))
    } catch {
      return
    }
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id)
      if (entry === undefined) return
      this.pending.delete(message.id)
      if (message.error !== undefined) entry.reject(new Error(`${message.error.message ?? 'CDP error'} (${message.method ?? ''})`))
      else entry.resolve(message.result)
      return
    }
    for (const listener of this.listeners) listener(message)
  }

  send(method, params = {}, timeoutMs = 30_000) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} timeout after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  on(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async evaluate(expression, timeoutMs = 60_000) {
    const result = await this.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true, userGesture: true },
      timeoutMs,
    )
    if (result.exceptionDetails !== undefined) {
      const detail = result.exceptionDetails
      const text = detail.exception?.description ?? detail.text ?? 'in-page exception'
      throw new Error(`页面脚本异常：${String(text).split('\n')[0]}`)
    }
    return result.result?.value
  }

  close() {
    try {
      this.socket.close()
    } catch {}
  }
}

/**
 * 页内抽取函数：把 DOM 转成 markdown。
 * 在浏览器里执行，因此可以用真实 DOM API。
 */
export function extractInPage() {
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED',
    'SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'FORM', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA',
  ])
  const NOISE_PATTERN = /(^|[-_\s])(nav|navbar|navigation|menu|sidebar|side-bar|footer|breadcrumb|toolbar|cookie|banner|advert|ads|share|comment|related|pagination|pager|drawer|modal|popup|backdrop)([-_\s]|$)/i

  const hidden = (element) => {
    const style = window.getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return true
    const rect = element.getBoundingClientRect()
    return rect.width < 2 || rect.height < 2
  }

  const textLength = (element) => {
    const text = element.innerText
    return typeof text === 'string' ? text.trim().length : 0
  }

  const linkTextLength = (element) => {
    let total = 0
    for (const anchor of element.querySelectorAll('a')) total += (anchor.innerText ?? '').trim().length
    return total
  }

  // 选正文根：在候选容器里按"文字量 + 段落块数 - 链接文字占比"打分。
  const pickRoot = () => {
    const body = document.body
    if (body === null) return null
    const candidates = new Set()
    for (const selector of ['article', 'main', '[role="main"]', '#content', '#main', '.markdown-body', '.theme-doc-markdown', '.doc-content', '.article', '.content']) {
      for (const element of document.querySelectorAll(selector)) candidates.add(element)
    }
    candidates.add(body)
    let best = body
    let bestScore = -Infinity
    for (const element of candidates) {
      const length = textLength(element)
      if (length < 80) continue
      const blocks = element.querySelectorAll('p,li,td,th,pre,blockquote,h1,h2,h3,h4').length
      const linkShare = linkTextLength(element) / Math.max(1, length)
      // 链接占比高的容器（纯导航/目录）降权，但不清零——链接索引页本身就是内容。
      const density = length * (1 - Math.min(0.9, linkShare) * 0.85)
      const structural = Math.min(blocks, 800) * 40
      // 正文型容器（article/main）优先；整体 BODY 会额外吞进页头页脚，作为兜底而不是首选。
      const semantic = ['ARTICLE', 'MAIN'].includes(element.nodeName) || element.getAttribute('role') === 'main'
      const score = (density + structural) * (element === body ? 0.3 : semantic ? 2.2 : 1)
      if (score > bestScore) {
        bestScore = score
        best = element
      }
    }
    return best
  }

  const root = pickRoot()
  if (root === null) return { title: document.title, markdown: '', href: location.href }

  const lines = []
  let buffer = ''

  const flush = () => {
    const text = buffer.replace(/[ \t]+/g, ' ').trim()
    buffer = ''
    if (text.length === 0) return
    lines.push(text)
    lines.push('')
  }

  const pushBlock = (text) => {
    flush()
    if (text.length > 0) {
      lines.push(text)
      lines.push('')
    }
  }

  const renderTable = (table) => {
    const rows = []
    for (const row of table.querySelectorAll('tr')) {
      const cells = []
      for (const cell of row.children) {
        if (cell.nodeName !== 'TD' && cell.nodeName !== 'TH') continue
        cells.push((cell.innerText ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim())
      }
      if (cells.length > 0) rows.push(cells)
    }
    if (rows.length === 0) return
    const width = Math.max(...rows.map((row) => row.length))
    const padded = rows.map((row) => [...row, ...Array(width - row.length).fill('')])
    const out = []
    out.push(`| ${padded[0].join(' | ')} |`)
    out.push(`| ${Array(width).fill('---').join(' | ')} |`)
    for (const row of padded.slice(1)) out.push(`| ${row.join(' | ')} |`)
    pushBlock(out.join('\n'))
  }

  const absolute = (raw) => {
    if (typeof raw !== 'string' || raw.length === 0) return ''
    if (/^(?:[a-z]+:)?\/\//i.test(raw) || raw.startsWith('data:')) return raw
    try {
      return new URL(raw, location.href).href
    } catch {
      return raw
    }
  }

  const walk = (node, depth) => {
    if (depth > 80)
      return
    if (node.nodeType === 3) {
      buffer += (node.nodeValue ?? '').replace(/\s+/g, ' ')
      return
    }
    if (node.nodeType !== 1) return
    const element = node
    if (SKIP_TAGS.has(element.nodeName)) return
    if (element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true') return
    const identity = `${element.id ?? ''} ${typeof element.className === 'string' ? element.className : ''}`
    // 根节点自己永不被"噪音"规则排除（正文容器常带 content/sidebar 之类的复合类名）。
    if (element !== root) {
      if (element.nodeName === 'NAV' || element.nodeName === 'FOOTER' || element.nodeName === 'ASIDE') return
      if (NOISE_PATTERN.test(identity)) return
    }

    const tag = element.nodeName.toLowerCase()
    switch (tag) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
        const level = Number(tag.slice(1))
        flush()
        const text = (element.innerText ?? '').replace(/\s+/g, ' ').trim()
        if (text.length > 0) pushBlock(`${'#'.repeat(level)} ${text}`)
        return
      }
      case 'p': {
        flush()
        const before = buffer
        buffer = before
        for (const child of element.childNodes) walk(child, depth + 1)
        flush()
        return
      }
      case 'br':
        buffer += '\n'
        return
      case 'hr':
        pushBlock('---')
        return
      case 'pre': {
        flush()
        const code = element.textContent ?? ''
        const cls = typeof element.className === 'string' ? element.className : ''
        const language = /language-([\w+-]+)/.exec(cls)?.[1] ?? ''
        pushBlock(`\`\`\`${language}\n${code.replace(/\n+$/, '')}\n\`\`\``)
        return
      }
      case 'code': {
        const text = element.textContent ?? ''
        if (text.length > 0 && !text.includes('\n')) buffer += `\`${text}\``
        else buffer += text
        return
      }
      case 'table':
        renderTable(element)
        return
      case 'ul': case 'ol': {
        flush()
        // 纯链接短列表基本就是站内导航/侧边栏/目录：整块丢掉，否则正文会被它淹掉。
        // 判断看"整块文字里链接文字占比"——带嵌套子菜单的导航条也能命中；表格不受影响。
        if (element !== root) {
          const anchors = [...element.querySelectorAll('a')]
          const linkText = anchors.reduce((sum, anchor) => sum + (anchor.innerText ?? '').trim().length, 0)
          const total = textLength(element)
          if (anchors.length >= 6 && total < 1500 && linkText / Math.max(1, total) > 0.8) return
        }
        const ordered = tag === 'ol'
        let index = 1
        for (const item of element.children) {
          if (item.nodeName !== 'LI') continue
          const saved = lines.length
          const savedBuffer = buffer
          buffer = ''
          const sub = []
          for (const child of item.childNodes) {
            if (child.nodeType === 1 && ['UL', 'OL'].includes(child.nodeName)) {
              const nested = []
              for (const nestedItem of child.children) {
                if (nestedItem.nodeName !== 'LI') continue
                nested.push(`    - ${(nestedItem.innerText ?? '').replace(/\s+/g, ' ').trim()}`)
              }
              sub.push(...nested)
              continue
            }
            walk(child, depth + 1)
          }
          const text = buffer.replace(/[ \t]+/g, ' ').trim()
          buffer = savedBuffer
          const marker = ordered ? `${index}.` : '-'
          index += 1
          if (text.length > 0) lines.push(`${marker} ${text}`)
          lines.push(...sub)
          if (lines.length === saved) continue
        }
        lines.push('')
        return
      }
      case 'a': {
        const text = (element.innerText ?? '').replace(/\s+/g, ' ').trim()
        const href = absolute(element.getAttribute('href'))
        if (text.length === 0) {
          for (const child of element.childNodes) walk(child, depth + 1)
          return
        }
        buffer += href.length > 0 ? `[${text}](${href})` : text
        return
      }
      case 'img': {
        const alt = element.getAttribute('alt') ?? ''
        const src = absolute(element.getAttribute('src'))
        if (src.length > 0) buffer += `\n\n![${alt}](${src})\n\n`
        return
      }
      case 'blockquote': {
        flush()
        const inner = (element.innerText ?? '').trim()
        if (inner.length > 0)
          pushBlock(inner.split('\n').map((line) => `> ${line.trim()}`).join('\n'))
        return
      }
      default:
        for (const child of element.childNodes) walk(child, depth + 1)
    }
  }

  walk(root, 0)
  flush()

  const text = lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim()

  return { title: (document.title ?? '').trim(), markdown: text, href: location.href }
}

/** 页内滚动：把懒加载内容顶出来，再回到顶部。 */
function scrollInPage() {
  return new Promise((resolve) => {
    const step = Math.max(400, window.innerHeight * 0.9)
    let position = 0
    let rounds = 0
    const tick = () => {
      const height = document.documentElement.scrollHeight
      window.scrollTo(0, position)
      position += step
      rounds += 1
      if (position < height && rounds < 40) {
        setTimeout(tick, 180)
        return
      }
      window.scrollTo(0, 0)
      setTimeout(resolve, 250)
    }
    tick()
  })
}

/** 一页的渲染结果。 */
export async function renderPage(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 45_000
  const scroll = options.scroll ?? true
  const pool = getBrowser()
  const port = await pool.ensure()
  const deadline = Date.now() + timeoutMs

  const created = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
  if (!created.ok) throw new Error(`无法创建浏览器标签页：HTTP ${created.status}`)
  const target = await created.json()
  const session = await CdpSession.open(target.webSocketDebuggerUrl)
  let loaded = false
  session.on((message) => {
    if (message.method === 'Page.loadEventFired') loaded = true
  })

  try {
    await session.send('Page.enable')
    await session.send('Runtime.enable')
    await session.send('Page.navigate', { url }, 30_000)

    // 等 load 事件，但只给它一部分预算：广告/统计脚本常年不结束，页面本身早已可读。
    const loadDeadline = Math.min(deadline, Date.now() + Math.min(15_000, Math.floor(timeoutMs / 3)))
    while (Date.now() < loadDeadline && !loaded) await sleep(100)

    // 等 DOM 稳定：连续两次长度一致即认为渲染完成。
    let previous = -1
    let stable = 0
    let sawContent = false
    while (Date.now() < deadline) {
      const length = await session
        .evaluate('document.body ? document.body.innerText.length : 0', 10_000)
        .catch(() => -1)
      if (typeof length === 'number' && length > 0) sawContent = true
      if (typeof length === 'number' && length > 0 && length === previous) {
        stable += 1
        if (stable >= 2) break
      } else {
        stable = 0
      }
      previous = typeof length === 'number' ? length : previous
      await sleep(250)
    }
    if (!sawContent) throw new Error('页面没有可读内容（加载超时或空白页）')

    if (scroll && options.scroll !== false) {
      await session.evaluate(`(${scrollInPage.toString()})()`, 40_000).catch(() => undefined)
    }

    const extracted = await session.evaluate(`(${extractInPage.toString()})()`)
    if (extracted === null || typeof extracted !== 'object') throw new Error('页面抽取失败：无返回值')

    const markdown = typeof extracted.markdown === 'string' ? extracted.markdown : ''
    const title = typeof extracted.title === 'string' ? extracted.title : ''
    const href = typeof extracted.href === 'string' ? extracted.href : url
    const status = 200
    return {
      url: href,
      title,
      statusCode: status,
      markdown,
      chars: markdown.length,
      renderedAt: new Date().toISOString(),
    }
  } finally {
    session.close()
    await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => undefined)
  }
}

function cachePath(url) {
  const digest = createHash('sha1').update(url).digest('hex')
  return join(CACHE_DIR, `${digest}.json`)
}

/** 读缓存；`maxAgeMs` 内命中才算。 */
export function readCache(url, maxAgeMs) {
  try {
    const file = cachePath(url)
    if (!existsSync(file)) return undefined
    const stat = statSync(file)
    if (Date.now() - stat.mtimeMs > maxAgeMs) return undefined
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed?.markdown !== 'string') return undefined
    return parsed
  } catch {
    return undefined
  }
}

/** 写缓存，并做一次容量修剪（最多 80 个条目）。 */
export function writeCache(record) {
  ensureDirs()
  try {
    const file = cachePath(record.url)
    writeFileSync(file, JSON.stringify(record), 'utf8')
    const files = readdirSync(CACHE_DIR).filter((name) => name.endsWith('.json'))
    if (files.length <= 80) return
    const stats = files
      .map((name) => ({ name, time: statSync(join(CACHE_DIR, name)).mtimeMs }))
      .sort((left, right) => left.time - right.time)
    for (const stale of stats.slice(0, files.length - 80)) {
      try {
        unlinkSync(join(CACHE_DIR, stale.name))
      } catch {}
    }
  } catch {}
}

/** 渲染优先、缓存兜底：返回整页 markdown 记录。 */
export async function loadPage(url, options = {}) {
  const maxAgeMs = options.maxAgeMs ?? 10 * 60_000
  if (options.refresh !== true) {
    const cached = readCache(url, maxAgeMs)
    if (cached !== undefined) return { ...cached, cached: true }
  }
  const rendered = await renderPage(url, options)
  writeCache(rendered)
  return { ...rendered, cached: false }
}

/** 按字符区间切片。 */
export function sliceText(markdown, offset, maxChars) {
  const total = markdown.length
  const start = Math.max(0, Math.min(Math.floor(offset) || 0, total))
  const end = Math.min(total, start + Math.max(1, Math.floor(maxChars) || 1))
  return {
    slice: markdown.slice(start, end),
    charsStart: start,
    charsReturned: end - start,
    charsTotal: total,
    truncated: end < total,
    nextOffset: end < total ? end : null,
  }
}

/** 标题大纲（markdown 里的 # 行），给超长目录页一个结构视图。 */
export function outlineOf(markdown, limit = 200) {
  const lines = []
  for (const line of markdown.split('\n')) {
    if (/^#{1,4}\s+/.test(line)) lines.push(line.trim())
    if (lines.length >= limit) break
  }
  return lines
}

/** 关键词定位：返回命中处前后文，便于在超长页面里直取一段。 */
export function findInText(markdown, needle, contextChars = 600, limit = 5) {
  if (typeof needle !== 'string' || needle.length === 0) return []
  const hits = []
  const lowerText = markdown.toLowerCase()
  const lowerNeedle = needle.toLowerCase()
  let from = 0
  while (hits.length < limit) {
    const index = lowerText.indexOf(lowerNeedle, from)
    if (index === -1) break
    const start = Math.max(0, index - contextChars)
    const end = Math.min(markdown.length, index + needle.length + contextChars)
    hits.push({ index, charsStart: start, snippet: markdown.slice(start, end) })
    from = index + needle.length
  }
  return hits
}

/** 进程退出时收掉浏览器。 */
export function disposeBrowser() {
  browser?.dispose()
  browser = undefined
}
