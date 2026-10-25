# 交互协议 v2：坐标映射、能力协商与编辑器输入（设计与实现记录）

摘要：本文件记录交互协议 v2 的增量设计、根因修复与实现结论。线协议保持版本 2，全部新字段向后兼容（旧 producer/旧 client 走原行为）。目标读者：维护 worker（godot/platform/windows/dsh_*）、客户端（src/client.js）与上游校验器（deepseek-harness-3d apps/desktop/src/native-viewport-protocol.ts）的工程师。

## 1. 根因诊断（修复前）

1. **坐标系错配（点击偏右偏下）**：client.js 上报物理像素尺寸 + 单一 `scale`，worker 用物理尺寸设置引擎窗口，但 `_inject_pointer` 把事件里的 CSS 坐标直接 `set_position()`，从未乘 scale。DPR>1 恒偏；DPR=1 时窗口超过 2048 触发 `2048/max` 钳制后同样出现"要往右下偏才能点中"。引擎 UI（Control 命中）与 3D 场景同源错位。
2. **resize 瞬态与风暴**：每个 ResizeObserver 回调立即发 resize；worker 每次都要等全部 slot 租约释放 + GPU stall + 重建 D3D11 池 + epoch 推进。拉伸过程中引擎仍是旧几何，client 已用新 rect 映射指针 → 瞬态点击错位。无 DPR 变化监听。
3. **右键/中键透传与前台手势冲突**：未 `preventDefault` contextmenu、未抑制 selectstart/dragstart、无 `user-select:none`；pointer 事件未 `stopPropagation`；demo 控制器本地 `dragging` 标志在失焦后不清（`release_pressed_events()` 不会清本地标志）；cancel 事件 `button=-1` 时提前 return，释放分支不可达。
4. **协议缺口**：resize 只有单一 scale，无法逐轴逆映射；无"已应用几何"回执；hello/attach 无能力协商；文本/IME、指针锁定没有接入路径。

## 2. 协议增量（规范）

### 2.1 坐标系约定

- 指针/滚轮事件 `x,y` 恒为**视口局部 CSS px**（左上原点，y 向下），与协议 2 一致。
- resize 携带双坐标系：`width/height` = 物理渲染像素（0..2048，0=暂停）；新增 `cssWidth/cssHeight` = 发出时视口 CSS 尺寸（成对出现，有限，0<x≤16384）。
- worker 在**应用 resize 的那一刻**锁定逐轴映射因子 `mapScaleX = width/cssWidth`、`mapScaleY = height/cssHeight`，与 epoch 建立同点生效；所有指针/滚轮坐标 `(x*mapScaleX, y*mapScaleY)` 进入引擎。缺少 css 字段的旧客户端回退用单一 `scale`（graphics101 兼容行为）。
- `surface` 消息回显本次应用的 `cssWidth/cssHeight`，构成"已应用几何"回执。

### 2.2 控制消息增量

```
{ kind:'resize', width, height, scale, cssWidth?, cssHeight? }
{ type:'pointer', phase, ..., movementX?, movementY? }   // 指针锁定期间的 CSS px 增量
{ type:'key', code, down, repeat, modifiers, key? }      // key = DOM 单字符,需要 input.text 能力
{ type:'text', text }                                    // 需要 input.text 能力
{ type:'ime', state:'start'|'update'|'commit'|'cancel', text?, cursorStart?, cursorEnd? }  // 需要 input.ime
{ type:'drop', x, y, paths }                              // 需要 input.drop 能力
```

`key.key` 携带 DOM `KeyboardEvent.key` 的单字符（代理对按 2 个 UTF-16 单元计,校验器放行 1..2）：worker 将其设为 `InputEventKey::unicode`。文本框（LineEdit/TextEdit）只在 `unicode >= 32` 时插入字符,仅 keycode 驱动快捷键——这是"快捷键能用、输入框没响应"现象的根源。客户端仅对"按下、非 repeat、单字符、无 ctrl/meta/alt"的键附加该字段,快捷键因此不会双重生效。

`drop` 报告操作系统文件拖放：`paths` 为 Desktop 桥（`webUtils.getPathForFile`）解析出的绝对磁盘路径（≤64 项、每项 ≤4096 字符）,`x/y` 为 CSS 像素落点。worker 先在落点注入一次 motion（编辑器按当前鼠标位置解析拖放目标）,再经 DisplayServer 的 drop-files 回调分发（Window::files_dropped 信号链）。

### 2.3 能力协商

- worker `hello` 增加可选 `features: string[]`（小写点分名，≤16 个，去重）。本 worker 声明：`interaction.map.v2`、`input.text`、`input.ime`、`pointer.lock`。
- Desktop broker 校验 hello features 形状，存入 Viewport，`attach()` 结果原样携带；`isNativeViewportControl` 增加第三参 `features`：resize 的 css 字段、text/ime 事件按能力放行，pointer 的 movementX/Y 只做有限数校验（能力由指针锁定语义隐含）。
- 无 `features` 的 hello（graphics101）→ 空能力集 → 全链路旧行为。上游 broker 同时校验 worker `surface` 回执中的 css 几何（有限、正值、≤16384）。

### 2.4 指针锁定 / 相对鼠标模式

- 复用 extension 通道新增下游命名空间 `godot.viewport.v1`（协议 2 原生支持 versioned namespace，无需改上游校验器白名单）：`setRelativeMouseMode { value: boolean }`、`setRightDrag { value: 'pan'|'none' }`。
- client 在具备 `pointer.lock` 能力时提供锁定按钮；锁定后 `requestPointerLock()`，move 事件附加 `movementX/movementY`（CSS px）；`pointerlockchange` 退出时回发 `setRelativeMouseMode:false`，引擎侧同步清除相对模式并释放输入。
- worker 侧 `DisplayServerDSH::mouse_set_mode` 从空实现改为存储模式（`mouse_get_mode()` 返回真实值，编辑器 freelook 依赖）；motion 事件优先采用 movementX/Y 映射增量，否则用位置差。
- **命名空间必须注册**：`godot.viewport.v1` 已加入 producer extensions（manifest/stage/hello 三处一致）。上游 broker 对 client→worker 的 extension control 与 worker→client 的 extension event 都按注册命名空间白名单校验,漏注册会在真实 Desktop 里直接 `Invalid native viewport control` fail 挂载（假 broker 直连 worker 不会暴露这一问题）。
- **imeState 下行事件**：`{ type: 'extension', namespace: 'godot.viewport.v1', name: 'imeState', payload:{ active, x, y } }`（引擎物理坐标）。引擎 LineEdit/TextEdit 聚焦/失焦与光标移动时经 `window_set_ime_active/position` 触发;客户端据此摆放隐藏 IME host（见 §4）。

## 3. 客户端策略（无协议改动部分）

- **手势抑制**：canvas 上 `contextmenu`/`selectstart`/`dragstart` preventDefault+stopPropagation；CSS `user-select:none`（含 -webkit-）与 `touch-action:none`；`pointerdown/up` stopPropagation（保留手动 `canvas.focus()`）。
- **resize 去抖**（`src/interaction-map.mjs` 纯函数模块）：尾随 120ms 合并连续变化；首帧立即发；回到已应用几何时撤销挂起发送；`window resize` 与 ResizeObserver 回调中检测 `devicePixelRatio` 变化并强制立即 resize。
- **瞬态重映射**：记录 `appliedSurface`（surface 回执）与挂起 resize；pending 存在期间指针坐标按 `applied.css / currentRect` 逐轴换算（引擎随后用它锁定的旧因子相乘，合成结果等价于"点击落在拉伸呈现的视觉点上"），surface 回执到达后恢复恒等映射。无 `interaction.map.v2` 能力时禁用（旧行为）。
- **文本/IME 管线**：`compositionstart/update/end` → `ime` start/update/commit（合成期间按 Escape 判 cancel）;`beforeinput`（insert* 且非合成,如粘贴）→ `text`。键盘转发已 preventDefault,可打印键不会与 beforeinput 双重插入。
- **隐藏 IME host（CJK 输入法必需）**：Chromium 只对可编辑元素启动系统 IME,`<canvas tabindex=0>` 永远无法组词。worker 上报 `imeState` 后,客户端在引擎光标处（物理坐标经 appliedSurface 换算为 CSS）放置 2px 透明 `textarea`（`pointer-events:none`、opacity 0）并聚焦——系统候选窗自然锚定在引擎光标上（Godot web export 同款方案）。合成期间按键（keyCode 229 或 composing）不再转发引擎,IME 独占;失焦经 canvas blur 守卫与引擎 `active:false` 双向平衡;dispose 时移除。
- **文件拖放意图路由（默认开）**：canvas 的 dragenter/dragover/drop 拦截（preventDefault+stopPropagation,宿主 DSH 的 document 级 drop 监听因此收不到）——文件落进视口即解读为导入 Godot 而非宿主。路径经 `dshDesktop.fileDrag.getPathForFile` 解析,随 drop 控制消息发给引擎;拖入时 canvas 高亮虚线框。工具栏复选框「拖入文件导入 Godot」可关闭（关闭后落回宿主导入流程）,localStorage 持久化。
- **demo 按钮语义**（写入 help 文案）：左键拖拽=环绕；中键或 Shift+左键或右键拖拽=平移；滚轮=缩放。

## 4. Worker 实现要点（godot/platform/windows/dsh_viewport_worker.cpp）

- 映射因子 `map_scale_x/y` 在 `_apply_pending_resize()` 中与 epoch 同点锁定；`_inject_pointer`/`_inject_wheel` 统一走 `_map_css_to_engine()`；wheel 使用事件自带坐标。
- **cancel 修复**：任何 `phase=cancel` 先 `_release_all_input_state()` 再 return，不再依赖 button 值。
- **失焦释放**：`release_pressed_events()` 在 `application_focused=true` 时整体早退、且从不清理鼠标按钮掩码。worker 通过 `MainLoop::NOTIFICATION_APPLICATION_FOCUS_OUT`（SceneTree 是 Input 的友元，这是唯一合法路径）驱动标志翻转 + 按键释放，再显式合成各按下按钮的 release 事件清理掩码（真实 OS 在失焦时就是这么补发 button-up 的）。focus/visible:false/cancel 三条路径统一走 `_apply_focus(false)`/`_release_all_input_state()`。
- **指针事件补全**：motion/button 事件设置 shift/ctrl/alt/meta 修饰位（此前 modifiers 只在键盘事件生效，导致 Shift+左键平移失效）。
- **文本注入**：Godot 4 无专用文本事件,按码点合成 `InputEventKey`（unicode=码点,press+release,release 用 duplicate 避免同帧重复解析告警）;`\n`→ENTER、`\t`→TAB。
- **键字符注入**：`_inject_key` 从 `key` 字段设置 unicode（JSON 转换已将代理对合并为 char32）。
- **IME 状态下行**：`DisplayServerDSH::window_set_ime_active/position`（原内联存储）改为外联定义并触发 `dsh_notify_ime_changed()`,经 `worker->emit_viewport_extension("imeState", …)` 下发（非 DSH 构建有 `#else` 兜底定义）。
- **文件拖放注入**：`_inject_drop` 先在落点注入 motion,再把路径打包成 `Vector<String>` 走 `DisplayServerDSH::dsh_dispatch_drop_files`（存储 `window_set_drop_files_callback`,替换原空实现）。`lastDropPaths` 进 query 状态供假 broker 断言。
- **IME 注入**：`DisplayServerDSH` 覆写 `ime_get_text()`/`ime_get_selection()` 保存预编辑串与光标范围，`start/update` 写入并 `MainLoop::NOTIFICATION_OS_IME_UPDATE` 传播（LineEdit/TextEdit 收到后重查）；`commit` 清预编辑再走文本注入；`cancel` 清预编辑。`window_set_ime_active/position` 从空实现改为存储（编辑器聚焦 LineEdit 时会调用）。
- **demo 控制器**：`dragging` 不再本地缓存——每个 motion 事件从 `get_button_mask()` 推导手势（左键=环绕；中键/右键/Shift+左键=平移），`capture_state()` 直接读 `Input::get_mouse_button_mask()` 作为权威状态（失焦释放后必然归零）。平移引入 `target` 向量，相机 `look_at(target)`。
- **测试钩子**：`godot.demo.v1` 新增 `query` 扩展（worker 回发 `state` 扩展事件：yaw/pitch/distance/target/lastPointer/mouse/buttons/dragging），供假 broker 黑盒断言坐标映射、按钮语义与失焦清理。`Input::flush_buffered_events()` 在采样前强制冲刷累积队列，保证时序确定。

## 5. content-scale spike 结论（Phase 2 评审项）

计划要求评估 DisplayServerDSH 的 content-scale 感知（window content size = CSS、real size = 物理，使编辑器 UI 度量与前台 CSS px 一致）。

**结论：本期只落地无风险的一半，窗口 content-scale 模式切换延后到编辑器里程碑。**

- 已落地：`screen_get_scale()`/`screen_get_max_scale()` 返回 `mapScaleX`（物理 px / 逻辑 px，clamp [0.25,8]；未钳制时即真实 DPR），`screen_get_dpi()` 返回 `96*scale`。窗口坐标为物理像素、逻辑尺寸 = 物理 / scale = CSS 尺寸，编辑器 UI 度量与前台 CSS px 一致。这影响 editor 的 EDSCALE 等基于屏幕 scale 的度量，方向正确且对 demo 场景无影响。
- 延后项：把根窗口切到 `CONTENT_SCALE_MODE_CANVAS_ITEMS` + `content_scale_factor`。未切换的原因：Godot 的 OS 鼠标坐标 → Viewport 坐标变换依赖 content_scale_mode 的内部假设（canvas_items 下 GUI 命中使用缩放后坐标系），而本链路注入的是**物理**窗口坐标；在 spike 未把"输入坐标 ÷ content_scale"的完整闭环验证清楚前切换，会把命中测试从"物理坐标系一致"变成"双坐标系混合"，风险大于收益。编辑器里程碑做端到端验证后再开。

## 6. 风险与开放问题（实现后更新）

- 瞬态重映射在 worker 长时间不应用 resize（租约未释放）期间持续按比例换算：行为正确但非 1:1，`godot:verify` 的 surface 回执断言 + 手工验收矩阵覆盖体验确认。
- 指针锁定 ESC 退出语义在 Electron 与浏览器间有差异：client 以 `pointerlockchange` 为准双向同步，Desktop 容器内实测列入验收矩阵。
- `release_pressed_events()` 的早退语义（`application_focused`）属于引擎私有状态，worker 只能经 FOCUS 通知驱动；若未来引擎改该语义，失焦释放路径需回归。
- graphics101 旧 producer 不回 features：校验器默认空能力集，全链路旧行为由上游 validator 测试与 verify 的 legacy 分支覆盖。
- 多 GPU/LUID、2048 配额、4 槽租约为协议既定，本期未调整。

## 7. 验收

- 自动化：`pnpm run godot:verify`（runtime，8 步，含 coordinateMapping：css≠phys 映射、wheel 坐标、右键/Shift+左键平移、movementX 增量、失焦清拖、cancel 修复、setRightDrag、键字符 unicode 断言（`key:'n'`→lastUnicode 110、无字符键保持 0）、drop 路径断言（lastDropPaths 回显）、legacy 回退）；`pnpm run godot:verify:editor`；`node --test tests/interaction-map.test.mjs`；上游 `vitest apps/desktop/tests/native-viewport-protocol.spec.ts`。
- 手工验收矩阵：`doc/acceptance/build-and-package.zh.md` §1.7。
