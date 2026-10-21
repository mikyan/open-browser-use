# Managed 人工接管的重复按键

## 行为与兼容

查看器把原浏览器产生的重复 keydown 逐次传给已建立的人工接管租约，支持
长按退格、Delete 和方向键。只转发真实事件，不用定时器制造重复，也不重放
失败输入。旧租约的普通可打印文字继续走文字提交路径；声明新能力的租约
采用[普通字符原生按键](managed-human-printable-keys.md)，并保留原长按和释放规则。

原 native human 状态声明可选 `keyRepeatVersion: 1`，整个租约固定；省略时
保留旧行为，只读查看不得声明。Go 查看器和原生控制器均核当前状态，历史
清理记录不能授权输入。`repeat` 只允许 key/down 的 `true`，要求同 code/VK
的原 down 已收到 ACK；重复输入各有独立序号及原回执，不替换原持键身份。
当前 key/修饰键可随实际事件变化，原生映射使用 `autoRepeat: true`。

End、导航、失焦和错误取消尚未发送的队列，等待实际在途命令并释放原持键。
原生重复 ACK 不能把此前未知的首次 down 变成已确认持键。Enter 的字符阶段
及网页取消默认行为保留。原 Insert 持键后追加 Shift 等粘贴组合会提示先松键，
防止重复事件变为远端粘贴快捷键；原 up 仍释放。没有读取系统剪贴板。

原生字段见 [DevTools Input 协议](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Input.pdl)。
主机与扩展需配套更新，旧主机的严格状态解析不接受新增能力字段。

## 验证与证据边界

旧版本查看器基线 `before-RDMFkH` 收到可信的 Backspace down、两次 repeat、
up，却只外发首次 down/up；实际失败 exit 1 保留，清理完成。该基线的查看器
帧、状态和传输 ACK 为模拟；独立原生 textarea 能删除三字符，但不能据此声称
旧 managed 任务页面实际只删除一字符。

扩展、Go 与 UI 的先失败后通过回归均保留。最终 UI 122 项通过，新增脚手架
30 项通过；新完整构建通过 Go test/vet 和 2,926 项 Node 检查，绑定440份输入、
77份扩展及实际EXE。UI独立检查另发现并修复持键变粘贴组合的问题，真实OS
剪贴板行为没有在本轮验收。

2026-10-19，固定 Windows Chromium 156.0.8078.12 的 `mhr-rm5fRL` 从正式
managed 入口完成七步流程，实际退出0。六场页面行为使用各自原 textarea：

- End 后长按 Backspace：`abcdef` 变为 `abc`，光标在3。
- Home 后长按 Delete：变为 `def`，光标在0。
- 左/右方向键各连续移动三格，文字不变，光标均在3。
- 网页取消 Backspace 默认行为：文字和光标保持不变。
- Backspace 尚未抬起时结束接管：已删除三字符，End只产生一次原释放。

独立核原查看器事件、23次输入回执、12次重复 down、完整36次按键事件及9次
编辑；End之后查看器本地抬键没有新远端输入，另一任务结束后原页面事件不再
增长。重复按键页零POST，独立原handoff表单恰好一次POST；明确Resume及Stop
完成。真实输入由隔离查看器的原生CDP产生，任务页面只被动观察；这不证明
物理键盘重复速率、所有键盘布局或普通公司Edge环境。

原结果SHA256：`a2cce20c687b1a47f6da3a09a423f76f5b9deb6057ae222a22e3800684d08e90`。
独立事件审计2273项、生命周期审计147项均实际退出0；70张PNG完整解码，
30个原进程身份退出，原Job归零，两注册视图、管道及endpoint清理通过，没有
强制终止。源文件与原结果未变，也没有重跑原业务。

事件审计SHA256：`2214ee4656991d2105f26fc1180c5a9a57dd78f5ceb3cabcfa5ef312f5fb63ee`；
生命周期审计SHA256：`8728a507e460648cf64ec06e5782332f8c0ed21fc3f89e9a08afe0ec21902af8`。

## 复用与交付

配置与源快照匹配的 `OBU_TEST_HOST_BINARY`、`OBU_TEST_EXTENSION_DIR`、
`OBU_TEST_CHROMIUM_BINARY`、`OBU_TEST_BUILD_MANIFEST`，以
`OBU_TEST_HUMAN_SCENARIO=key-repeat` 运行
`scripts/browser-integration/managed-human-check.mjs`。

本修复已进入 [preview-20261019-534b881](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261019-534b881)，从干净提交534b881重建配套主机与扩展。
440份输入与原已测快照及Git对象相符，77份扩展与实测字节一致；离线CLI/MCP、
9231项独立制品检查、四资产回下载和112份本地文件副本核对通过。
上述网页验收绑定内部冻结构建，发布EXE单独重建，打包未重跑原测试或业务。
系统输入法、本地复制、普通公司Edge及完整P01–P15能力对齐保持开放。
