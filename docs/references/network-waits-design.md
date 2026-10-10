# 网络事件等待：两阶段 API 设计（尚未实现）

状态：**设计提案，尚未实现，也不是当前可调用的公开 API**。本次审计基于
`8181d12`；下文所有新 RPC、SDK 方法、capability、错误码和资源限额均为建议契约，
需在实现、跨语言测试和真实浏览器验收后才能列为已支持能力。

## 问题与范围

当前 `browserAction diagnostics` 可读取真实 Playwright Page 的网络事件摘要，
但没有公开的 `waitForRequest` / `waitForResponse`。直接把长等待加进同 tab 的
`browserAction` 队列，会阻塞本应触发网络请求的后续 click。只让调用者同时发两个
RPC 也不能解决冷引擎 attach、监听器注册和动作执行之间的竞态。

首片只实现 request / response 两类事件的有限匹配。URL、popup、download 等将来
可以参考同样的 ready ACK 模式，但本片不引入通用事件框架，不修改现有文件选择器、
下载或 URL 等待语义，也不提供任意 JavaScript predicate、响应体或请求头读取。

## 当前代码依据

| 路径 | 相关约束或可复用部分 |
| --- | --- |
| `apps/chrome-extension/browser-action-engine.js` | `dispatch` 使用每 tab 的队列；`attach`、generation、`detach` / `forget` 和授权 hooks 决定 Page 生命周期。长等待不能占住该队列。 |
| `apps/chrome-extension/browser-diagnostics.js` | 真实 Page request / response 监听、请求 ID 和 redirect 关联、有限元数据序列化可参考；不能用其截断后的 URL 做匹配或扫描旧 ring 命中事件。 |
| `apps/chrome-extension/background.js` | 公开 RPC allowlist、`runControlledRequest`、session/epoch 校验、`transferScope` / `validateTransferScope`、attachment token、Pause 和结束清理。文件选择器已有短 setup ACK barrier，但网络等待需要正式公开 ready ACK。 |
| `packages/open-browser-use-js/src/index.ts` | 异步 pending response map 支持并发；`controlScopeSymbol` 和 deadline clamp 可承载固定绑定。并发本身不等于监听已经 ready。 |
| `packages/open-browser-use-python/open_browser_use/client.py` | 同步响应读取器，没有支持并发 RPC 的后台 reader 或请求互斥协议；并发读可能收到其他 request ID 并关闭连接。应使用顺序 arm → action → collect。 |
| `packages/open-browser-use-go/client.go`、`control.go` | `requestLock` 覆盖一次完整 RPC；`requestInScope` 可取得固定控制元数据。应在释放 arm 的调用锁后触发动作。 |
| `cmd/open-browser-use/control.go`、`mcp.go` | CLI control gate 和 MCP 主消费循环串行处理；顺序的通用 `call` 可以执行三阶段，不必先重写并发模型。 |
| `internal/host/relay.go` | 按 request ID 转发一般 RPC，按 session 路由已有通知；新协议不需要 host 中转层保存 waiter 或增加通知类型。 |
| `scripts/browser-integration/diagnostics-fixture.mjs`、`run.mjs` | 已有 main / OOPIF 请求、重定向、网络失败 fixture 和真实 SDK → pipe → host → extension 验收链路。 |

实现需同步 [browser action 协议](browser-action-protocol.md)、各 SDK 文档及公开
capability；本文件的设计状态不能替代这些交付证明。

## 最小 wire API

建议使用独立 RPC，而非把长等待塞入 `browserAction`：

| RPC | 参数（均另含标准控制元数据） | 结果与边界 |
| --- | --- | --- |
| `armNetworkWait` | `tabId`, `event: "request" \| "response"`, `match`, `timeoutMs?` | 完成授权、冷 Page attach 和监听注册之后返回 `{waiterId, remainingMs}`。这是 ready ACK。 |
| `collectNetworkWait` | `tabId`, `waiterId` | 返回已保存的匹配元数据；仍 pending 则只等到该 waiter 的原始 deadline。不能续期。 |
| `cancelNetworkWait` | `tabId`, `waiterId` | 取消并释放记录、监听与定时器；不改变页面，不重放动作。 |

标准控制元数据是 `session_id`、`turn_id`、`control_epoch`。通过
`getInfo.metadata.networkWaitVersion = 1` 协商支持；旧 extension 无该 capability
时应明确不支持，不能退化成读取 diagnostics 历史或伪 ready。

`match` 第一版限定为非空 `url`、`urlMatch: "exact" | "contains"`（默认 exact）、
可选 `method`，以及仅 response 接受的可选 `status`。拒绝未知字段、无效枚举和
任意 predicate / regex。字符串设明确字节上限，并在分配 waiter 前验证；建议 URL
4096 字节、method 128 字节。匹配针对真实事件上的完整值，不能对截断后的展示文本
判断命中。方法按明确的字符串规则匹配，不隐式修改用户条件。

返回值为有限元数据对象：event、requestId、url、method、resourceType、frameUrl、
可选 redirectedFrom；response 另有 status。与 diagnostics 统一字段含义及字节截断
规则，不包含 headers、cookies、postData 或 body。requestId 只在原始 attachment
生命周期内关联，不是跨 Page 或 worker 重启的全局请求标识。

response 表示收到状态与响应头，不表示 body 已下载完成。HTTP 404 / 503 仍可触发
response；网络连接失败可能只有 requestfailed，随后 response waiter 超时。redirect
产生新的 Request，可用 redirectedFrom 关联。依据：
[Playwright Request 生命周期](https://playwright.dev/docs/api/class-request)。

## SDK 与顺序调用

建议将高层方法命名为 `expectRequest` / `expectResponse`，返回含 `result()` 和
`cancel()` 的固定绑定 handle，避免把 ready ACK 误认成最终网络事件：

```js
// 设计示例；当前 SDK 尚未提供这些方法。
const pending = await tab.expectResponse({
  url: `${base}/api/save`, method: "POST", status: 200
}, { timeoutMs: 5000 });
await tab.getByRole("button", { name: "Save" }).click();
const response = await pending.result();
```

Python、Go、CLI 和 MCP 同样先 arm，再触发，再 collect，不需要调用者启动线程。
collect 在 pending 时仍可能占用客户端的串行 RPC 通道，因此不能先 collect 再依靠
同一通道提交触发动作。第一版 CLI / MCP 用通用 `call` 即可，不必同时新增便捷命令。

handle 必须保存 **arm 调用实际提交时**的 session、turn、epoch，不能在 arm 返回后
读取 client 的最新状态：并发的 end 可能已推进 epoch。实现可复用固定 scope 的内部
request preparation；同一 handle 的 collect / cancel 始终发送原元数据。beginTurn
不会让旧 handle 复活，也不能在 stale 错误后静默刷新、重新 arm 或重放 click。

触发动作失败时可以 best-effort cancel，但取消错误不能覆盖原动作错误。用户没有
调用 cancel 或 arm ACK 在网络中丢失时，backend 仍必须按原 deadline 和终态 TTL
自行回收。不要依赖 SDK finalizer 才能回收资源。

## Ready、队列与事件顺序

1. backend 同步验证参数、预留容量、记录请求进入时刻和原始 deadline，然后开始
   admission / controlReady / ownership / engine attach。所有前置等待共用该预算。
2. arm 仅在短初始化与注册阶段进入同 tab 队列，复用触发 click 的同一个 CRX Page
   attachment。不能先 raw attach 监听，再在 click 时迁移 attachment 并丢掉监听。
3. listener 已安装且 scope 仍有效才返回 ready ACK；队列此时释放。监听存续和
   collect 均不占该动作队列。若事件先于 ACK 到达，保存终态供随后 collect 读取。
4. 只观察注册之后送达的事件，不扫描 diagnostics ring 或旧缓存。注册前已经结束
   的 response 不能命中；请求在注册前开始、response 在注册后到达则可以命中，
   因为该 API 按所选事件的发生时刻定义，而非按请求发起时刻定义。
5. 第一条匹配事件同步选定，再执行必要的异步归属复核，不能让较慢的复核改变事件
   顺序。若该候选事件失去归属，取消 waiter，不能偷偷继续等待下一条事件。

## Deadline 与终态

`timeoutMs` 默认 10000，整数范围 1..120000；表示从 arm 调用提交起到匹配事件的
总操作预算。discovery、协商、连接、客户端排队、controlReady、attach、backend
队列和监听等待都消耗它。客户端保留现有 1 秒响应余量，最终 wire 发送前扣除已耗
预算；不足 1ms 操作预算时不发 arm。默认 client 的 10 秒不能把显式 100ms 拉长。

backend 尤其要在 `runControlledRequest` 等待 `controlReady` **之前**捕获进入时刻，
不能在 handler 真正开始时重新计算一个完整 timeout。每次 await 后检查原 deadline、
generation 和 scope；超时后迟到的 attach 只清理自己的 attachment，不能注册监听、
发出伪 ready 或 detach 新 owner。不能因为 collect 后到就重置网络 deadline。

状态机为 pending → matched / timed-out / cancelled / failed，单向且只提交一次。
deadline 前匹配的结果，允许在 deadline 后的保留期内读取；不能把“稍晚来取结果”
误报为网络超时。collect 的读取传输可使用有限的独立 RPC 预算，但它不延长 waiter
网络预算。仍 pending 的 collect 最多等到原 deadline 加传输余量。

建议 matched、timed-out 和 failed 终态保留 30 秒，以便重复 collect 幂等读取同一
结果或错误；保留期从终态提交开始。过期或已显式 cancel 的 handle 返回统一
`OBU_NETWORK_WAIT_EXPIRED`，不暴露是否属于其他 session。Pause/end/归属失效可以
立即删除旧终态，不能为了幂等性让旧 owner 继续读取。取消不存在的记录可在调用者
scope 验证成功后幂等返回，不能绕过全局 Pause 或 epoch 检查。

## 控制权与资源上限

记录绑定精确的 `{session_id, turn_id, control_epoch, tabId, attachmentToken}`。
在 arm ready、事件提交及结果返回前均复核原 owner、tab group、epoch 和 attachment
identity。Session ID 是路由标签，不是认证凭据；waiterId 也不是越权读取令牌。

Pause、end、finalize、tab close、detach、owner/group 换代以及 worker 重启都使原
waiter 失效，释放 listener 和 timer，唤醒 pending collect。新 owner 不继承旧记录。
没有持久化 waiter，也不跨 worker restart 自动恢复网络等待。

建议每 tab 最多 16 个、每 session 最多 32 个、全局最多 128 个，**包括 pending
和保留中的终态**；每份结果最多 16 KiB。容量不足时以明确的
`OBU_NETWORK_WAIT_LIMIT` 拒绝新 arm，不驱逐仍有效的 waiter。预留应在首次 await
之前完成，失败路径归还容量；终态取消监听，仅保留有限元数据。全局 Pause 快照与
清理要包含 pending arming、waiter 和 collect，不能只扫描已 ready 的记录。

## 最小实现拆分

- extension 新增独立 network wait registry，负责有限匹配、单次结算、scope、TTL
  和限额。engine 暴露短 arm 注册入口及 Page 生命周期清理 hooks；backend 暴露
  上述三个 allowlist RPC，并把资源纳入结束与暂停清理。首片不建立通用 waiter 框架。
- 三 SDK 新增 typed match/result/handle，复用固定 scope；仅 arm 加入现有“操作
  timeout + 1 秒余量”分类。collect/cancel 是读取或清理原 waiter，不能套用会重新
  启动网络预算的分类。通用 raw request 也要遵守 arm 的提交 deadline。
- CLI `control.go` 对 arm 做提交时与最终 wire 的同样预算收紧；MCP 复用最早
  captured submission 时间。同步客户端和 MCP 的顺序调用方式须明确写进文档。
- host、IPC framing、endpoint discovery 不需要修改。避免为了等待事件重写三种
  客户端的并发 reader 或引入新的跨 session 通知。

## 正式验收（全部待实施）

可复用 `scripts/browser-integration/diagnostics-fixture.mjs` 的 main / OOPIF 和
`run.mjs` 的 data / redirect / fail 路由，再加入带 server 计数的 POST、延迟 response
及先发 headers 后延迟 body 的路由。经正式 SDK / CLI / MCP 走实际 host 和生产
extension 的 Page 事件；测试代码不能用 CDP 伪造网络事件或先偷偷暖引擎。

| 场景 | 必须观察到的结果 |
| --- | --- |
| 冷引擎 arm → 立即 click → collect | ready 前已安装监听；无同 tab 队列死锁，主 frame 和 OOPIF 都返回实际请求元数据，server 只收到一次触发。 |
| 事件早于 collect / ACK | 结果保留；重复 collect 在 TTL 内返回同一结果，不再次触发网络。 |
| 旧事件及精确条件 | 注册前完成的请求不命中；method/status/URL 条件生效；contains 与 exact 有明确不同；未知字段被拒绝。 |
| response 语义 | headers 到达即可完成，不等延迟 body；404/503 匹配；redirect IDs 可关联；网络断开不伪造 response。 |
| 短 deadline | 显式 100ms、前置协商或 attach 延迟 250ms 时无新监听/ready；排队消耗原预算；迟到 setup 不污染下一 owner。 |
| 两 session 同 URL | 各自只得到自己 tab 的事件；交换 waiterId 或换 session/epoch 不能读对方结果。 |
| 结束与暂停 | pending arm / collect 被取消；旧 handle 不能自动 beginTurn 或重绑；Resume 后原动作没有重放。 |
| detach / 移组 / close / worker restart | 老结果与监听失效，新 owner 的 capture 干净；迟到清理不影响 replacement attachment。 |
| 资源和保留期 | 三层限额含终态；拒绝新 arm 无资源泄漏；TTL/cancel 清理完成，原 timer/listener 数归零。 |
| 所有公开调用入口 | JS、同步 Python、Go、CLI call、MCP tools/call 均独立执行 arm → action → collect；验证页面状态和 server 计数，不能只看 RPC 没报错。 |
| 用户操作不被打断 | headed 独立 profile 保留 sentinel 前台；记录 `activeEvents=[]`，不通过 Playwright page focus 或真实鼠标掩盖隐藏页问题。 |

最终结果须记录源码标识、实际 staged extension / host / SDK 哈希和浏览器版本。
WS native-port adapter 验收证明的是正式协议链路，不等于已安装 registry/native-host
启动路径验收；沿用现有 harness 文档对这两个边界的区分。
