# 人工接管的文件选择与上传

## 目标与当前缺口

完整Browser Use对齐继续。现有Agent上传已具备正式文件选择与直接设置文件
能力；缺的是用户在managed查看器中接管后，点击网页上传控件的后续通道。
当前human协议只有pointer/wheel/key/text及弹窗决策，查看器没有原文件选择
请求，也不能将用户选择的本地文件交给原网页。原发布运行时基线已确认一次
真实点击触发了原文件选择事件，但没有上传入口；不能把自动化上传验收
当作人工上传已完成。

本片交付完整流程：查看器原点击→显示原文件选择请求→本地选文件→传输→
原节点一次设置→End交回Agent→Agent稍后提交并收到原文件。保持后台运行，
测试不操作桌面鼠标或个人浏览器。

## 接口与生命周期

- 独立human chooser模块在当前已拥有的root/child attachment上观察原
  Page.fileChooserOpened，启用/关闭interception的实际Promise参加清理。
  复用原文档图谱及节点证明，不借用已暂停Agent的waiter权限。
- 查看器只见原lease/generation/chooserId、multiple与已证明来源；
  target/session/backendNodeId保留在私有模块。新页面不能复用旧请求。
- 本地input[type=file]只提交所选文件的名称与bytes，不允许网页指定绝对路径。
  通过有界、逐块确认的通道传入Go，在原managed Session私有目录暂存。
  复用既有命令32 KiB上限，文件数量和字节总量另行明确，不把路径限额冒充
  文件容量；完整文件准备好后才允许一次原生提交。
- 原生提交复用当前节点reservation、frame/context验证与
  DOM.setFileInputFiles。保留原ACK，不因超时、End或未知结果重发。
- 未dispatch的staging在取消、导航或End时清理；已dispatch或结果未知的
  文件归Session持有，直到实际浏览器退出。End后Agent或原网页可能仍读取
  File/FormData；不能提前删除而破坏后续提交。
- “取消选择”撤销原决策并保留原FileList。不能用files:[]代替取消，后者
  是设置空列表且可能触发编辑事件；未验证前不声称产生原生trusted cancel。

## 执行与证据

- [x] 用当前发布运行时、隔离页面和原查看器点击一次，保留缺失通道的真实
  失败基线；不额外开启interception来改变旧行为，不补点或重放输入。
- [x] 实现原chooser模块与明确状态、一次性选择/取消及原提交回执。
- [x] 实现查看器选择和Go暂存传输；结束会话后精确清理已持有文件。
- [x] Root单文件与OOPIF多文件完整流程，含空文件/同名文件；原字节、文件名、
  原节点事件与End后的唯一POST吻合，OOPIF必须有原child session证据。
- [x] 取消保持已有FileList；传输中End/导航拒绝晚到提交；已dispatch工作
  保留实际结算，Stop后实际浏览器退出再删除原暂存文件。
- [x] 修复验收发现的结果页重新认领移窗问题：仅对已验证的原 managed 结果
  保持原未分组窗口，独立 user 归属，不改变整个 session 的分组模式；
  重启、导航、移动及证明过期必须撤权。
- [x] 定向回归、真实生产链路和独立原件核对通过后更新文档。
- [x] 源码提交用户 fork，发布
  [preview-20261021-748af2f](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261021-748af2f)；
  干净重建、离线 CLI/MCP、制品核验和四资产回下载通过。

本地文件选择自动验收直接填充查看器原input，不操作OS文件选择器；这是文件
进入查看器后的产品通道验收。目录选择、更多平台和普通公司Edge仍需后续验证。
不创建PR，不将本片通过改称完整P01–P15或整体对齐完成。

## 基线与实施记录

最新冻结构建 `mso-build-4h3l_le5` 通过完整 Go test/vet、3,084 项 Node 检查，
460 份源码与 79 份扩展均已绑定。正式 `mfc-Xswpjy` 四步通过，原事件
1,393 项、生命周期/来源 128 项独审通过；原窗口、文档、字节和两次唯一
POST 均吻合。导航清理和重新认领移窗的原失败、诊断与修复记录见
[本片 history](../../histories/2026-10/20261021-0200-managed-human-files.md)。

基线 `mfc-AeLFhp` 完成且实际退出码 0；诊断结果为
`observed-native-chooser-without-upload-channel`，`featurePassed=false`。
原 root 的一次 trusted click、唯一 `Page.fileChooserOpened`、三次原
pointer ACK 匹配；诊断只增强原 attachment 的 Page 事件观测，未开启
interception。正式 End/Stop、26 个原进程退出和 7 张 PNG 独审通过，共
75 项；不能把诊断完成当成上传能力通过。页面还观察到 trusted cancel，
但缺少独立时间，不能归因于 End。

协议 v1 固定最多 16 个文件、单文件 32 MiB、一次 64 MiB、会话保留
256 MiB，16 KiB 原字节逐块确认。原 chooser 从 Opening 起最多 20 分钟；
Go Begin 后总期限 10 分钟，两者取早且不随块刷新。
文件名为最多 240 UTF-8 字节的有效 Windows basename；只承诺名称和
原字节，不承诺恢复本地路径、原 MIME 或原修改时间。重复文件名使用
不同内部目录，零长度文件也实际创建。

原 chooser 等待期间只允许释放已按下的原按键/鼠标，仍走原输入序列和
ACK；查看器等这些释放完成才启用本地文件选择按钮。不合成释放，不因
异步 claim 失去本地选择器所需的用户手势。窗口失焦例外仅绑定一次真实
选择点击及原 chooser，隐藏页面仍 End；原选择超时也 End。

三端首次冻结的 `mso-build-tko630wo` 全新构建通过，459 份源码输入、79 份
扩展绑定，Go 全量 test/vet 与 3055 项 Node 检查全部通过。
扩展定向 465 项、查看器 181 项、Go 三包
577 个测试事件与 vet、真实 bridge 夹具检查通过。Go 两处交叉审问题均保留
先红后绿：Close 不得吞掉暂存删除错误；文件提交触发导航后，已发出的原
Commit 仅按原期限继续等候 ACK，不重发也不扩大期限。清理依据原生资源
寿命，父页面跳转导致的权限失效不冒充子页面销毁。以上不替代真实浏览器上传验收。
