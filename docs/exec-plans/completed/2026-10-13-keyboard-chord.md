# 完整组合键校验与失败清理

## 目标

继续P01–P15完整Browser Use对齐，修复P06中已复现的无效组合键副作用：
`Control+DefinitelyNotAKey`先发送Control down、随后抛错，后续普通`a`
携带Control且不产生文本。不得以重启或后补点击掩盖该输入残留。
完整目标、P12焦点缺口及普通Edge人工验收保持开放。

## 范围与约束

- 在固定Playwright CRX的实际Keyboard.press入口复用其解析与键描述校验，
  完整组合键有效才发送首条Input；keyboard.press及locator.press共同覆盖。
- 无效参数保持零原生输入，不改变既有预持按键/修饰键，也不为了校验失败
  释放整个附件。合法键名、别名、加号和现有成功press语义保持兼容。
- 部分原生命令失败与仅参数错误区分。原deadline、attachment、控制范围
  和真实native completion仍决定清理，未知状态不得继续发送普通输入。
- 不重放已提交按键，不误释放继任附件；保持fill Delete私票、pointer
  modifier恢复及暂停/控制结束清理兼容。
- 仅root启动隔离测试浏览器；不移动系统鼠标，不碰用户日常profile。
- 不重新打包已交付preview，不提PR；验证后提交并推送用户fork。

## 里程碑

1. [x] 核对当前HEAD、前轮进度与固定上游错误证据。
2. [x] 保留可重现红例，确定参数错误/部分提交的错误与清理边界。
3. [x] 实现及单元覆盖有效语法、零输入失败、预持键、native失败/晚ACK/继任。
4. [x] 真实浏览器root/OOPIF及键盘/locator入口验证原事件、后续输入和业务提交。
5. [x] 完整相关回归、独立证据审计、文档/history同步，提交并推送fork。

## 进度与决定

- 2026-10-13：前一轮有实质进展，fill修复和证据已推送，当前HEAD
  `e6db779`且工作树干净。保留所有历史失败与原preview；本轮继续独立键盘缺口。
- 原固定Keyboard/RawKeyboard与共享tracker VM证据已证明无效组合键后
  Control残留，随后`a`的native modifiers=2、text为空。该证据不是实机验收。
- engine子代理负责固定上游补丁及构建测试，backend代理先只读确认清理契约；
  root负责验收、编排与文档。测试进程只以真实终态判断，不因观察超时重启。
- 2026-10-13：完整预校验INVALID和未开始的admission REJECTED保留原状态；
  已开始后的UNCONFIRMED清理原attachment。键名/cause可包含错误码的独立
  反例已修复，以最外层首个keyboard分类决定是否清理；红例actualexit1保留。
- 2026-10-13：build265/265、extension1233/1233、integration1376 pass/
  1既有Windows symlink skip，全部actualexit0，无fail/cancel。生产与fixture
  冻结后专项`l3BraN`9/9 actualexit0，源/运行时哈希不变；keyboard9内部场，
  五invalid阶段0Input、两受控partial均原keyup后明确失败，原期限后250ms
  无重放；九后继工作流准确POST共36074B，九原tab/target清理。
  74999ms零activation/focus/新增许可。
- 2026-10-13：完整`BGZwxy`130/130 actualexit0，旧129名称/顺序保留，
  源/运行时冻结哈希不变。九键盘场再次9POST/36074B、32原生命令，五invalid
  零Input、两partial原keyup后失败且显式恢复成功，九原tab/target清理。
  350576ms仅原12activation/4controlfocus许可；原host按既有restart场故意
  终止，确切继任exit0、全部连接关闭。root和独立backend复审均通过；后者
  逐核原字节/事件、372源/运行时身份、focus许可和实际进程清理，无阻挡。
  文档、仓库卫生、Action固定SHA及diff检查通过。
  完整P01–P15、P12及普通Edge人工验收仍未完成。
- 2026-10-13：实现及完整证据提交`49b63ea`已推送用户fork的
  `codex/browser-use-parity`，远端完整SHA复核一致。本分片完成并归档；
  总目标保持active，不创建PR、不替换已交付preview。
