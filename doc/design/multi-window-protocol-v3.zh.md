# 多窗口协议 v2.1（设计 + 实施记录）

> 状态：已实施（2026-10-25）。线协议保持版本 2：全部新增字段可选、增量、向后兼容。
> 上游规范见 `deepseek-harness-3d/apps/desktop/native-viewport.zh.md` 的"协议 v2.1"一节。

## 1. 背景与目标

两个症状驱动本增量：

1. **编辑器 FBX 导入预览弹窗不可用**。此前 `DisplayServerDSH::has_feature()` 对所有 Feature 返回
   false，`main.cpp` 因此强制 `embed_subwindows`：所有子窗口被嵌入主视口并被边界裁剪，超大对话框
   （Advanced Import Settings）错位，编辑器多窗口能力整体退化。
2. **Game tab 提示 "Game embedding not available on your OS"**。`GameView::_get_embed_available()`
   第一关 `FEATURE_WINDOW_EMBEDDING` 失败；且原生嵌入依赖真实 OS HWND 重定位，与无窗口 headless
   架构根本冲突。

目标：协议引入窗口维度（能力协商 `windows.multi.v1`）；子窗口获得独立 headless surface + 独立
帧环，客户端多层合成；游戏经第二个 broker session 运行，画面呈现在 GameView 覆盖层。

非目标：原生标题栏/OS 窗口拖拽、GLES3、真 OS 级 HWND 嵌入、runtime demo 场景语义变更。

## 2. 协议增量（v2.1）

### 2.1 能力协商

worker hello `features` 新增 `windows.multi.v1`（本项目两个 stage 都声明：editor 需要真子窗口；
runtime demo 需要 demo 钩子做黑盒验证。单窗口语义不变，旧行为逐字节保持）。新 extension 命名空间
（注册进 producer manifest，broker 按白名单透传）：

- `godot.window.v1`：created / destroyed / rect / visibility / title / focus / raised（worker→client）。
- `godot.editor.v1`：spawnGame / gameRect / gameClose（worker→client），gameLifecycle（client→worker）；
  另有仅用于自动化验证的 debugGame（client→worker，`{phase:'start'|'rect'|'stop', rect?}`，驱动与
  EmbeddedProcessDSH 相同的发射路径）与 gameDebug（worker→client，把 gameLifecycle 回报回显到
  wire 上使完整状态机可断言；不占真实游戏会话的 listener 槽）。

### 2.2 worker → broker

- `frame` 与 `surface` 增可选 `window`（0..15，缺省 0 = 主窗口）。
- `surface` 收据增 `slots`（该窗口帧环槽数；broker 用于槽位越界校验与配额统计）。
- 主窗口环维持 4 槽；子窗口环 2 槽。

### 2.3 client → worker

- `resize` 增可选 `window`（validator 门控：必须已协商 `windows.multi.v1`，且 0..15）。
- `input`（pointer/wheel/key/text/ime/drop）与 `focus` 增可选 `window`；pointer/wheel/drop 的
  位置恒为**目标窗口图层局部 CSS px**；key/text/ime 由客户端标注当前焦点窗口。
- `release` 携带 `window` 以按窗口归还租约。

### 2.4 spawn API

`spawn({ producerId, args })`（IPC `dsh-desktop:native-viewport-spawn`）：以已注册 producer 启动
第二个 worker 作为新 session，复用 attach 的全部校验（packageRoot/executable/sha256/适配器/GPU）；
broker 追加协议参数于尾部，并过滤渲染端请求中的保留参数（`--dsh-*`、`--broker-pid`）。`args`
≤ 64 项 × ≤ 1024 字符。session 总数 2 → 4。

### 2.5 配额（broker 强制）

| 项 | 配额 |
| --- | --- |
| 每 session 窗口数 | ≤ 16（id 0..15） |
| 每 session 总帧槽 | ≤ 24（主环 4 + 子窗口每环 2） |
| 单窗口帧环 | 主 4；子 2（sink 内部 `MIN(slot_count, 2)`，RDD 数组以 sink 实际槽数为准） |
| 单帧物理尺寸 | ≤ 2048/轴（沿用） |

## 3. 坐标与几何约定

- 引擎窗口矩形（created/rect 事件）使用**虚拟屏幕物理 px**，主窗口原点 (0,0)。
- 客户端图层偏移 = `(enginePos - mainPos) / mapScale`，图层 CSS 尺寸 = `engineSize / mapScale`；
  `mapScale` 为主窗口 resize 锁定的会话级逐轴因子（interaction.map.v2，D4 决策：子窗口几何
  引擎驱动，无需逐窗口锁因子）。
- 子窗口输入 x/y 恒为图层局部 CSS px；worker 用会话级因子映射进引擎，事件
  `set_window_id(window)` 后按窗口回调分发。
- 每窗口 IME：imeState payload 增 `window`，坐标为窗口局部引擎物理 px；客户端加图层偏移后按
  appliedSurface 换算 CSS（复用现有管线）。

## 4. 引擎侧设计（godot/platform/windows）

- `DSHSharedFramesWin32` 拆分为"每 worker 一次"的 `initialize`（D3D11 device + broker 进程句柄）
  与可多次调用的 per-window `Pool`（`create_frames(Pool&, w, h, slots)`）。单 D3D11 device 多纹理池。
- 新增 `DSHWindowSink : DSHViewportFrameSinkVulkan`：每子窗口独立 Pool、独立 timeline completion
  semaphore、独立 epoch（create_frames 时自增）、独立租约状态。sink 接口无窗口参数——sink 指针即
  per-surface 身份（D2），渲染呈现路径与主窗口完全同构。create_frames 内部 `MIN(slot_count, 2)`。
- `DSHViewportWorker`：
  - 窗口注册表 `sub_windows`（id 1..15，主线程）+ 泵线程快照 `active_sinks`（`sinks_mutex`）。
  - 泵循环轮询：子窗口先发布 surface 收据（epoch 未发布时）再取已完成 present 发帧（帧 ticket
    带 `window`）；主窗口路径不变（非阻塞 try-wait + 2ms cv 空闲等待）。
  - resize/release 按 `window` 路由；release 在 stdin 线程直接应用到对应 sink（沿用防死锁约定）。
  - 生命周期事件发射；焦点协议 `dsh_set_focused_window`（唯一事实源，生成 FOCUS_IN/OUT 回调
    序列 + 客户端对齐事件）；引擎内部聚焦（popup 显示/grab_focus → `window_move_to_foreground`）
    经 `dsh_notify_engine_focus` 回传客户端。
  - 每窗口 IME 状态（`window_set_ime_active/position` 本已带 window 参数，改为 per-window 存储）。
  - 剪贴板桥接：`clipboardWrite`（worker→client，fire-and-forget 写系统剪贴板）+ `clipboard`
    （client→worker，缓存供同步 `clipboard_get`；焦点进入视口时客户端主动推送预热）。
  - demo 钩子：`godot.demo.v1` 增 `openPopup {width,height,color}` / `closePopup`，`query` 扩展
    回发窗口列表（rect/focused/visible）。
- `DisplayServerDSH`：
  - `has_feature` 真值：SUBWINDOWS / MOUSE / CLIPBOARD / HIDPI / WINDOW_TRANSPARENCY 恒真；
    WINDOW_EMBEDDING 在 editor stage 为真（D7）。
  - `create_sub_window`：`worker->dsh_create_window_sink` → `surface_create_dsh(sink)` →
    `window_create_from_surface` → `screen_create` → `created` 事件；失败整体回滚返回
    INVALID_WINDOW_ID。
  - `delete_sub_window`：`screen_free` + `window_destroy` + sink 销毁 + `destroyed` 事件。
  - show_window（仅子窗口发 visibility）、window_set_size/position（rect 事件 + surface resize，
    所有窗口）、window_set_title、window_move_to_foreground（raised + 焦点）、window_set_transient、
    每窗口 input/rect/window_event/drop_files 回调、`get_window_at_screen_position`（z 序命中）。
  - **构建默认值**：`display/window/subwindows/embed_subwindows` 在 DSH 构建中默认 false
    （非 DSH 构建保持 true 逐字节不变）。
- `main.cpp:4563` 无需改动：has_feature 真值后自动走多窗口分支；4563/4768 核对记录见此文档。

## 5. 客户端设计（src/client.js）

- 图层管理器：`godot.window.v1` 事件驱动创建/更新/销毁绝对定位 `<canvas>`（`.g101-wrap` 内），
  zIndex 跟随引擎 z 序；纯函数状态机 `reduceWindowEvent`（单测覆盖）+ `engineRectToLayerCss`。
- 帧路由：`ticket.window` 分发到对应图层；未知窗口帧丢弃计数。每图层独立 WebGPU
  device/context（v1 接受；共享 device 为后续优化）。透明弹窗图层 shader 采样 alpha、
  `alphaMode:'premultiplied'`（D3D11 RGBA8 → VideoFrame alpha 语义按直线 alpha 处理；若实测
  不一致，broker 端预乘转换作为后续 spike）。
- 输入：pointer/wheel/drop 带所在图层 window；key/text/ime 带当前焦点窗口；图层 pointerdown →
  focus 控制消息；焦点跟随引擎 focus 事件（popup 自动抢焦点）。
- IME host 按 window 偏移定位；剪贴板桥接见 §4。
- 游戏覆盖层：`godot.editor.v1/spawnGame` → `api.spawn(EDITOR_PRODUCER, args)` → 新 canvas
  覆盖层（zIndex 1000，位于编辑器图层上方，几何按 rect 事件换算）→ 游戏 session 复用
  resize/输入管线；首帧回报 `gameLifecycle{running:true}`；gameRect 跟随 GameView 尺寸；
  gameClose/会话 disposed 清理并回报 `gameLifecycle{running:false}`。v1 单游戏实例。

## 6. 游戏 tab（editor/run）

- `EmbeddedProcessDSH : EmbeddedProcessBase`：GameView UI 逻辑零改动（D6）。`embed_process(pid)`
  → worker 发 spawnGame（args 由 EditorRun 预先存入 `pending_args`，rect 为
  `get_screen_embedded_window_rect()`）；`gameLifecycle` 驱动 embedding_completed/failed 信号；
  `queue_update_embedded_process` → gameRect。
- `game_view_plugin.cpp` 构造按 `DisplayServer::get_singleton()->get_name() == "dsh"` 分流。
- `EditorRun::run`：DSH 模式不调用 `create_instance`，参数数组交给 EmbeddedProcessDSH，pids 推入
  哨兵 pid（非零且不可 kill）；`stop()` 走 `request_close()`（gameClose）而非 OS::kill。
  Windows 原生路径在非 DSH 构建中逐字节不变（编译期门控 + 运行时判定）。

## 7. 兼容性

- 新字段全可选；不带 `window` 的消息语义与 v2 完全一致。
- 新 worker + 旧 broker：hello 扩展不匹配 / 未知字段在校验器处显式失败（D9 版本锁定，优于静默错乱）。
- 旧 worker + 新 broker：全链路旧行为（validator 放行缺省）。
- 非 DSH 构建（`dsh_viewport=no`）：呈现路径与上游逐字节一致（所有改动在
  `DSH_VIEWPORT_ENABLED` 门控内；唯一例外是 core 的 GLOBAL_DEF 默认值，同为编译期门控）。

## 8. 验收记录（2026-10-25）

- node scripts/godot.mjs verify（runtime）：全绿，新增 multiWindow 步通过——openPopup →
  created/rect/visibility 事件 → 子窗口 surface（2 槽）→ window 标记帧 → 带 window 的 release →
  焦点切换（focus 事件 + query 窗口列表 focused=true）→ destroyed。
- node scripts/godot.mjs verify --editor（editor）：multiWindow 覆盖真实弹窗的创建、独立帧、resize 后 epoch 推进与销毁；等待子窗口期间同时归还主窗口和旧子窗口租约。gameTab 验证 debugGame 协议回环，不代表真实 Play 游戏进程验收——debugGame{phase:'start'} → spawnGame 形状断言
  （args/rect）→ gameLifecycle{running:true} 回环（gameDebug 回显）→ debugGame{phase:'rect'}
  → gameRect 跟随 → debugGame{phase:'stop'} → gameClose → 退出 lifecycle 回环。
- 顺带修复：泵循环对引擎瞬态 0×0 窗口尺寸产生的退化帧（width/height/handle 为 0）改为释放槽位
  而不再输出——broker 会拒绝零句柄帧，verify 的 framesAndReleases 步曾因此间歇失败。
- `node --test tests/*.test.mjs` 17/17；上游 `native-viewport-protocol.spec.ts` 29/29；
  两侧 `tsc` 干净。
- 引擎 `target=editor` 与 `target=template_release`（dsh_viewport=yes）均构建链接通过。

### 本机重新验收（2026-10-25，RTX 2060 SUPER）

- `python -m SCons` 构建 editor 成功；Python 3.12 安装 `zstandard` 后完成全量编译。
- Desktop 黑屏根因：broker 扩展操作名验证器只允许小写字符，拒绝 `gameRect`、`imeState` 等合法驼峰事件并停止实例；操作名允许首字符小写、后续 ASCII 大小写字母。
- Editor 在真实 Electron 桌面呈现，截图保存在本地 `.dsh-dev/editor-proof.png`。
- F6 运行当前场景，独立游戏 session 在 GameView 区域输出 576×384 画面，观测到 561 帧；F8 后游戏 canvas 数量归零。截图保存在 `.dsh-dev/game-proof.png`。DSH 路径不再传递真实 HWND 专用的 `--wid 0`。
- `verify --editor` 多窗口步骤通过，包含子窗口 resize 后 epoch 推进；等待期间持续归还主窗口及旧子窗口帧，避免假 broker 自身阻塞引擎。
- 工作区供给、独立 runtime Tab 与发布包仍未完成验收，不由上述 GameView 验收推断可用。

## 9. 风险与遗留（对应计划风险表）

- 透明弹窗 alpha 语义：按直线 alpha + premultiplied 输出实现；像素级 spike 仍为后续项。
- 输入焦点竞态：单一事实源（客户端点击 + 引擎回传对齐），worker 统一生成 FOCUS_IN/OUT。
- 每图层独立 WebGPU device：v1 接受开销，共享 device 后续优化。
- 游戏多开：v1 单实例（第二个 spawnGame 拒绝）；Run Instances 多实例在 DSH 模式禁用。
- 剪贴板：粘贴首取可能拿到缓存值（焦点进入时客户端预热缓解）；跨应用读取受 Chromium 权限约束。
- 光标形状反馈、浮动 dock 拖拽、游戏浮动弹出层：本期不做（开放问题，见原计划 §6）。
