# Managed 人工接管的 Enter

普通字符的控件、快捷键和取消语义见[普通字符按键](managed-human-printable-keys.md)；
以下保留 Enter 专项的原契约与历史验证范围。

## 原缺口与修复

原人工接管把每次按下都映射成 rawKeyDown。固定 Chromium 的该路径不产生
keypress，并跳过换行类编辑命令。原生基线 `native-baseline-pVjLbA` 使用原生产
mapper 的一次 Enter down/up；两个实际 ACK 之后，原 textarea 仍为空，只收到
可信 keydown/keyup。换行断言实际 exit 1，原失败与完整清理记录保留。

当前源码仅在 key 为 Enter、code 为 Enter 或 NumpadEnter、虚拟键码为 13，
且没有 Control/Alt/Meta 时，将原 down 映射为携带 CR 的单次 keyDown。
Shift 保留。网页能继续通过 keydown.preventDefault 阻止默认行为；原浏览器
负责 textarea 换行、contenteditable 段落/换行及单行表单的隐式提交。
不追加 insertText，不发送独立字符命令，不重试原输入。

原 held-key 记录、权限、文档代次、输入预算与实际 ACK 保持。原 keyUp 和清理
keyUp 都不携带字符；导航或结束接管仍等待原实际调用，不从观察超时推断成功。
现有协议保留 NumpadEnter 的 code，没有新增 location/isKeypad 的硬件语义。

原生机制见固定版本的 [Editor 键盘处理](https://github.com/chromium/chromium/blob/156.0.8078.12/third_party/blink/renderer/core/editing/editor_key_bindings.cc)
及 [KeyboardEventManager](https://github.com/chromium/chromium/blob/156.0.8078.12/third_party/blink/renderer/core/input/keyboard_event_manager.cc)。

## 验证状态

原映射下新增回归的八项失败保留；修复后十项全部通过，相关控制器、输入跟踪、
预算及弹窗共 214 项通过。新的完整内部构建通过 Go test/vet 和 2,898 项 Node
检查，437 份源码输入与实际 EXE、77 份扩展文件绑定。

2026-10-19，固定 Windows Chromium 156.0.8078.12 的 `mhk-9zc3G0` 从正式
managed 入口完成七步流程，实际 exit 0。新构建中的七场页面行为均通过：

- textarea 的 Enter、Shift+Enter 和 NumpadEnter 各增加一个 LF。
- contenteditable 的 Enter 产生原生段落，Shift+Enter 产生原生换行；原始
  HTML 分别保留为末尾 div/br 与 br/br，没有以 textContent 猜测布局。
- 网页取消 Enter 默认行为时，只有原 down/up，内容不变、没有字符或编辑事件。
- 单行表单由原 Enter 隐式提交一次，原 POST 1,003 字节；没有额外 text 请求。
- 原独立 handoff 继续完成持 Shift 的 End、明确 Resume、新轮次及同文档唯一
  299 字节 POST。两个表单分别核唯一提交，不把它们混称一个业务请求。

全页账本核七对 Enter down/up、六次 keypress、五次 input 和一次 submit；
结束前后及另一任务完成后，原键盘页事件不再增长。全部输入的原请求和精确
ACK、完整租约账本及停止后的最终 HTTP 记录都参与判定，覆盖逐场采样间隙。
28 项验收脚本检查通过。结果 SHA256 为
`7e6c307b84a3efdad49e760386db12b1db164fcc9026077907254a39ae466d73`。

独立核验实际 exit 0：事件410项、生命周期122项通过；58张PNG完整解码，
29个原进程身份均已退出，Browser/Native/查看器退出、Job归零、两注册视图、
管道和 endpoint 清理均通过。原始 Native FILETIME 按整数核对，没有丢精度
的 JavaScript Number 连接。生产与验收源码、EXE、扩展和原结果没有漂移。

事件审计 SHA256：`a4298e0d34ad54f3b10a6e02d6892b28e843d62dab7d8aef9a9fc40c1cdbbc2b`；
生命周期审计 SHA256：`5c143f471a6a315d8c482d6af1d568ec73a9396ac42f70aa8e52fa68a5594d98`。
首轮独审误套旧 fixture 的 beforeinput 字段及另一种 Node reporter 前缀，失败
记录保留；按当前原 input 事件与日志格式核对后，新 v2 审计通过。未重跑网页
业务、修改原结果或放宽输入/提交判据。原独立原生失败基线另有30项独审通过。

## 复用入口与边界

设置匹配源码与构建的 OBU_TEST_HOST_BINARY、OBU_TEST_EXTENSION_DIR、
OBU_TEST_CHROMIUM_BINARY、OBU_TEST_BUILD_MANIFEST；以
OBU_TEST_HUMAN_SCENARIO=keyboard 运行 scripts/browser-integration/managed-human-check.mjs。
七场编辑保留原 DOM 事件、精确回执、同文档与原隐式提交；独立原 handoff
继续验证持键 End、明确 Resume、唯一提交及 Stop。

本片不证明长按重复键、系统输入法/候选窗口、本地复制桥接、公司 Edge 或全部
P01–P15。本修复已进入 [preview-20261019-99c1be1](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261019-99c1be1)，从干净99c1be1重建配套主机与扩展。
437份输入与上述已测快照及提交对象一致，77份扩展与实测字节一致；
离线CLI/MCP、独立制品审计、四资产回下载和本地副本核对通过。
上述真实浏览器验收使用内部冻结构建，发布EXE单独重建，打包未重跑网页业务。
