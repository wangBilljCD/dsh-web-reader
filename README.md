# dsh-web-reader

Read JavaScript-rendered web pages completely in DeepSeek Harness (DSH). [中文版](README_ZH.md)

## Why

DSH's default `web_fetch` uses a direct HTTP fetch layer. For pages whose content is rendered by JavaScript (SPA, docs sites, lazy-loaded lists) the direct layer only sees the empty HTML shell, and long pages get truncated. This plugin:

- Registers a `chrome` fetch provider that renders pages with the **locally installed Chrome/Edge** via CDP (real JavaScript execution, scroll-triggered lazy loading), and takes over `web_fetch`.
- Adds a `web_read` tool that renders once, caches the full page to disk, and returns it **in slices** (`offset` / `maxChars`), with keyword lookup (`find`) and heading outline (`outline`) — so pages of any length can be read completely.

No third-party runtime dependencies: CDP uses Node's built-in `WebSocket`, and the browser is your own installed Chrome/Edge.

## Install

From your DSH profile directory:

```
dsh plugin add git+https://github.com/wangBilljCD/dsh-web-reader.git
```

Or add the repository as a plugin source in the GUI: **Settings → Plugins → Add source** and paste the repository URL.

Then enable the `dsh-web-reader` bundle in the plugin manager (host plugin). A profile restart may be required for the bundle layer to load.

## Usage

Once enabled, `web_fetch` is backed by real browser rendering. For long pages use the new tool:

| Parameter | Meaning |
| --- | --- |
| `url` | http(s) URL to render (required) |
| `offset` | character offset to start from; continue with the returned `nextOffset` |
| `maxChars` | max characters this call (default 12000, cap 50000) |
| `find` | keyword to locate directly with surrounding context |
| `outline` | `true` to return the heading outline first |
| `refresh` | `true` to bypass the disk cache and re-render |

Typical flow: `outline=true` → see the table of contents → `find` or `offset` to read the section you need. Repeated calls within the cache TTL hit the disk cache, no re-render.

## Configuration

| Setting | Default | Meaning |
| --- | --- | --- |
| `maxChars` | 12000 | default slice size |
| `cacheTtlMs` | 600000 | cache lifetime (10 min) |
| `timeoutMs` | 45000 | per-page render budget |
| `scroll` | true | scroll to trigger lazy loading before extraction |
| `chromePath` | "" | explicit Chrome/Edge path; leave empty to auto-detect |

Environment variables:

- `DSH_CHROME_PATH` — browser executable path (highest priority).
- `DSH_WEB_READER_CACHE_DIR` — cache directory.
- `DSH_WEB_READER_LOG_DIR` — diagnostic log directory.

By default the cache/log live under `$DSH_HOME/cache/web-reader`; DSH sessions always set `DSH_HOME`, so nothing is written outside the DSH data directory. If `DSH_HOME` is absent, the system temp directory is used.

## Requirements

- Node.js 20+ (built-in `WebSocket` / `fetch`)
- Google Chrome or Microsoft Edge installed locally (auto-detected on Windows/macOS/Linux)
- DSH 0.1.x

## License

MIT
