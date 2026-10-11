# SDK connection identity and explicit recovery

JS、Python、Go公开SDK把一个client及其tab、locator、wait/download handles
绑定到首次成功建立的实际传输连接。连接失效不能把旧任务状态带到另一条
连接，即使endpoint字符串、session、tab编号及control epoch碰巧相同。

## Contract

- 显式close是终态，包括尚未connect或初次connect仍未完成时。迟到连接
  不得复活client。已经建立的连接发生EOF或需要丢弃stream时也是终态。
- 已在途调用保留原始失败；后续有效调用稳定返回
  `OBU_SDK_BROWSER_DISCONNECTED`。Go可用`errors.Is(err, obu.ErrBrowserDisconnected)`。
  connect、beginTurn、手工epoch和active registry变化均不能绕过。
- 恢复需要明确选择endpoint、新client、新handles及显式beginTurn。原有
  handles始终失效；不要因收到断线错误就重放输入。先检查实际页面状态，
  已发送动作的结果可能未知。
- 初次discovery/dial从未成功，且未显式close时，允许再次尝试。成功连接
  后即便首次响应失败也进入终态，不以控制协商完成作为绑定起点。
- 完整RPC业务错误、编码错误或发送前预算耗尽保留健康连接。JS请求响应
  超时保留同一个健康socket并隔离晚响应；Go/Python原有同步wire超时会
  丢弃stream，因而变为终态。没有增加自动重试或动作预算。
- 连接仍活着、只有extension控制epoch变化时，可以在检查状态后显式
  beginTurn；它只更新控制范围，不创建另一条传输。Python仍不支持并发
  或notification callback内嵌套请求；Go Close保持原请求锁等待语义。

实现位于三个SDK的client入口，不依赖扩展恰好拒绝旧epoch。既有服务端
owner、site、attachment、browser incarnation和持久control ledger仍必要。
MCP已有相同实际连接固定契约，见[mcp-connection-lifetime](mcp-connection-lifetime.md)。

## Original failures and native IPC checks

旧JS在EOF/close后向复用路径的B发送新browserAction，保留A的session、
turn、tab7和epoch1。真实生产ControlLedger在B已bootstrap相同session且
epoch相同条件下会接受；不同epoch和未知session会拒绝。这不是原wire
请求重放，也不证明真实浏览器误点击；真实tab归属等其他条件仍须满足。

Go原生named-pipe测试让A/B同时live；active切到B时健康旧连接仍使用A，
A原连接随后EOF后旧client才重新读取active并连到B。保留实际pipe请求的
解码记录、ID与旧绑定字段，没有把它当作原始frame字节归档。旧Python
在EOF、close、wire timeout、错误response ID
四组中均向B发送13个旧绑定请求；修复后四组B均收到零旧请求，fresh client
正常控制协商和业务调用。JS连接身份专项对旧源17项中12项失败，修复后17项全过。

测试还覆盖旧tab/locator、四种wait和download handle、手工epoch、首次
失败重试、已连接但协商失败、部分帧、原错误保留、并发/排队及晚连接。
Python追加真实transport反例验证本地预检错误不关闭健康stream，factory
返回前发生close则迟到连接零请求并销毁；这不扩大其线程安全承诺。

## Browser acceptance and scope

`scripts/browser-integration/sdk-connection-fixture.mjs`在正式host前放一条
透明字节relay，保持同一真实backend及原epoch/ownership门禁。三个正式
SDK caller各执行EOF和显式close两场：读取原document readiness；切断
原连接；验证locator、beginTurn、connect、manual epoch四入口均拒绝，
没有新连接和业务POST；显式新client、新turn后唯一可信点击产生真实POST；
旧locator仍拒绝。验收逐项核对原HTML/POST字节、同document token、两条
实际连接的原始request、fresh epoch/turn、实际child exit及close、relay
双端close、原tab与target回收。错误/重复POST不会被server过滤掉。

Windows Chromium 156专项`run-aZMiIx`实际exit0、4/4（原导航哨兵及三个
双场聚合）。六场各唯一恢复提交，旧客户端零业务提交。此测试证明同一
真实browser backend断线后的拒绝与显式恢复；跨实例碰撞由原生IPC反例
覆盖，不能写成真实跨浏览器误点击已经复现。Native Port仍使用既有隔离
adapter，此专项不代替原生launcher、实际host/browser重启或其他系统。

专项及后续完整回归使用同一冻结SDK与新构建9个Go二进制，50个仓库生产
构建输入前后hash一致。没有新focus豁免，不操作系统鼠标或用户tab。
独立源码、原始业务和焦点审计另记录于同任务history/plan。

完整`run-yVGT4D`实际exit0、125/125，旧122名称和相对顺序保持。专项
2753ms零focus/activation；完整244620ms仅原12activation/4controlpopup
focus。两轮sentinel身份/选择保持，高1222→1165；启动和清理仍在观察
区间之外，不能称全部运行期零焦点变化。原host在重启测试SIGTERM，
替代host实际exit0。实机业务证据不依赖无效epoch制造拒绝。

非浏览器验收：Node1792/1792，JS142/142，Python110/110，均无skip或cancel；
Go全仓519 test/subtest事件通过，26项平台条件skip另记，8个无测试helper
包编译通过；workspace typecheck通过。

另在WSL2 Ubuntu短路径独立快照实测Unix socket：Go1.26.9全包523pass/
10平台skip，JS142/142零skip，Python109pass/1 Windows路径校验skip；
六个构建/测试子命令与外层进程均actualexit0。全新Linux host用于JS/Python
集成，四组Python Unix socket反例修复后B均零旧请求且fresh恢复。186份
源码/测试与当前源hash相同，20 JS dist经Linux TSC重建完全一致。首次
临时目录在测试启动前被环境清空，原失败保留；使用新持久短路径完成，
没有重跑失败SDK测试。未运行Linux真实浏览器、macOS或CGO race；旧preview
不替换，本片不创建PR。
