## [2026-10-21 08:51] | Task: 补齐人工普通字符按键并准备新包

### Execution Context

- Agent：`root`，并行代理负责协议、验收与独立检查。
- Runtime：Codex desktop，Windows。

### 用户诉求

持续完善 Browser Use；本轮追问开发状态并要求重新打包。沿用用户 fork，不建 PR。

### 改动与设计

- 新增原租约 `printableKeyVersion: 1`，严格限制 key/down 文字字段、修饰键、
  Unicode 与容量；只读状态不能声明，旧租约保留原路径。
- 查看器用原可信 beforeinput 确认字符候选，保留组合启动与粘贴行为；一次原生
  keyDown 同时传递文字，使空格控件、裸字符快捷键和网页取消默认动作生效。
- 重复输入逐项确认，Shift 变化不改原释放身份；多 scalar 布局文字完整回退，
  已有持键后的不兼容变化结束接管。原未知操作不重放。
- 新增主页面和真实跨站 iframe 的正式业务脚手架；补协议、UI、扩展测试和
  架构、前端、质量、产品规格及专项参考文档。

### 验证

旧版 `mpk-6v5XU0` 实际退出 1，完整记录两页控件、快捷键和取消语义失败。
独立基线核验 1,629 项通过仅证明失败证据可信，不代表旧功能通过。

最终构建 `mso-build-kwztmglh` 完整 Go test/vet、3,357 项 Node（299 项 UI）
通过，474 份源文件及 80 份扩展冻结。中间构建的多 base/ZWJ 和原持键后
多字符重复问题经审查修复，旧红测及中间构建保留；最终未修改生产或脚手架。

正式 `mpk-i2ycz6` 实际退出 0：146 原输入 ACK，无额外 text，两页原控件
及文字各一次 POST，End/Resume、新 SDK 认领与 Stop 完成，29 原进程退出。
业务独审 2,783 项、来源及清理独审 110 项通过；16 张原 PNG 完整解码。

同一构建的 IME `mhi-wwmTuS`、Enter `mhk-RbQQUO`、重复键 `mhr-YtXgOv`、
粘贴 `mhp-1Uclcf` 均实际退出 0，四场业务独审共 1,377 项通过。
五场来源及清理合计独审 995 项通过，
240 张 PNG 完整解码。根代理查看四张原截图，确认主页面/OOPIF 最终字段、
中文组合及结束前候选可读；画面不单独证明 ACK、业务提交或系统输入法。

审计脚本的正则和粘贴双浏览器身份假设错误保留原失败；根据真实 schema
在独立新报告修正，未修改或重跑原浏览器证据。文档更新脚本遇到多个表头时
保守停止，剩余发布记录经定点补充；生产字节没有变化。

### SHA256 索引

| 记录 | SHA256 |
| --- | --- |
| 最终冻结构建 | `8e47282bd32aeb26080eb88a792d4cefda05cbdd1f4d3e6e5399418db61c1632` |
| 正式 printable 原结果 | `70c88236782b5cf980d53e87480fa05b5717c2e6df42971beccaaa3b6073883e` |
| 正式 printable 业务审计 | `d70bc5813a3e0c61c4467c3ecf60b70ec40fb60f092a08d63d3374f01c4a7bb6` |
| 正式 printable 来源及清理审计 | `4e270e9ed5a3907227e6a68f2d39ca746f2061ca8759742be630af0f2f2c7c79` |
| IME 业务审计 | `8a909abd22beded77b444ea0f4912fffb2ed5a79a47994603088412c0dc7481e` |
| Enter 业务审计 | `bd1ba0e3b3b16a2ebf9ef5b8e6eb539a89ee90fe0c50a65ff839852b2dc0bfdf` |
| 重复键业务审计 | `9a1a570bc714e0bb9ccd2a6416c26c47350a5dbcf6405e9d67f15f391b68e47a` |
| 粘贴业务审计 | `f53b5a4064d901b3e4e5b9e443d77d11a1ae8f279a4ec38668f7cc56f6f333eb` |
| 重复键来源及清理审计 | `aff15c83ead9d4b50c1b85d26f9efbdb2fa785e833b918914060a2fcec14e686` |
| 粘贴来源及清理审计 | `452dfb50edbde35e7c73577c08ac366fad5a8aa978a43a356de6e637f55f1474` |

### 边界与交付

公司 Edge 人工授权继续按用户要求延期。AltGraph、系统输入法、系统焦点及
完整 P01–P15 未完成；固定 Headless Chromium 通过不代表整体能力持平。
用户明确要求本轮新包，完成固定提交构建和制品检查后另补发布记录。

主要文件：`internal/managedprotocol/human.go`、`internal/managedviewer/`、
`internal/managedbrowser/managed_user.go`、`apps/chrome-extension/managed-human-control.js`、
`scripts/browser-integration/managed-human-printable-*.mjs`，专题说明见
[普通字符按键](../../references/managed-human-printable-keys.md)。
