# dsh-web-reader

在 DeepSeek Harness（DSH）里完整读取由 JavaScript 渲染的网页。[English](README.md)

## 为什么需要它

DSH 默认的 `web_fetch` 走直连抓取层。对于内容靠 JavaScript 渲染的页面（SPA、文档站、懒加载列表），直连层只能拿到空 HTML 外壳；长页面还会被截断。本插件：

- 注册一个 `chrome` 抓取 provider，用**本机已安装的 Chrome/Edge** 通过 CDP 真实渲染页面（执行 JavaScript、滚动触发懒加载），并接管 `web_fetch`。
- 新增 `web_read` 工具：渲染一次、整页落盘缓存，然后按字符**分段返回**（`offset` / `maxChars`），支持关键词定位（`find`）与标题大纲（`outline`）——再长的页面也能读全。

零第三方运行时依赖：CDP 走 Node 内置 `WebSocket`，浏览器用你自己装的 Chrome/Edge。

## 安装

在 DSH 的 profile 目录下执行：

```
dsh plugin add git+https://github.com/wangBilljCD/dsh-web-reader.git
```

或在界面里把仓库地址添加为插件源：**设置 → 插件 → 添加源**，粘贴仓库 URL。

然后在插件管理器里启用 `dsh-web-reader` bundle（宿主插件）。bundle 层可能需要重启 profile 才会加载。

## 用法

启用后 `web_fetch` 即由真实浏览器渲染支撑。长页面用新工具：

| 参数 | 含义 |
| --- | --- |
| `url` | 要渲染的 http(s) 地址（必填） |
| `offset` | 从第几个字符开始；配合返回的 `nextOffset` 续读 |
| `maxChars` | 本次最多返回字符数（默认 12000，上限 50000） |
| `find` | 关键词定位，返回命中处前后文 |
| `outline` | `true` 先返回标题大纲 |
| `refresh` | `true` 忽略缓存重新渲染 |

典型流程：`outline=true` 看目录 → `find` 或 `offset` 读需要的章节。缓存有效期内的重复调用命中磁盘缓存，不重复渲染。

## 配置

| 设置 | 默认值 | 含义 |
| --- | --- | --- |
| `maxChars` | 12000 | 默认分段大小 |
| `cacheTtlMs` | 600000 | 缓存有效期（10 分钟） |
| `timeoutMs` | 45000 | 单页渲染预算 |
| `scroll` | true | 抽取前滚动触发懒加载 |
| `chromePath` | "" | 显式指定浏览器路径；留空自动探测 |

环境变量：

- `DSH_CHROME_PATH` — 浏览器可执行文件路径（优先级最高）。
- `DSH_WEB_READER_CACHE_DIR` — 缓存目录。
- `DSH_WEB_READER_LOG_DIR` — 诊断日志目录。

缓存与日志默认落在 `$DSH_HOME/cache/web-reader`；DSH 会话一定会设置 `DSH_HOME`，因此不会写到 DSH 数据目录之外。若没有 `DSH_HOME`，才回退到系统临时目录。

## 依赖

- Node.js 20+（内置 `WebSocket` / `fetch`）
- 本机安装 Google Chrome 或 Microsoft Edge（Windows/macOS/Linux 自动探测）
- DSH 0.1.x

## 许可证

MIT
