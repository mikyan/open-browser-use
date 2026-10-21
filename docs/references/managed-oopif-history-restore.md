# 跨站 iframe 的历史恢复

## 原业务与首次失败

本项验证 Agent 在根页面及跨站 iframe 填写独立草稿，前往 B 页面，再由公开
`goBack` 返回原页面。返回后必须能重新观察、定位并提交原 iframe 草稿。
页面没有存储恢复、输入重放、跨 frame 代操作或重新加载 fallback。

正式 managed 基线 `mof-xqPW7X` 使用冻结构建 `mso-build-kwztmglh`，
实际退出 1。两页保留原 documentId/token、草稿和可信的
`pageshow(false) → pagehide(true) → pageshow(true)`；原生根 frame 返回
原 loader 且类型为 `BackForwardCacheRestore`。原 `goBack` 和根
`domSnapshot` 成功，随后 `snapshotAI` 报
`OBU_SNAPSHOT_INCOMPLETE: iframe disappeared during capture`。
只有三个原页面 GET，没有 POST；首次失败保留，未重试原操作。

独立核验 555 项通过，仅证明该失败证据和清理可信。Turn End、Stop、
15 个原进程、Job、两个注册视图、私有 pipe 与 endpoint 清理完成。
原结果 SHA256：`98fd3bf71d74caf44c595e79a3df09dcd9767adbf25aa22ac144a5577a64f7b3`。
独审 SHA256：`a69e8f1655bdc9340ff2dba913884a317397702376fe449dd060941dc3f4721a`。

## 事件和恢复边界

原生事件 49 是同 iframe target 的新 session attachment，54 才是根页面
恢复；新 child session 没有 execution context 事件。60 的 detach 在失败
之后的 Turn End 期间发生，不能当成失败原因。

固定 CRX 在对应 Frame 不存在时跳过子 FrameSession 初始化；根文档导航
又会清除旧子 Frame。现有 adapter 的异步 child tree 准备可能跨越根 graph
替换，而根恢复只补本地 child。原 observer 未记录 native tree 命令回执，
因此具体 await 的完成顺序仍是源码解释，不能声称已直接观察到。

Chromium 156.0.8078.12 的
[Page agent 源码](https://raw.githubusercontent.com/chromium/chromium/156.0.8078.12/third_party/blink/renderer/core/inspector/inspector_page_agent.cc)
在构造 frame tree 时只递归 LocalFrame，跳过远端子 frame；根 tree 不能独自
证明 OOPIF 的恢复。原生 [Page 协议](https://raw.githubusercontent.com/chromium/chromium/156.0.8078.12/third_party/blink/public/devtools_protocol/domains/Page.pdl)
明确区分普通导航和 BFCacheRestore；[Target 协议](https://raw.githubusercontent.com/chromium/chromium/156.0.8078.12/third_party/blink/public/devtools_protocol/domains/Target.pdl)
的 attachment/detachment 按 session 标识，不能把 target 标识相同等同于旧
session 仍然有效。

## 验收约束

- 原公开 SDK 负责填入、导航、观察和提交；只读诊断不能恢复连接或代做业务。
- 两页 documentId/token、可信 persisted 生命周期、草稿与唯一 POST 分别核对。
- OOPIF 的 native session/context 从事件序列核对，detach/clear/destroy
  使旧记录失效。未重新报告的叶 loader/parent 明确记为未观察。
- 真正没有命中缓存属于覆盖不足；恢复后丢草稿或 SDK 失败属于功能失败。
- 源码、宿主、扩展、SDK 和脚手架保存原字节；实际退出与清理单独验证。

最终生产修复和下述固定场景验收已完成。单一固定 Chromium 场景不能证明所有
frame 拓扑、普通公司 Edge、跨平台、旧 capture ref 在其他文档的拒绝行为，
或完整 P01–P15 持平。已发布预览包保持原版本。

## 首个修复候选的原始结果

候选构建 `mob-build-_510h5vu` 的 3380 项 Node 检查全部通过；Go、嵌入式
UI、SDK 和锁文件按原字节核对后复用原 Go 检查及 EXE，没有宣称重新执行。
正式场 `mof-giZbLm` 实际退出 1：唯一 `goBack` 等待约 15 秒超时，后续
snapshot 和提交没有执行。根、叶仍恢复原文档和草稿，服务端三个 GET、零 POST。

与首次基线不同，返回的 child session 已有原 loader 的原生 load 及原
Runtime context；但根的恢复后 load 未观察到。超时结算前出现 child detach，
因此结算时没有 live child context 不能解释为恢复期间从未创建。原 End、
Stop 和资源清理通过，生产及脚手架在运行期间保持冻结。该候选仍为失败。

构建报告 SHA256：`7ea5319e1353ed2f669473b59fb8cd326198e923125118993c5eb712e044ecc6`。
原结果 SHA256：`2135a59e9d0c39b74b741dfdd9a3adc9979b109935120b3e23f781e21e44bdc4`。
独审 576 项通过，SHA256：`51d8778663fb582cffe9f8c6720af91111acf054adf4b86e5befe84da599e32c`；
这只核实失败及其来源，不将超时改判为成功。

## 原命令结算与重复登记原因

同一候选生产代码配合原命令观测器执行 `mof-TfWLh1`，实际退出 1，原
`goBack` 再次超时。观测器返回原 Promise、值和异常，只记录原调用的发送
与结算；事件及回执使用共同顺序。它不新增原生命令，但观察回调自身有微任务
开销，因此顺序只描述这场 worker 的观察结果，不等同 Chromium 内部因果。

原 child 准备 tree 在顺序 253 完成，根恢复为 268，根恢复 tree 回执 270，
child 初始 tree 回执 273，恢复专用 child tree 回执 289。child 初始化命令
全部成功；之后没有 root/child 的 lifecycle 刷新命令。此场观察 114 次原命令，
两次返回前的旧 context `releaseObject` 失败保留；其余 112 次成功。

提取同一冻结 vendor 的真实方法纯执行确认：恢复控制器先创建 child Frame，
再调用 `_handleFrameTree`，后者再次登记自身 root，触发真实
`FrameManager.frameAttached` 的重复 ID 断言。缺失和已存在的 child 两支均
在导航登记及 readiness 前失败。原命令记录未含内部异常栈，这一具体原因
由相同生产方法的确定性复现支持；此前测试替身覆盖 Map，遗漏了底层断言。

诊断原结果 SHA256：`a18ce3e3d954f1aa4afbcbbc431392cb4a78e471327c8a7d540b35cc1045e60a`。
构建报告 SHA256：`b917ab0ec279da60ab16968d115428b2321222809fe5b35c15d8f084f95941fa`。
独审 589 项核验通过，SHA256：`3408065c6e75f2d387d8423a23f6ef0d8946a61fd69b17965bdf22c712ad0b8b`。
停止时零未结算命令、零观测错误，原命令函数与监听状态均已恢复，私有资源清理通过。

## 最终修复与成功验收

控制器在创建或找到原 child root Frame 后，只对它执行原导航登记，再用
`_handleFrameTree` 处理实际本地后代。保持原 CRSession/FrameSession 的
一次创建和初始化；原初始化 tree 跨越 Frame 替换时只保留本会话的加载监听，
已校验的原树负责 readiness。原 context 清除、session 退役及旧 detach
仍阻止迟到工作影响新会话。测试直接执行 pinned 方法及重复 attach 断言，
覆盖未初始化、已初始化但旧 Frame 被删除、晚到回执及本地后代。

最终构建 `mob-build-6u_o0xn0` 的 3388 项 Node 检查通过。474 份构建输入、
80 份扩展文件有冻结副本；351 份 Go/嵌入 UI/SDK/锁文件与原构建相同，
复用原 Go test/vet 日志和 EXE，没有重新执行 Go 的声明。
报告 SHA256：`44b09f337a16fa8c7b3325b25cd3dbf185936c992d16270f31c50a69c3d14c45`。

`mof-VPH3Kd` 实际退出 0：16 次公开 SDK 调用全部成功。两页原 documentId/
token、草稿和可信 persisted 生命周期保留；返回后快照包含两 frame，原 iframe
唯一 POST 的 1142 字节及回执摘要一致。三个原 GET、一个原 POST，没有重载
或输入重放。child、root 的最终 lifecycle 刷新各自收到真实 ACK，原 load
在其发送与回执之间到达。命令观测保留两次返回前的旧 context 释放错误，
没有把它们改判为成功。End、Stop、16 个原进程及私有资源全部清理。

原结果 SHA256：`cc4ee47d7755c936a011cf29d85f066529b96efbeb89dd090c18929957e503b1`。
独审 617 项通过，报告 SHA256：`2ebdf50e0c7ed2ead74d5cbc21f78b43819b83b99b152e81c571ad14e7a77fd9`。
返回的 leaf 没有新的 `frameNavigated` 事件，该字段仍标未观察；独立的原
`getFrameTree` 回执和 lifecycle payload 提供原 frame/parent/loader 证明，
不能把两种来源混写。

同构建的既有正式下载场 `managed-download-r63pIp` 实际退出 0，覆盖八个
原下载、native 取消、仅取消等待后原传输继续完成，以及正常停止清理。
原结果 SHA256：`cad5cf68629d12e1881c9c43762b5a043b195f23eca9b593fcc3f2589a1da181`。
该旧 runner 未加载新构建 manifest，其 caller-supplied 标签保留；运行扩展/
SDK/EXE 与最终构建另作字节比对，不能称该 runner 自行验证了全部构建输入。
独审 138 项通过，报告 SHA256：`f489bb4141fd9e07740dd507d93dcfd3b596d381e5d00a585a8b4f5a91595a2d`。
该场冻结 717 份源码，与最终 474 份构建输入有 332 份直接交集；另核 80 份
扩展输入、26 份 SDK 输出和 EXE。launcher 私有扩展副本的 78 份原字节不变，
其 manifest 公钥及本次 Native Host 配置按实际运行身份分别验证。

本项已完成开发验证，尚未打包。完整 Browser Use 对齐目标保持进行中。
