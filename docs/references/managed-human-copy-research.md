# 人工复制和剪切的机制研究

当前生产查看器已有本地文字粘贴，但没有把人工Ctrl/Meta+C/X的结果返回本地
的通道。本次只完成机制研究，没有实现复制桥；用户再次要求新包后，先收口
并交付已完成的生产功能。完整目标和[实施计划](../exec-plans/active/2026-10-19-managed-human-copy.md)
仍开放。

## 本地写入可行，远端事件读取不完整

[正式本地诊断](../../scripts/browser-integration/managed-clipboard-local-probe.mjs)
在原可信Ctrl+C/X的keydown内立即调用`clipboard.write`，为ClipboardItem提供
尚未完成的Promise。之后确认的Unicode多行文本可写入；拒绝Promise则保留
原合成seed。`clipboard-local-qbb9xe`三场实际退出0（`8c1962`），原生paste
核对结果，8个原进程身份正常退出。没有预授予permission，也没有正式远端桥。
结果SHA256：`d1927418c505e9a0c0c8b301dfd5133c5ec84c9d211ac35e5407e0d90db738d4`。

远端原事件诊断`native-kgC8GL`实际退出0，11场、69条原事件证明：

- capture中的微任务可早于网页处理器；window冒泡及其微任务后仍可有网页改写。
- 网页`stopImmediatePropagation`可屏蔽部分或全部隔离世界监听器。
- 原按键ACK后，保存的ClipboardEvent仍有取消状态，但DataTransfer已不可读。
- 默认copy事件的数据为空；默认cut完成后原选区也已删除。读取selection不能
  替代完整原生复制结果。

这与固定[ClipboardCommands实现](https://chromium.googlesource.com/chromium/src/+/f842f52ef39fd97b449eb27cff414bf05a98ddce/third_party/blink/renderer/core/editing/commands/clipboard_commands.cc)
一致：默认选择文本在事件派发后写入，事件DataTransfer随后失效。原事件报告
SHA256：`50e5f5a6d30f6dba44207bbb59a396354d141780925e47368b115799cdff9dc5`。
更早`native-tviJmU`的夹具顶层const重复失败保留，不算产品失败或成功验收。

## 浏览器共享剪贴板的版本检查

固定Chromium 156.0.8078.4的[ClipboardItem实现](https://chromium.googlesource.com/chromium/src/+/f842f52ef39fd97b449eb27cff414bf05a98ddce/third_party/blink/renderer/modules/clipboard/clipboard_item.cc)
在lazy item的`getType`查找类型和返回缓存前复核原clipboard版本，实际格式读取
完成时也复核。对一个不支持的私有MIME，原版本返回NotFoundError，版本改变
返回InvalidStateError；无需读取旧item的文字。新item读取后还须复核同一对象。
这依赖固定实现，不能对任意浏览器只凭API存在就广告能力。

18个不同原生C/X动作分三个独立run完成观察：

| 原run | 实际退出 | 已确认事实及失败边界 |
| --- | --- | --- |
| `version-3Va3wl` | 1（`16a36f`） | 前10场通过：input/textarea/document、网页自定义、阻传播、后置覆盖、无选区、keydown取消及同文本两次复制。第11场发现取消但无setData不改变版本，推翻原错误预期。 |
| `version-supplement-DErgRC` | 1（`b3272d`） | 五场剪切通过；新增显式空文字copy使版本改变，但新types为`[]`，推翻原预期的text/plain空Blob。 |
| `version-race-ftjoH7` | 0（`6e8355`） | 补完显式空文字cut及两种版本竞争；未重复此前C/X。 |

无setData的取消使底层writer没有格式可提交；显式空文字仍创建写入对象。
固定[ScopedClipboardWriter实现](https://chromium.googlesource.com/chromium/src/+/f842f52ef39fd97b449eb27cff414bf05a98ddce/ui/base/clipboard/scoped_clipboard_writer.cc)
解释了这一区别。原数据也确认：cut的beforeinput取消可以阻止删除，但复制写入
已经发生；剪切编辑结果不能仅由clipboard版本判断。

两种竞争分别证明：另一合成tab在原Blob读取后写入，原item末次检查拒绝交付；
另一原生写入在`getType`尚未完成时确认，原读取实际以InvalidStateError拒绝。
相同文字连续复制也分别改变版本，不能用文字变化代替版本身份。

原报告SHA256，按上表顺序：

- `004e0b4bce69dbaf10e9c833570cdfa74f78835e2016089bd6f35a249d75fe50`
- `fbc3243974adf81b113537cadc526f7a1f85b1e996c69a4881016ed9dbc0a860`
- `fe8997cf2ed7dc3c7c40d3fa19527687c57371df8e1651dd976919e40f27ffb6`

聚合研究核对116项事实，SHA256为
`d2a484a1f2a3466814a37c763ed646e6db8712a9de051acf1dc66be423e6c3ee`。
它没有把前两次原退出1改成成功。三个浏览器均正常退出，分别记录的10/9/10个
原进程身份均消失，无强制清理。

## 产品契约和未完成工作

这个机制只识别**原managed浏览器共享clipboard的版本**。另一页面或writer也
能改变它，版本变化不证明来源标签页、iframe、origin或该次C/X的因果关系。
原快捷键仍须独立绑定human lease、generation、sequence及实际ACK；旧版本
未变时不得把旧文字填入本地写入Promise。新空版本须与无写入、非文字格式区分。

若实施，需要有界地保留旧item和新item、实际读取与本地Promise；End、导航、
失焦或未知结果应停止发布并等待原工作结算，不能重发C/X或模拟删除。最后一次
成功版本检查只证明该时点的快照，并不承诺之后clipboard不会再次改变。

所有诊断均在唯一合成profile、固定headless内存clipboard内进行。隔离依据是
原[HeadlessClipboard初始化](https://chromium.googlesource.com/chromium/src/+/f842f52ef39fd97b449eb27cff414bf05a98ddce/chrome/browser/headless/chrome_browser_main_extra_parts_headless.cc)
和仓库的[memory clipboard guard](../../scripts/browser-integration/memory-clipboard.mjs)，
不是“不同profile天然隔离系统clipboard”。远端版本诊断仅向原合成loopback
origin授予读写权限；本地正式诊断不预授予权限。没有系统clipboard读写或恢复。
生产通道、权限/focus集成、iframe/OOPIF、真实硬件快捷键、公司Edge和完整能力
对齐仍未验收；当前包不能宣称已支持本地复制/剪切桥接。
