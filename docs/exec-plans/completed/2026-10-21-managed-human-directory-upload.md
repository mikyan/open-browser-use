# 人工接管的目录上传

## 目标与当前证据

继续完整 Browser Use 能力对齐。上一轮完成新包发布、制品独审与回下载，属于
实际进展。最近交付源码为 `805b1a8`，最新安装包为 `preview-20261021-805b1a8`；
交付记录提交为 `f9fd5cf`。本计划源码实现、正式验证和独立审计已完成。
用户再次要求打包；本轮将从包含此功能的干净提交独立制作新包，交付另记。
本片补齐人工接管网页的目录上传，不以专项通过代替完整能力对齐。

原基线 `ManagedHumanFileChoosers.observe` 明确拒绝原输入的 `webkitdirectory`，
并通过失败回调结束接管。查看器仅提供普通文件选择；Go 按索引分目录存放
同名文件，没有目录 manifest 或相对路径。已有 Agent 目录上传注册表可证明
原节点的可信 input，但人工通路尚未接入。先保留正式旧运行时的失败证据。

## 契约

- 新租约声明 `fileChooserVersion: 2`。新 Go 和查看器仍接受 v1 普通文件；
  v2 的 pending chooser 必须含不可变 `directory:boolean`，与 multiple 分开。
  旧客户端拒绝未知版本，主机与扩展需配套升级；不存在自动协商降级。
- 目录模式由已证明的原生节点决定。查看器通过原本地目录选择器取得文件，
  仅传名称、字节和 `webkitRelativePath`，不传用户绝对路径。
- manifest 的每条 relativePath 以 `/` 分段、包含一个共同根目录；每段沿用
  Windows 文件名约束，最后一段须等于 name。拒绝路径穿越、混合根、重复、
  逐级大小写别名和文件/目录前缀冲突，不静默规范化或合并。
- 沿用现有每次 16 文件、单文件 32 MiB、总计 64 MiB、会话 256 MiB 限额。
  相对路径额外有界，确保 Begin 不突破现有命令预算。目录包含的文件算入
  同一限额；FileList 不表示空子目录，不制造空目录或把零文件当上传成功。
- Go 在本次私有传输目录下保留原目录层级，原子拒绝冲突，保留排他创建和
  实际祖先路径检查。提交只交付这一棵自有树的根目录。
- 扩展复用 DirectoryUploadRegistry.submit，成功需要原 native ACK 和原
  节点可信 input；不能用普通文件分支的 ACK 替代目录枚举完成。
- 未提交传输在取消、导航、End 时撤权并等待实际磁盘操作后清除；已经发出
  提交的文件树保留到原 Browser 退出。未知结果不重试，清理未知不报成功。

## 实现与验证

- [x] 从当前源码确认显式拒绝及既有注册表可复用边界。
- [x] 新目录 baseline 使用原正式 launcher/viewer/SDK，保存真实 Opening、
  原点击回执、接管失败及实际 End 错误；featurePassed=false，真实 Stop 完成。
  FileList 后读因 End 断言失败而缺失，不能代替未观测状态。
- [x] 版本化状态、严格路径解析、私有目录暂存、原生枚举确认与查看器目录选择。
- [x] 有意义的协议、路径冲突、元数据变化、迟到结果和撤权单测。
- [x] 正式 root 与 OOPIF 目录上传：嵌套中文、不同目录相同 basename、空文件，
  核原 webkitRelativePath/字节；取消保持已有 FileList。
- [x] End/Resume、新 SDK 轮次和原页面认领后唯一 POST，证明 End 后仍可读取；
  传输中 End/导航清理与实际 Stop 的进程、注册、管道和目录清理。
- [x] 普通文件路径回归、完整 Go test/vet 与受影响 Node 检查、独立原证据核验。
- [x] 文档和 history 同步，纳入本次提交并推送用户 fork；新打包请求另行交付，不提 PR。

只有根代理启动自有隔离 Headless 浏览器。不给任务页直接赋 FileList，不用
脚本修改网页值或合成 DOM 输入替代正式链路；原生选择只发生在隔离查看器。
系统鼠标、个人 profile、公司 Edge 手动授权、真实 SSO 和 Windows 原生目录
框的桌面焦点均不在这次测试操作中。它们及全 P01–P15 继续保持未完成。

## 2026-10-21 打包请求时的开发交接

用户要求再打新包，本轮先交付干净 `805b1a8`，生产功能与已验证的 `79206b3`
相同。下列目录上传改动全部保留在工作树，不纳入该包，也尚未提交。

- 原正式 baseline `mfc-1kEEEz` 已确认目录请求被拒绝，实际退出 1；原三次
  指针输入均有 ACK，后续 End 返回 BACKEND_UNAVAILABLE。因 End 断言先失败，
  缺少后读 FileList，不能宣称已证明它保持不变。真实 Stop、27 个原进程退出
  和资源清理通过，原失败不覆盖。
- 扩展 v2 及目录 registry.submit 路径已写入。六文件定向检查 409/409，
  零跳过；不等同于浏览器验收。原日志为
  `.tmp/managed-human-directory-extension-tests-20261021-final.log`，
  SHA256 `04169dc4747963748d5695015884aa1cfc594347383d8942fdb2cf1fa5919b99`。
- Go protocol/storage/controller 七文件已写入，两个包 test/vet 通过，
  426 项、零失败和跳过。源冻结为 `.tmp/managed-human-directory-go-20261021/freeze.json`，
  SHA256 `06b916473cded7612c1e62628f0a6b7ec31b247450bb2079e824799ccb53f3e0`。
  共享入口是 `ValidateHumanFileMode(files, directory)`；staging 为
  `u/<transferId>/<relativePath>`，retain 只返回其唯一目录根。
- 脚手架已加入 `directory-baseline` / `directory-workflow`，保留普通四场。
  组合检查 48/48，后续受影响检查 13/13、目录检查 9/9；真实新验收未执行。
  新 baseline 会在 End 前读原 FileList，同时独立保留 End 的实际错误。
- 根代理尚未修改 `internal/managedviewer/ui/human-files.js`、`viewer.js`、
  `index.html`、`viewer.test.mjs` 和 Go viewer 的 `files.go`、`protocol.go`、
  `files_test.go`。这些仍只接受 v1，必须先接上 v2 再做完整构建与真实验收。
  UI 要用原本地目录 picker、逐段严格相对路径验证、固定原 directory 模式；
  Go viewer 要调用共享模式验证，并允许 directory=true 且 multiple=false
  的多文件目录。新版本必须拒绝缺失 directory，旧普通 v1 继续兼容。

目录功能计划仍在进行，不因这次交付或模块单测通过而标记完成。

## 完成验证

查看器已接上 v2 目录选择，Go viewer 使用原模式门禁并投影明确的
`directory:false`。UI 保留原名称、层级和索引字节，拒绝混合根、Unicode
simple-fold 别名与路径冲突；276 项 UI 和 268 项 Go viewer 检查通过。
交叉复核发现 `conın$` 的本地保留名规则差异，已对齐 Go 的大写比较，
36 项实际 UI/Go 对照一致。后续正式构建和真实浏览器验证如下。

扩展复核另发现目录原 native 发送前的异步门禁可能先被 End 撤权，而注册表
提前视为已发出，导致等待不会到来的 input/cancel。已把发送标记放在
最终准入之后、真实 native 调用之前；已发送未知结果仍须保留原等待义务。
原两项失败保存，修复后六文件 414 项通过；已发送未知结果仍等待原终态。


完整冻结构建 `mso-build-ow4285ux` 的 Go test/vet、3,326 项 Node 检查
通过，包含 276 项 UI，绑定 471 份生产输入和 80 份扩展文件。
正式目录 `mfc-nSCjTV` 和普通回归 `mfc-HSHFfg` 各四场、实际退出 0。
目录 root 为 multiple=true，跨站 OOPIF 为 multiple=false，均交付五文件
40,060 字节，原可信 input 早于提交 ACK。取消保留 FileList，End/Resume
与新 SDK claim 后唯一业务 POST；传输中 End/导航无提交且删除未提交树。

独立事件/业务审计分别 1,380/1,299 项，独立来源/生命周期审计 102/97 项
均通过；重新核对原源码、扩展、构建日志、浏览器、进程、注册、管道及目录。
根代理确认两张目录选择卡清晰。导航停止续传以查看器收到撤权为边界，原
native 导航到状态传播之间目录/普通分别有 7/6 个旧暂存 chunk，不扩大结论。
已提交树保留由离散哈希及后续 POST 证明，Stop 后总暂存消失；不声称连续
监测至 Stop 每一瞬间。整体 Browser Use 对齐、公司 Edge 与系统焦点仍未完成。
