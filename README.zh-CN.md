# Open Browser Use

[![English](https://img.shields.io/badge/English-Click-yellow)](./README.md)
[![简体中文](https://img.shields.io/badge/简体中文-点击查看-orange)](./README.zh-CN.md)
[![Release](https://img.shields.io/github/v/release/iFurySt/open-browser-use)](https://github.com/iFurySt/open-browser-use/releases)
[![npm SDK](https://img.shields.io/npm/v/open-browser-use-sdk?label=npm%20SDK)](https://www.npmjs.com/package/open-browser-use-sdk)
[![PyPI SDK](https://img.shields.io/pypi/v/open-browser-use-sdk?label=PyPI%20SDK)](https://pypi.org/project/open-browser-use-sdk/)
[![Go SDK](https://pkg.go.dev/badge/github.com/ifuryst/open-browser-use/packages/open-browser-use-go.svg)](https://pkg.go.dev/github.com/ifuryst/open-browser-use/packages/open-browser-use-go)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/iFurySt/open-browser-use)

---

> [!TIP]
> 对 Computer Use 感兴趣的话，可以看看 [open-computer-use](https://github.com/iFurySt/open-codex-computer-use)。

`open-browser-use` 是平台中立的浏览器操作方案，也是Codex.app最新发布的Chrome Browser Use的开源替代方案。背后的故事可以看这篇[Browser Use详解](https://www.ifuryst.com/blog/2026/open-browser-use/)文章。 技术方案采用的是浏览器插件和open-browser-use cli结合，可通过 JS/Python/Go SDK 或 CLI 的方式接入。

https://github.com/user-attachments/assets/bcfba878-f6a8-44b9-b84b-29c7e0285687

## Quick Start
第一次安装可以无脑运行：
```bash
npm i -g open-browser-use
open-browser-use setup
```

### 安装 CLI
```bash
# npm安装（macOS、Linux、Windows）
npm i -g open-browser-use

# Homebrew安装（macOS、Linux）
brew tap iFurySt/open-browser-use && brew install open-browser-use

# 升级
npm update -g open-browser-use
```

### 配置 Chrome
注册绑定到该插件的 native host。setup 也会打开 Chrome Web Store 页面，你需要在
页面里安装或启用对应的浏览器插件，必要时再重启 Chrome。

```bash
open-browser-use setup
```

如果 Chrome Web Store 暂时不可用，可以运行 `open-browser-use setup beta`
准备带固定 key 的 release ZIP，再到 `chrome://extensions/` 手动安装。

如果本地已经有扩展 ZIP，可以直接把路径传给 setup。该方式不会从 GitHub Release
下载插件包，仍会准备带固定 key 的手动安装包：

```bash
open-browser-use setup --zip /absolute/path/to/open-browser-use-chrome-extension.zip
```

### 使用

#### SDK

```bash
# JavaScript / TypeScript
npm install open-browser-use-sdk

# Python
pip install open-browser-use-sdk

# Go
go get github.com/ifuryst/open-browser-use/packages/open-browser-use-go
```

SDK 在 npm 和 PyPI 上统一叫 `open-browser-use-sdk`。Python 代码里的 import
模块名保持 `open_browser_use`；Go 代码通常把 SDK import 为 `obu`。

#### Skill

一键安装 skill：

```bash
# 安装到codex
npx skills add iFurySt/open-browser-use -g -a codex --skill open-browser-use -y
npx skills ls -g -a codex | rg 'open-browser-use'
codex exec --skip-git-repo-check "用open-browser-use查看下今天Hacker News有什么值得关注的"

# 安装到claude code
npx skills add iFurySt/open-browser-use -g -a claude-code --skill open-browser-use -y
```

更新已有的全局安装，包括上面安装到 Codex 的那份：

```bash
npx skills update open-browser-use -g -y

# `upgrade` 是 `update` 的别名
npx skills upgrade open-browser-use -g -y
```

也可以手动下载`open-browser-use`的[skill](./skills/open-browser-use)并安装，就可以愉快的开始使用了🚀

*[GitHub Releases](https://github.com/iFurySt/open-browser-use/releases)里有可下载的.skill/.zip包*

#### MCP

一键安装 MCP server 到所有支持的全局 Agent 配置：

```bash
npx add-mcp "obu mcp" --name open_browser_use --all -g -y
npx add-mcp list -g
```

也可以手动配置到支持本地 stdio MCP 的 Agent runtime：

```toml
[mcp_servers.open_browser_use]
command = "obu"
args = ["mcp"]
```

这个 MCP server 会暴露标签页列表、打开/接管标签页、导航、CDP、action plan
和清理等浏览器工具。

## 本地开发版

本分支新增 Playwright 操作引擎、后台页面反馈和 Windows named-pipe 通信，
尚未发布到上面的安装渠道。先构建匹配的本地产物：

```sh
pnpm install --frozen-lockfile
pnpm build:chrome-extension
go build -o dist/ ./cmd/open-browser-use
```

在扩展管理页面加载 `dist/chrome-extension-unpacked/`。源码目录缺少生成的
引擎依赖，不能直接加载。开发版要求 Chromium 125 或更新版本；这是 API 下限，
实际测试过的浏览器与未完成项见[能力矩阵](docs/product-specs/browser-use-parity.md)。
`scripts/package-chrome-extension.sh` 将相同构建产物打包成 ZIP。

使用 `dist/` 中新构建的 CLI 和本仓库内的 SDK；公开发行包不包含这些本地改动。
需要读取网页原始 POST/Blob 下载时，开发分支提供可选的
[原生浏览器绑定](docs/references/original-page-download-delivery.md)。它要求明确
授权的 Browser 连接；普通扩展安装和已发布预览包不会自动启用。
开发版支持显式 URL 或[选择 Chrome/Edge 后发现端口](docs/references/current-session-connection.md)，
启用调试和浏览器授权仍由用户完成。
按实际加载的扩展 ID 注册这个 CLI 作为 native host，Windows Edge 的命令见
[本地注册说明](docs/references/edge-installation.md)。

开发分支另有实验性 Windows `managed run/status/view/stop` 入口，使用独立的
Headless Chromium profile。先运行一次 `managed browser install` 下载固定的
推荐浏览器，再执行 `managed run --name work`；Windows 完整包会提供程序旁的
扩展。启动仅离线检查缓存，也支持自行指定浏览器。查看页提供实时画面、暂停、
继续、停止和限定范围的人工接管；可选 `managed setup` 用于任务前在专用窗口
登录。完整登录/输入法与重启恢复仍待完善。普通安装不需要启用此模式。
命令、CLI/MCP 接入和验收边界见
[独立浏览器会话](docs/references/managed-browser-session.md)。

扩展工具栏弹窗中的 **Pause all agents** 可暂停所有 Agent；清理失败时保持
阻断，点击 **Retry pause** 重试。**Resume control** 只允许 Agent 开始新轮次，
不会重放旧任务。暂停保留页面，无法撤销已发生的页面操作。
截图超时后，仍会等待已发出的原生截图完成再释放渲染队列；未完成时暂停
保持阻断。具体范围见[截图完成契约](docs/references/screenshot-completion.md)。

输入空闲时，普通定位器悬停会确认原目标实际收到移动后才报告成功，允许悬停
打开菜单或改变目标。force/trial 与已持有输入沿用原行为；具体范围见
[悬停投递契约](docs/references/hover-delivery.md)。
文本 fill 同时确认原生命令完成和原编辑宿主收到可信输入；页面取消或未送达
会明确报错，正常页面格式化仍有效。见[填入文本契约](docs/references/fill-delivery.md)。
组合键会在输入前完整校验；按键执行中途失败时，先清理原附件的输入状态再
允许后续操作。见[组合键契约](docs/references/keyboard-chords.md)。

JS、Python、Go SDK 提供语义定位与自动等待，CLI/MCP 共用
[浏览器动作协议](docs/references/browser-action-protocol.md)。
`make ci` 包含平台检查和 SDK 到真实 Go host 的通信回归，
[浏览器验收套件](scripts/browser-integration/README.md)检查真实页面操作与前台标签页保持。

## License

[MIT](./LICENSE)。打包的 Playwright CRX/Playwright 组件保留 Apache-2.0 许可证，
构建产物包含其 LICENSE 和 NOTICE。
