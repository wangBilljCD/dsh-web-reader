// dsh-web-reader 宿主插件：给 web_fetch 装上真实浏览器渲染，并提供可分段读完整长页的 web_read 工具。

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  disposeBrowser,
  findBrowser,
  findInText,
  loadPage,
  LOG_DIR,
  outlineOf,
  sliceText,
} from './lib/reader.mjs'

export const name = 'dsh-web-reader'
export const inject = ['web']

// 诊断日志：写到插件自己的数据目录（跟随 DSH_HOME，跨平台自适应），出错就算了，绝不能影响插件本体。
async function logEvent(ctx, event, detail) {
  try {
    const { appendFile, mkdir } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const file = join(LOG_DIR, 'web-reader-events.log')
    await mkdir(LOG_DIR, { recursive: true })
    await appendFile(file, `${new Date().toISOString()} ${event} ${detail === undefined ? '' : JSON.stringify(detail)}\n`)
  } catch {
    // 忽略诊断日志失败
  }
}

const DEFAULT_MAX_CHARS = 12_000
const HARD_MAX_CHARS = 50_000

export const Config = z.object({
  /** 单次读取默认返回的字符数。 */
  maxChars: z.number().default(DEFAULT_MAX_CHARS),
  /** 页面渲染结果在磁盘缓存里保留多久（毫秒）；web_read 的 refresh 可绕过。 */
  cacheTtlMs: z.number().default(10 * 60_000),
  /** 单页渲染总预算（毫秒）。 */
  timeoutMs: z.number().default(45_000),
  /** 是否在抽取前滚动页面，触发懒加载/虚拟列表。 */
  scroll: z.boolean().default(true),
  /** 浏览器可执行文件路径；留空则自动探测 Chrome/Edge。 */
  chromePath: z.string().default(''),
})

/** 把配置里的数字钳到合理区间。 */
function clampNumber(value, fallback, min, max) {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, Math.floor(numeric)))
}

function resolveConfig(config) {
  if (typeof config?.chromePath === 'string' && config.chromePath.trim().length > 0) {
    process.env.DSH_CHROME_PATH = config.chromePath.trim()
  }
  return {
    maxChars: clampNumber(config?.maxChars, DEFAULT_MAX_CHARS, 500, HARD_MAX_CHARS),
    cacheTtlMs: clampNumber(config?.cacheTtlMs, 10 * 60_000, 0, 24 * 60 * 60_000),
    timeoutMs: clampNumber(config?.timeoutMs, 45_000, 5_000, 180_000),
    scroll: config?.scroll !== false,
  }
}

/** 渲染并返回整页 markdown（带缓存）。 */
async function load(url, settings, options = {}) {
  if (typeof url !== 'string' || url.trim().length === 0) throw new Error('url 必须是非空字符串')
  const parsed = new URL(url.trim())
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('只支持 http(s) URL')
  return await loadPage(parsed.href, {
    cacheTtlMs: settings.cacheTtlMs,
    maxAgeMs: settings.cacheTtlMs,
    refresh: options.refresh === true,
    scroll: settings.scroll && options.scroll !== false,
    timeoutMs: settings.timeoutMs,
  })
}

export function apply(ctx, config) {
  const settings = resolveConfig(config)

  // 1) 接管 web_fetch 的抓取层：真实浏览器渲染，后续页面（SPA/懒加载）都能拿到正文。
  const provider = {
    id: 'chrome',
    available() {
      return findBrowser() !== undefined
    },
    async fetch(request) {
      const page = await load(request.url, settings)
      const content = page.markdown
      return {
        url: page.url,
        statusCode: page.statusCode,
        body: { kind: 'text', content },
        truncated: content.length > 180_000,
      }
    },
  }
  ctx.effect(() => {
    const dispose = ctx.web.registerFetchProvider(provider)
    return () => {
      if (typeof dispose === 'function') dispose()
      else ctx.web.unregisterFetchProvider?.(provider.id)
      disposeBrowser()
    }
  })

  // 1b) 把 web 的抓取层指到本插件的 provider。
  // 只覆盖"没人选/出厂默认 http/被 free-search 质量链接管成 fs-quality-fetch"这三种情况，
  // 用户显式选了别的 provider 时不抢。rc.2 起 provider 选择是 config 的 volatile ref，只能走 settings.mutate 写。
  ctx.inject(['settings'], (sctx) => {
    const ref = ctx.web.config?.fetchProvider
    const current = ref !== null && ref !== undefined && typeof ref.get === 'function' ? ref.get() : ctx.web.fetchProviderId
    void logEvent(ctx, 'apply-1b', {
      hasConfig: ctx.web.config !== undefined && ctx.web.config !== null,
      refKind: ref === null || ref === undefined ? String(ref) : typeof ref,
      current: current === undefined ? 'undefined' : current,
      env: process.env.DSH_WEB_FETCH_PROVIDER ?? null,
    })
    if (current === provider.id) return
    const overridable = current === undefined || current === null || current === '' || current === 'http' || current === 'fs-quality-fetch'
    if (!overridable) return
    const write = async () => {
      try {
        await sctx.settings.mutate('web', [{ op: 'set', path: ['fetchProvider'], value: provider.id }])
        await logEvent(ctx, 'mutate-ok-web', { value: provider.id })
      } catch (error) {
        await logEvent(ctx, 'mutate-fail-web', { message: error?.message ?? String(error) })
        try {
          await sctx.settings.mutate('include:web', [{ op: 'set', path: ['fetchProvider'], value: provider.id }])
          await logEvent(ctx, 'mutate-ok-include', { value: provider.id })
        } catch (inner) {
          await logEvent(ctx, 'mutate-fail-include', { message: inner?.message ?? String(inner) })
        }
      }
    }
    if (ref !== null && ref !== undefined && typeof ref.get === 'function') {
      void write()
      return
    }
    ctx.web.fetchProviderId = provider.id
  })

  // 2) 长页分段工具：整页落盘缓存，按 offset 连续读，支持关键词直取与大纲。
  ctx.inject(['tools', 'systemPrompt'], (sctx) => {
    sctx.systemPrompt.section({
      name: 'tool:web_read',
      order: sctx.systemPrompt.getSectionOrder('TOOL_WEB_FETCH') + 1,
      text: ({ scope }) => sctx.tools.get('web_read', scope) === undefined
        ? ''
        : 'web_fetch 由本机 Chrome 真实渲染（执行 JavaScript、懒加载滚动）。单次最多返回约 20 万字符：'
          + '页面更长、或要先看目录再定位时用 web_read——offset 续读全页、find 直取关键词、outline 看大纲；'
          + '同一 URL 十分钟内命中磁盘缓存，无需重复抓取。',
    })
    sctx.tools.register(defineTool({
      name: 'web_read',
      description:
        '用本机 Chrome 真实渲染一个网页（执行 JavaScript、滚动触发懒加载）后读取正文，支持超长页面分段完整读取：'
        + '返回 charsTotal 与 nextOffset，用 offset 继续读下一段即可拿到全文；'
        + '也可以用 find 直接定位某个关键词附近的内容，或用 outline=true 先看目录。'
        + 'web_fetch 单次上限约 10 万~20 万字符，超过时用本工具分段读。',
      parameters: {
        url: { type: 'string', required: true, description: '要读取的 http(s) 地址。' },
        offset: { type: 'number', description: '从整页正文的第几个字符开始返回，默认 0；用上次的 nextOffset 续读。' },
        maxChars: { type: 'number', description: `本次最多返回多少字符，默认 ${DEFAULT_MAX_CHARS}，上限 ${HARD_MAX_CHARS}。` },
        find: { type: 'string', description: '关键词或句子；返回命中处前后文，适合在超长页面里直取一段。' },
        outline: { type: 'boolean', description: 'true 时额外返回标题大纲（markdown 的 # 行），适合目录很长的页面。' },
        refresh: { type: 'boolean', description: 'true 时忽略缓存重新渲染。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            url: { type: 'string' },
            title: { type: 'string' },
            charsTotal: { type: 'number' },
            charsStart: { type: 'number' },
            charsReturned: { type: 'number' },
            truncated: { type: 'boolean' },
            nextOffset: { type: 'number' },
            cached: { type: 'boolean' },
            text: { type: 'string' },
            outline: { type: 'array', items: { type: 'string' } },
            matches: { type: 'array', items: { type: 'string' } },
          },
        },
        render(args, value) {
          const header = [
            `# ${value.title || value.url}`,
            `URL: ${value.url}`,
            `共 ${value.charsTotal} 字符，本次返回第 ${value.charsStart}–${value.charsStart + value.charsReturned} 字符`
              + (Array.isArray(value.matches) && value.matches.length > 0
                ? '（关键词定位）'
                : value.nextOffset === undefined ? '（已到结尾）' : `；续读用 offset=${value.nextOffset}`)
              + (value.cached ? ' · 缓存命中' : ''),
          ].join('\n')
          const parts = [header]
          if (Array.isArray(value.outline) && value.outline.length > 0) {
            parts.push(`## 大纲\n${value.outline.join('\n')}`)
          }
          if (Array.isArray(value.matches) && value.matches.length > 0) {
            parts.push(`## 关键词命中\n${value.matches.join('\n\n---\n\n')}`)
          }
          if (typeof value.text === 'string' && value.text.length > 0) parts.push(`## 正文\n${value.text}`)
          return [{ type: 'text', text: parts.join('\n\n') }]
        },
      },
      timeoutMs: settings.timeoutMs + 15_000,
      isConcurrencySafe: () => false,
      async execute(args) {
        const page = await load(args.url, settings, { refresh: args.refresh === true })
        const markdown = page.markdown
        const total = markdown.length
        let slice
        let matches
        if (typeof args.find === 'string' && args.find.trim().length > 0) {
          const hits = findInText(markdown, args.find.trim(), Math.min(1_200, settings.maxChars), 5)
          matches = hits.map((hit) => `@${hit.charsStart}\n${hit.snippet}`)
          // find 模式下正文只在 matches 里给（每段带位置），不要再重复贴第一段。
          slice = {
            slice: '',
            charsStart: hits[0]?.charsStart ?? 0,
            charsReturned: hits[0]?.snippet.length ?? 0,
            charsTotal: total,
            truncated: total > (hits[0]?.snippet.length ?? 0),
            nextOffset: null,
          }
          if (matches.length === 0) matches = [`未找到「${args.find}」`]
        } else {
          const maxChars = clampNumber(args.maxChars, settings.maxChars, 500, HARD_MAX_CHARS)
          slice = sliceText(markdown, args.offset ?? 0, maxChars)
        }
        const outline = args.outline === true ? outlineOf(markdown, 200) : undefined
        return {
          url: page.url,
          title: page.title,
          charsTotal: total,
          charsStart: slice.charsStart,
          charsReturned: slice.charsReturned,
          truncated: slice.truncated,
          ...(slice.nextOffset === null ? {} : { nextOffset: slice.nextOffset }),
          cached: page.cached === true,
          text: slice.slice,
          ...(outline === undefined ? {} : { outline }),
          ...(matches === undefined ? {} : { matches }),
        }
      },
    }))
  })
}
