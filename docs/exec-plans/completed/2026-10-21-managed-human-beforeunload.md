# 人工接管的未保存页面离开确认

## 目标与边界

继续 Browser Use 能力对齐：用户在独立 managed 浏览器中编辑未保存内容，
应能通过正式查看器决定留在页面或离开页面，并继续完成原任务。
已发布版本仅支持 alert/confirm/prompt；beforeunload 被取消且结束接管。
这项工作不改变 Stop 关闭会话的语义，不创建 PR，不重新发布刚交付的预览包。
普通公司 Edge 人工安装验收仍按用户指示留待方便时进行。

## 当前依据

- 起点为干净 `3e61b68`，其生产内容与 `96595fc` 相同。用户后续要求的
  `preview-20261021-3e61b68` 已发布；当前 `735bd02` 只记录该交付。
- 前一轮完成同功能重包及核验；未发布的 beforeunload 候选留在工作区，
  本轮不再打包。全局目标仍未完成。
- 两条原产品真实诊断已确认缺口；实现已接通核心、Go 与查看器，通过整体
  构建、两条完整真实业务流程及独立审计。本项完成，尚未发布安装包。
- `frameStartedNavigating` 会退役旧 generation 和文档证明，但 beforeunload
  属于仍未离开的旧文档。不能只增加类型枚举或以新快照重新授权旧弹窗。

## 工作与验收

- [x] 复用正式 managed / 查看器入口，先保存原产品失败及原生事件顺序。
- [x] 固定原 attachment、旧 document、一次输入及原 Opening/Closed 的关系；
      实现取消后继续原文档、确认后等待真实新文档。未知回执不重放。
- [x] Go 与查看器支持明确的“留在页面 / 离开页面”，保留 End 的取消及清理。
- [x] 有意义的确定性测试覆盖退役、取消、确认、迟到 ACK、End 和原三类弹窗。
- [x] 冻结新构建，正式流程完成草稿编辑、取消离开、再次确认离开、新页面、
      End、显式 Resume、原结果读取、唯一业务提交及 Stop 清理。
- [x] 独立核对来源、原业务回执、原帧和生命周期；记录未验边界并提交至 fork。

只有根代理运行隔离浏览器；不使用个人 profile、系统鼠标/键盘或剪贴板。
诊断若包裹原生发送，只作观察并保留原 Promise，不作为正式无插桩验收。
保留全部失败记录。合成测试不代替真实 SSO、公司 Edge 或系统焦点保证。

## 风险与判定

必须先确认 Chromium 实际导航事件顺序，包括取消后是否有明确取消事件。
原文档仍存活不等于允许恢复已撤销的输入。产品需把离页决策的授权与普通
输入的暂停/恢复分别表达，所有原实际发送和清理仍受原期限约束。
若浏览器无法证明旧文档或原弹窗归属，报告该具体限制，不能借后继文档补权。

## 固定实现依据与首轮记录

使用 Chromium `634b046faf2137b83af71c87baf362b533af9104` 的源码作为设计依据：
[renderer 根导航](https://github.com/chromium/chromium/blob/634b046faf2137b83af71c87baf362b533af9104/content/renderer/render_frame_impl.cc#L5853)
先执行 beforeunload，拒绝则直接返回；
[浏览器发起导航](https://github.com/chromium/chromium/blob/634b046faf2137b83af71c87baf362b533af9104/content/browser/renderer_host/navigator.cc#L1048)
先保存导航请求再执行 beforeunload；保存请求会发出
[DidStartNavigating](https://github.com/chromium/chromium/blob/634b046faf2137b83af71c87baf362b533af9104/content/browser/renderer_host/frame_tree_node.cc#L603)。
[取消路径](https://github.com/chromium/chromium/blob/634b046faf2137b83af71c87baf362b533af9104/content/browser/renderer_host/frame_tree_node.cc#L734)
可能早于 NavigationHandle 通知，不能假定一定收到 webNavigation 错误事件。
这些源码结论不替代实际运行证据。

首轮 `mbu-cDStXd` 在启动浏览器前退出 1：沿用的旧弹窗 runner 源清单未包含
新版冻结构建中的根目录脚本测试文件，严格来源核对拒绝继续。修正脚手架清单，
保留原结果；这不构成产品 beforeunload 的实际失败证据。

修正后 `mbu-mf7bh1` 实际退出 1，正式 managed 启动、结果页交付、查看器和
接管均成功；单次真实链接点击产生原 beforeunload，却没有可用的查看器选择。
统一观察序列为 Opening 60 → 自动取消发送 61 → Closed(false) 63 → 取消
ACK 64 → 原鼠标释放 ACK 65；这段未观察到导航开始或 webNavigation 事件。
原文档、草稿保持，查看器自动结束接管。根代理目视保存截图确认无选择卡片，
显示原草稿和保留画面；画面本身不代替文档身份与回执证明。

报告 SHA256 为 `b963c3f997e5bbd65b6f453120e08e5ff55ed3b76ddde578c271ffad87fb7b6e`。
原 supervisor/查看器实际退出，25 个原进程身份全部消失；注册、端点与管道
清理完成，来源完整性保持，cleanupErrors 与 liveRunnerChildren 均为空。
这是带发送观察包装的失败诊断，不是正式功能通过。

跨站子 frame 普通 `target=_top` 链接的第二条诊断 `mbu-BFMeNn` 也实际
退出 1，确认另一种顺序：原鼠标释放 ACK 74 → 根 frameStartedNavigating
75 → beforeunload Opening 79 → 自动取消发送 80 → Closed(false) 82 →
取消 ACK 83。原根/子文档、草稿和原默认上下文身份保留，查看器没有选择卡片；
只出现两次原页面 GET，没有目标页 GET 或业务 POST。28 个原进程退出，原注册、
管道和端点清理完成，来源完整性保持。报告 SHA256：
`0b48dd4f73b54d3d55216c7b151165c63b5d9156d521a9d6ddd4765eb4e7b55f`。
两份失败证据独审分别 91/99 项通过；独审成功只说明诊断证据完整。

## 实现及验证过程

候选固定旧文档、原 frame/loader/context 和事件记录；导航开始只退役旧输入，
不借新文档授权离页决策。Closed 的原生结果与实际 handle ACK 分别等待。
取消后只刷新同一文档权限证据并恢复原记录，建立新 generation 和新帧；
确认后等待原导航祖先的真实 native commit，再按原路径准备后继文档。
End、未知回执或身份变化撤销恢复，原实际调用仍进入清理。

首个候选完整构建通过 Go test/vet 与 3,242 项 Node 检查，保留为
`mso-build-7n65og2u`，未启动浏览器。独立读审随后复现迟到原 URL hint
误取消合法离页决定：通用 hint 校验找不到 pending 导航移除的根事件记录。
修复使用同一 departure ticket 前后复核，保留普通候选校验，不刷新或推进
已发布决定的权限。原失败与无 hint 对照保留，修复独立 14 项检查通过。
后续 555 项相关定向检查、70 项后台/结果页检查均通过；原查看器 223 项及
Go protocol/viewer test/vet 也通过。脚手架修正输入队列取证时序，39 项通过，
弹窗仍先由真实 UI 回答再等待原输入 ACK，避免等待环。全部文件重新冻结。
这些检查不证明真实浏览器通过。正式验收使用 `--acceptance`，跨站路径再加
`--child-navigates-parent`，仅被动监听。需要分别完成 Stay、原草稿续写、Leave、
后继文档原帧、End/Resume、新 SDK turn/claim、唯一 POST、再交付和真实 Stop。

更新后的 `mso-build-k5ranhzd` 通过完整 Go test/vet 和 3,256 项 Node 检查，
固定 470 输入/80 扩展；构建报告 SHA256：
`20806070100aa5270abae78eab6c48b5fc72e885d8f8ce9227e7a98cc2f02e88`。
正式根路径首场 `mbu-lcCkr2` 实际退出 1：Stay 原决定/ACK 后保留同一文档、
原草稿和 context，新的 generation 支持真实续写；第二次 Leave 也收到原
决定 ACK 和 Closed(true)，其后观察到原 target 新文档提交。脚本却在 Closed
worker 时间比 Node 收到 framesent 通知的时间早 1 毫秒时停止，不能据此推断
浏览器在决定之前关闭弹窗。没有执行后面的正式新页读取和 Agent 业务 POST。
原失败报告 SHA256：
`822fdc9688312e3870c8fd9f0ed6dcdf9bc1d282a5df5bc4e4ea8a0b9fa9ef09`。
Stop、27 个原进程退出、管道/注册/端点清理及来源完整性均已记录；保留 false
功能结果。根代理目视待决定截图，确认两个中文选择及 Stay 后原草稿续写可见。
随后只修跨观察来源的无效时序比较，继续要求原事件顺序与确切决定回执，
原失败结果不变。40 项脚手架检查通过，包含跨观察来源 1 毫秒倒序的正例及
原事件倒序、错 frame/source/result、缺失或重复决定回执的拒绝例。

## 完成结果

使用同一冻结构建的根路径 `mbu-ujOpm6` 和跨站子页面导航父页路径
`mbu-uEnxlF` 均实际退出 0。两场完整完成原草稿编辑、Stay 后同文档续写、
Leave 后新文档原帧、End、显式 Resume、新 SDK turn/claim、唯一业务 POST、
原始响应、再交付及 Stop。每场 31 个原请求对应 31 个成功回执，22 次输入
和 2 次决定均核对确切 ACK；业务请求 219 字节、响应 189 字节，没有重复提交。
跨站场另核实不同 renderer、原 child target/session/default context，以及
两次根导航开始先于 Opening；根场两次均无先行根导航开始。

| 路径 | 原结果 SHA256 | 独立事件/业务检查 | 独立来源/生命周期检查 |
| --- | --- | --- | --- |
| 根路径 | `b0292a23ee8681e7c58ef6ad352c4e82c396381597c5c680399441b5fd966b4c` | 449 项 | 91 项 |
| 跨站 OOPIF | `a56ae212434a0894f1104d11f7e1284354d6f0939b1dc25f2154babba2752bc1` | 505 项 | 85 项 |

两场 25/27 个原进程身份全部退出，原注册、端点和管道清理完成；22/19 张 PNG
完整解码。470 份当前生产输入、80 份扩展与冻结构建一致；原快照和 420 份当前
验收脚本另行逐字节核对。根代理目视原生后继帧、待决定卡片及稍后查看器画面，
不以截图代替身份、回执或清理证据。根/跨站两张后继首帧 PNG 实际字节相同，
早先工具批量展示导致的“跨站首帧局部绘制”判断已在单图重读后撤回。

具体合同及审计报告哈希见 [离页确认参考](../../references/managed-human-beforeunload.md)。
本项限定于固定 Windows Headless Chromium 中两条普通链接流程，不能证明
真实公司 Edge、SSO/MFA、所有嵌套导航、浏览器工具栏关闭/刷新或实体桌面焦点。
本项完成不等于全部 Browser Use 能力对齐；全局计划继续，当前发布包仍不含此增量。
