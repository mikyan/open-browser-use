# 网络事件等待：实现契约与验收

状态：两阶段 request / response 等待已接入开发版 extension、JS/Python/Go SDK
及 CLI/MCP 通用 `call`。本页描述实现契约和验收要求，**不作为真实浏览器验收通过的
证明**。正式运行结果以 harness 保存的版本、制品哈希和日志为准。

## 使用顺序

1. 对当前任务拥有的 tab 调用 `expectRequest` / `expectResponse`，等待返回 handle。
   返回意味着授权、冷引擎 attachment 和监听注册已完成，不代表网络事件已经发生。
2. 在同一任务轮次触发页面动作。使用已观察到的按钮或其他真实触发条件。
3. 调用 handle 的 `result` 读取首个匹配事件；验证 URL、method、status 和页面结果。
4. 不再需要 handle 时 `cancel`。触发失败时尽力 cancel，但保留原动作错误。

这是正式的 ready ACK，不需要 sleep、并发启动线程或预热引擎来猜监听时机。
同步 Python、Go、CLI 和 MCP 均可顺序完成。不要先阻塞 collect，再指望同一串行
通道发送触发动作。文件选择器和下载仍遵守各自限制；URL/loadstate 另有
[导航等待](navigation-waits.md) ready 接口。本片不提供任意 predicate、regex、
响应体、请求头或网络拦截。

## Wire 与能力协商

检查 `getInfo.metadata.networkWaitVersion === 1`。SDK 和 CLI/MCP 自动检查该能力；
旧 extension 明确返回 `OBU_NETWORK_WAIT_UNSUPPORTED`，不回退到 diagnostics 缓存。
能力版本独立于 `browserActionProtocolVersion`，以下三个 RPC 不是 browserAction：

| RPC | 标准 scope 以外的参数 | 成功结果 |
| --- | --- | --- |
| `armNetworkWait` | `tabId`, `event: "request" \| "response"`, `match`, `timeoutMs?` | `{waiterId, remainingMs}`，监听已就绪 |
| `collectNetworkWait` | `tabId`, `waiterId` | 有限的请求/响应元数据；pending 时等待原网络期限内的事件 |
| `cancelNetworkWait` | `tabId`, `waiterId` | `{}`，删除记录与监听，不改变页面 |

scope 为 arm 实际提交的 `session_id`、`turn_id`、正整数 `control_epoch`；三个 RPC
必须始终使用同一组值。`match` 包含非空 `url`（最多 4096 UTF-8 字节）、可选
`urlMatch: "exact" | "contains"`（默认 exact）、可选非空 `method`（最多 128 字节，
保留大小写精确匹配），以及仅 response 接受的整数 `status`（100–599）。未知字段
被拒绝。完整字段、字节上限与错误契约见
[Browser action protocol 的网络等待章节](browser-action-protocol.md#network-request-and-response-waits)。

collect 返回普通对象，没有 `{value, engine}` 包装：

```json
{"event":"response","requestId":"request-1","url":"https://example.test/api/save","method":"POST","resourceType":"fetch","frameUrl":"https://example.test/","status":201,"statusText":"Created"}
```

`frameUrl`、`redirectedFrom` 和 `truncated` 可选，response 有 `status` 及原生
`statusText`（允许空字符串）。元数据整体最多 16 KiB；截断会标记 `truncated:true`。
匹配始终使用截断前的原生 URL/method。requestId 仅在原 attachment 内关联，不能
当作跨 Page、诊断 capture 或 worker 重启的全局 ID。redirect 产生新 Request，
`redirectedFrom` 可关联前一请求。

response 表示状态和响应头已到达，不表示 body 下载结束。404/503 仍可匹配；网络
连接失败可能只有 requestfailed，因此 response wait 会超时。只观察注册后送达的
所选事件，不扫描历史；注册前开始、注册后收到响应的请求可以匹配 response wait。

## SDK 示例

以下示例假定 `tab` 已由同一个 SDK browser 创建或领取，页面有已观察到的 Save
按钮，会向 `api_url`/`apiURL` 发出 POST 并返回 200。示例的等待方法也可通过
`tab.playwright`（Go：`tab.Playwright`）调用。

JavaScript：

```js
async function save(tab, apiURL) {
  const pending = await tab.expectResponse(
    { url: apiURL, method: "POST", status: 200 }, { timeoutMs: 5000 });
  try {
    await tab.getByRole("button", { name: "Save", exact: true }).click();
    const response = await pending.result();
    console.log(response.requestId, response.status);
    return response;
  } finally {
    await pending.cancel().catch(() => {});
  }
}
```

Python（无需线程）：

```py
def save(tab, api_url):
    pending = tab.expect_response(
        {"url": api_url, "method": "POST", "status": 200}, timeout_ms=5000)
    try:
        tab.get_by_role("button", name="Save", exact=True).click()
        response = pending.result()
        print(response["requestId"], response["status"])
        return response
    finally:
        try:
            pending.cancel()
        except Exception:
            pass  # Cleanup must not hide the original action/result error.
```

Go（函数位于已导入 `fmt`、`time` 和 SDK 别名 `obu` 的文件中）：

```go
func save(tab *obu.Tab, apiURL string) error {
    pending, err := tab.ExpectResponse(obu.NetworkWaitMatch{
        URL: apiURL, Method: "POST", Status: 200,
    }, obu.NetworkWaitOptions{Timeout: 5 * time.Second})
    if err != nil { return err }
    defer func() { _ = pending.Cancel() }()
    if err := tab.GetByRole("button", obu.RoleOptions{Name: "Save", Exact: true}).Click(); err != nil {
        return err
    }
    response, err := pending.Result()
    if err != nil { return err }
    fmt.Println(response.RequestID, response.Status)
    return nil
}
```

请求等待对应 `expectRequest` / `expect_request` / `ExpectRequest`，不能设置 status。
JS/Python match 使用 wire 字段名 `urlMatch`。Go 使用 `NetworkWaitMatch.URLMatch`；
空值表示 exact，空 Method 和零 Status 表示未指定。Go `NetworkWaitOptions.Timeout`
必须为整毫秒，零值选择默认。JS/Python 结果保留 camelCase wire 字段；Go 返回
`NetworkWaitResult`，字段包括 `RequestID`、`FrameURL`、`RedirectedFrom`、`StatusText`。

JS 的 `result({timeoutMs})`、Python 的 `result(timeout_ms=...)`、Go 的
`Result(NetworkWaitOptions{Timeout: ...})` 都可设置独立读取预算；cancel 接受同样
选项。handle 的 `waiterId`/`waiter_id`/`WaiterID` 为不透明 ID；
`remainingMs`/`remaining_ms`/`RemainingMS` 只是 ready 时的剩余时间，不可用来续期。

## CLI 与 MCP

没有额外的专用 network 命令；使用通用 `call`。多个 CLI 进程不会自动共享 turn，
因此先取控制状态，再保存 **原始** session/turn/epoch，并在 arm、触发、collect、
cancel 中全部显式传入。不要在各步之间调用 begin-turn 或重新取最新 epoch。

下面是 Bash + jq 示例。先设置 `OBU_SESSION_ID`、`OBU_TAB_ID`、`OBU_API_URL`，分别为
当前任务 ID、已领取的 tab ID 和页面 Save 按钮的真实 POST URL。各调用应指向同一
浏览器/profile；需要时在函数中加入相同的 `--socket` 或 browser/profile 选择参数。

```sh
set -euo pipefail
obu_call() {
  open-browser-use call --session-id "$OBU_SESSION_ID" --timeout 121s \
    --method "$1" --params "$2" |
    jq -e 'if .error then error(.error.message) else .result end'
}
state=$(obu_call getControlState '{}')
jq -e '.closing == false' <<<"$state" >/dev/null
scope=$(jq -cn --arg session "$OBU_SESSION_ID" --argjson tab "$OBU_TAB_ID" \
  --argjson state "$state" \
  '{session_id:$session,turn_id:$state.nextTurnId,control_epoch:$state.controlEpoch,tabId:$tab}')
armed=$(obu_call armNetworkWait "$(jq -c --arg url "$OBU_API_URL" \
  '. + {event:"response",match:{url:$url,method:"POST",status:200},timeoutMs:5000}' <<<"$scope")")
handle=$(jq -c --argjson ack "$armed" '. + {waiterId:$ack.waiterId}' <<<"$scope")
trap 'obu_call cancelNetworkWait "$handle" >/dev/null || true' EXIT
obu_call browserAction "$(jq -c \
  '. + {action:"click",locator:[{kind:"role",role:"button",name:"Save",exact:true}],timeoutMs:5000}' <<<"$scope")"
obu_call collectNetworkWait "$handle"
```

CLI 输出保留 JSON-RPC envelope，上例提取 `.result` 并拒绝 `.error`。`--timeout` 是
一次请求的总 transport 预算；arm 仍只使用 timeoutMs 加 1 秒中的更小预算，发现
endpoint、协商和排队会扣掉可用时间。collect 没有 timeoutMs 参数，使用独立的
CLI transport 预算。示例 121 秒是读取上限，不把网络等待延长为 121 秒。

MCP server 以 `obu mcp --session-id <task-id> --timeout 121s` 启动，经 initialize
后，用 `tools/call` 的 `call` 工具依次提交这三个方法。例如 arm 请求：

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"call","arguments":{"method":"armNetworkWait","params":{"session_id":"task-id","turn_id":"observed-turn","control_epoch":1,"tabId":123,"event":"response","match":{"url":"https://example.test/api/save","method":"POST","status":200},"timeoutMs":5000}}}}
```

用实际 `control_state` 返回的 epoch/turn 和已领取的 tab ID 替换示例值。等待 ready
工具结果后，再用同样的 scope 发送 `browserAction`；最后用 `collectNetworkWait`
和 `{...scope,tabId,waiterId}` 读取。取消使用 `cancelNetworkWait`。检查外层 JSON-RPC
error、工具 `isError` 和 `structuredContent.error`；成功 ready 数据位于
`structuredContent.result`。同一个未结束的 MCP server 会自动补入其绑定 scope，
但显式携带已保存的值可防止调用者混用新轮次。MCP 的输入队列时间也消耗原 arm 预算。

## Deadline、保留期与失效

- arm 默认 10000 ms，整数范围 1..120000。从 SDK/CLI 提交起计算，discovery、
  协商、连接、前置队列、controlReady 和 attach 都消耗预算。最终 wire 前再次收紧；
  不足 1 ms 操作时间则不发 arm。默认 client timeout 不会扩大显式短预算。
- 第一条匹配候选必须在原 deadline 前送达并同步选定。归属复核独立限时 10 秒，
  不改变事件时间，也不换成后来的候选。collect 前后归属复核同样各有 10 秒上限，
  因此结果送达可晚于网络 deadline；复核挂起不能无限保留执行中的校验。
- SDK result 默认独立读取预算 120000 ms，cancel 默认 10000 ms；可设 1..120000 ms，
  均加 1000 ms RPC 余量。读取超时不自动取消 waiter、重新 arm 或重放输入。
- matched、timed-out、failed 终态自结算起保留 30 秒；期间重复 collect 读取同一
  结果或错误。迟到 collect 可以读取 deadline 前已选定的事件。cancel 立即删除。
- 16/tab、32/session、128/global 容量同时计入预留、pending 和保留终态；新 arm
  达限失败，不驱逐有效记录。即使 ready ACK 丢失，也由 backend deadline/TTL 回收。

记录绑定 session、turn、epoch、tab 与原 attachment identity。Pause、end/finalize、
detach、tab close、移组/跨窗口归属变化和 worker restart 使 pending 与已匹配结果
失效，唤醒等待中的 collect。相同已授权 Page attachment 内的普通导航可以触发匹配，
无需为了导航把等待提前取消。没有持久化或自动恢复 waiter。Session ID 是路由标签，
不是认证凭据；waiterId 不能绕过 owner、group 和 epoch 复核。

| 错误前缀 | 调用者处理 |
| --- | --- |
| `OBU_NETWORK_WAIT_UNSUPPORTED` | 当前 extension 未声明 v1；报告版本限制，不假装轮询等价。 |
| `OBU_NETWORK_WAIT_TIMEOUT` | 原期限内无可提交的匹配；检查页面与诊断，不自动重触发。 |
| `OBU_NETWORK_WAIT_EXPIRED` | 记录不存在、已取消/过期或不属于原 scope；旧 handle 不可恢复。 |
| `OBU_NETWORK_WAIT_LIMIT` | 释放不再需要的当前 handle，或等待 TTL；不自动重放动作。 |
| `OBU_NETWORK_WAIT_FAILED` | 事件描述或有限归属校验失败；保留错误并检查控制状态。 |

普通 stale epoch、ownership、Pause 错误可能先于上述错误。未知 handle 的 cancel
在普通控制/归属校验通过后幂等返回 `{}`，不能用于绕过 Pause。`beginTurn` 只用于
显式开始后续工作，不会给旧 handle 换绑。恢复后先检查当前页面再决定新的动作。

## 实现位置

| 路径 | 职责 |
| --- | --- |
| `apps/chrome-extension/browser-network-waits.js` | 有限匹配、容量预留、事件选择、scope 复核、终态、TTL 与清理 |
| `apps/chrome-extension/browser-action-engine.js` | `withPage` 短 setup 队列与真实 CRX Page；长监听/collect 不占动作队列 |
| `apps/chrome-extension/background.js` | RPC allowlist、capability、controlReady 前预留、ownership/attachment 与 Pause/end 清理 |
| `packages/open-browser-use-js/src/network-waits.ts` 与 `src/index.ts` | typed handle、严格响应验证、提交时 scope 和预算 |
| `packages/open-browser-use-python/open_browser_use/_network_waits.py` 与 `client.py` | 同步 ready/trigger/collect 与固定 scope |
| `packages/open-browser-use-go/network_wait.go` 与 `client.go` | typed 同步 handle、固定 scope 与串行 gate 预算 |
| `cmd/open-browser-use/control.go` 与 `mcp.go` | capability、显式跨调用 scope 和最早提交时刻预算 |

host、IPC framing 和 endpoint discovery 沿用既有实现；该协议不依赖跨 session
事件广播，也不通过扫描 diagnostics ring 补发旧事件。

## 正式验收要求

可复用 `scripts/browser-integration/network-waits-fixture.mjs`、`run.mjs` 与各语言
checker。经过实际 Go host 和生产 extension 的 Page 事件，不能伪造 CDP 网络事件
或为了通过冷启动测试先预热引擎。以下是验收条件，不是本页对运行结果的声明。
事件早于 ready ACK 的调度边界由定向 unit test 控制验证；不能把事件早于 collect
的真实浏览器测试写成已覆盖早于 ACK。容量、TTL 和人为挂起校验同样应注明测试层。

| 场景 | 必须观察到的结果 |
| --- | --- |
| 冷引擎 arm → 立即 click → collect | 主 frame/OOPIF 得到真实元数据，无队列死锁；server 只收到一次触发。 |
| 事件早于 collect/ACK | 结果保留，TTL 内重复读相同结果，不再次触发网络。 |
| 旧事件和匹配条件 | 注册前完成事件不命中；URL exact/contains、method、status 生效，未知字段拒绝。 |
| response 语义 | headers 到达即可完成；延迟 body、错误状态、redirect IDs 和断网均不伪造成功。 |
| 短 deadline | 100ms 预算被 250ms setup 消耗后无新监听/ready；迟到 setup 不影响后继 attachment。 |
| 两 session 同 URL | 只看到自己 Page；交换 ID、换 epoch 或新 owner 均不能读旧结果。 |
| Pause/end/close/detach/移组/restart | pending 被取消、终态失效；Resume/BeginTurn 不重放原动作。 |
| 资源与 TTL | 预留及终态计入上限；超额 arm 拒绝、cancel/TTL 释放 listener/timer。 |
| 公开入口 | JS、同步 Python、Go、CLI call、MCP tools/call 都顺序执行并验证 server 计数及可信输入。 |
| 前台不受影响 | headed 独立 profile 保留 sentinel，记录 tab activation；不能通过 page focus 或真实鼠标掩盖问题。 |

最终结果应保存源码标识、实际 staged extension/host/SDK 哈希、浏览器版本与
`network-server.json`。WS native-port adapter 验收证明协议链路，不等于系统已安装
registry/native-host 启动路径验收；详细边界见
[正式 browser integration harness](../../scripts/browser-integration/README.md)。
