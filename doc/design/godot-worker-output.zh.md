# Godot 输出层重构：DSH 原生视口 worker

日期：2026-10-25。基线：fork 分支 `dsh_godot_plugin`（上游 4.8.beta，`c8256a8ece`）。本文档描述把 Godot 的输出层（presentation layer）重构为「无窗口、可插拔呈现目标」的设计，以及 DSH 原生视口 worker 的实现。构建与打包验收见 `doc/acceptance/build-and-package.zh.md`；线协议契约见上游 `apps/desktop/native-viewport.zh.md`（协议 2）。

## 1. 目标与非目标

目标：同一个 Godot 可执行文件，在普通模式下行为与上游一致；加上 broker 保留参数 `--dsh-viewport-protocol 2 --broker-pid <pid>` 后，成为 DSH 桌面原生视口的渲染 worker——无窗口、全 GPU（Vulkan 渲染直接写入 D3D11 共享纹理）、通过 stdin/stdout 的 JSONL 线协议产帧、接受通用输入。

非目标（本阶段）：不嵌入 Godot 编辑器 UI；不运行用户工程场景（worker 内置旋转立方体演示场景）；不做协议 1 兼容；不提供非 Windows 传输。

## 2. 输出层重构（上游代码改动）

核心思想：**把「交换链呈现目标」从「OS 窗口表面」解耦**。渲染管线（SceneTree → RenderingServer → RenderingDevice → 各 Forward 渲染器）完全不变，只有 presentation 的尽头被替换。

### 2.1 接缝一：渲染上下文（surface 与窗口解耦）

- `servers/rendering/rendering_context_driver.h/.cpp`
  新增 `window_create_from_surface(WindowID, SurfaceID)`：允许 DisplayServer 把「非窗口来源」的 surface 绑定到窗口 ID，复用既有 `window_surface_map` 与全部 `window_*` 尺寸/vsync 转发路径。
- `drivers/vulkan/rendering_context_driver_vulkan.h/.cpp`
  `Surface` 新增 `dsh_headless` 标志与 `dsh_sink` 指针（`#ifdef DSH_VIEWPORT_ENABLED`）。新增 `surface_create_dsh(sink)`：创建 `vk_surface = VK_NULL_HANDLE` 的 headless surface；`surface_destroy` 跳过空 surface；`queue_family_supports_present` 对 headless surface 直接返回 true（无呈现引擎，图形队列同时驱动帧导出）。

### 2.2 接缝二：交换链呈现目标可插拔（Vulkan RDD）

`drivers/vulkan/rendering_device_driver_vulkan.cpp` 在四个函数中加入 DSH 分支：

| 函数 | 原行为 | DSH 分支 |
|---|---|---|
| `swap_chain_resize` | `vkCreateSwapchainKHR` + 获取交换链图像 | `_swap_chain_resize_dsh`：经 sink 创建 4 张 D3D11 导入图像，照旧建 view/render pass/framebuffer；不建 present 信号量；格式固定 `R8G8B8A8_UNORM` |
| `swap_chain_acquire_framebuffer` | `AcquireNextImageKHR` 阻塞取图 | `sink->acquire_slot_blocking()` 租约等待（10s 看门狗，graphics101 同语义）；无 GPU 信号量（broker 租约即同步） |
| `command_queue_execute_and_present` | 提交时信号量二值 present 信号量 + `QueuePresentKHR` | DSH 交换链：跳过二值信号量与 queue present；提交时附带 sink 的 **timeline 信号量**（`VkTimelineSemaphoreSubmitInfo`），submit 成功后 `sink->allocate_present(slot)` 记录完成跟踪；失败 `cancel_present` |
| `_swap_chain_release` | 销毁 swapchain | 无需改动：DSH 的 `vk_swapchain` 恒空、图像归 sink 所有、view/framebuffer 照常销毁 |

配套：

- 设备扩展新增 `VK_KHR_external_memory` + `VK_KHR_external_memory_win32`（`_initialize_device_extensions`）。
- 设备特性链新增 `VkPhysicalDeviceTimelineSemaphoreFeatures`（`_initialize_device`），用于 GPU 完成跟踪。
- 新增抽象接口 `drivers/vulkan/dsh_viewport_frame_sink_vulkan.h`：纯 Vulkan 类型、无平台依赖。RDD 只依赖该接口；平台层（Windows）实现它。

默认构建（未定义 `DSH_VIEWPORT_ENABLED`）上述代码全部编译期剔除，呈现路径与上游逐字节一致。

### 2.3 新显示服务器：DisplayServerDSH（platform/windows）

`platform/windows/display_server_dsh.h/.cpp`：

- 注册名 `dsh`，仅在 `DSH_VIEWPORT_ENABLED` 构建中注册（`register_dsh_driver()`，由 `os_windows.cpp` 调用）；永远排在 headless 之前。
- `create_func`：创建 `RenderingContextDriverVulkanWindows` → `surface_create_dsh(worker)` → `window_create_from_surface(MAIN, surface)` → `RenderingDevice::initialize(context, MAIN)`（有 main surface，正常多帧并行度）→ `screen_create(MAIN)` → `RendererCompositorRD::make_current()`（否则 RS init 时空函数指针崩溃——上游各平台 DS 均负责此调用）→ 主窗口初始尺寸 0（**挂起**，等 broker resize）。
- 窗口：主窗口 + 自增子窗口 ID；`window_set_size` 三件事——存尺寸、`rendering_context->window_set_size`（surface needs_resize）、`rect_changed_callback`（驱动 SceneTree 视口尺寸与 attach-to-screen），与 `DisplayServerWindows` 的 WM_SIZE 职责一致。**多窗口（协议 v2.1）已实施**：子窗口获得独立 headless surface + 独立 2 槽帧环（`dsh_window_sink.*`）+ `godot.window.v1` 生命周期事件；`has_feature(FEATURE_SUBWINDOWS)` 返回真值，DSH 构建中 `embed_subwindows` 默认 false。详见 `multi-window-protocol-v3.zh.md`。
- `can_any_window_draw()` = worker 已应用非零 broker resize 且主窗口可画；`process_events()` = `worker->poll()` + 输入 flush。
- 输入分发：构造时 `Input::set_event_dispatch_function`，按窗口回调路由（与 headless 相同模式）。

### 2.4 协议 worker（platform/windows/dsh_viewport_worker.*）

实现 `DSHViewportFrameSinkVulkan`，五个职责：

1. **共享帧池**（组合 `DSHSharedFramesWin32`，移植自已验证的 graphics101 `SharedSurface`）：Vulkan LUID ↔ DXGI 适配器匹配 → D3D11 `CreateTexture2D`（`SHARED|SHARED_NTHANDLE`）→ `CreateSharedHandle` → `vkGetMemoryWin32HandlePropertiesKHR` + 专用 `vkAllocateMemory` 导入 → `vkBindImageMemory` → `DuplicateHandle` 到 broker PID。零拷贝直写，无 CPU 回读。
2. **帧生命周期**：`allocate_present`（渲染线程，分配单调递增 timeline 值）→ 后台 pump 线程 `vkWaitSemaphores` 按序等待 → GPU 完成后输出 `frame` 消息（epoch/slot/frameId/尺寸/inputSeq/单调时间戳/十进制句柄）。帧序号在**发射时**分配，天然严格递增。
3. **槽位租约**：4 槽；acquire 阻塞等待空闲槽（10s 超时 → 报错，不强制复用）；**stdin 线程直接应用 `release`**（槽状态互斥保护）——释放不能等主线程下一次 poll，否则渲染线程阻塞在 acquire 时形成死锁。
4. **协议解析**（stdin 线程入队，主线程 poll 应用）：resize（2048 配额；0 尺寸挂起；**等全部槽释放后再应用**，graphics101 语义）、visible（失焦清按键/拖动）、input/extension（seq 严格递增去旧）、stop/EOF → 请求主循环退出。
5. **epoch 在 resize 应用时建立并立即宣布 surface**——保证 broker 先看到 `surface` 再看到该 epoch 的 `frame`（broker 拒绝 epoch<1 的帧）。

输入映射：指针/滚轮/键盘（复用上游 `platform/web/dom_keys.inc` 的 DOM code → Key 全表，Web 之外首次编译）/焦点 → `Input::parse_input_event`（主线程 accumulate，process_events flush）；滚轮=按下+抬起对；修饰位 Shift=1/Ctrl=2/Alt=4/Meta=8；DOM buttons 位与 Godot `MouseButtonMask` 一致。

演示场景（无工程内建）：`Node3D + BoxMesh(材质) + DirectionalLight3D + Camera3D + DSHDemoController`（C++ `Node` 子类，`_notification(PROCESS)` 旋转立方体、轮询 `Input` 实现轨道相机：拖拽环绕、滚轮/WASD/QE 缩放移动、R 重置、Space 旋转开关）；扩展命名空间 `godot.demo.v1`（`reset` / `rotate{value}`）。

### 2.5 主程序接入（main/）

- `main/dsh_viewport_mode.h/.cpp`：进程级状态（worker_enabled、broker_pid），core-only。
- `main.cpp`：解析两个保留参数（版本不符即报错）；worker 模式强制 `display-driver dsh` + Dummy 音频 + `quiet_stdout` + `OS::set_stdout_enabled(false)` + 关 header——**stdout 只有协议**（hello 必须首行），诊断走 stderr；禁用「无工程即失败」「无主场景即失败」「回退 project manager」「回退其它显示驱动」；`Main::iteration` 顶部响应 stop 请求；worker 析构（`~DisplayServerDSH`，先于 RD/context 销毁）停止线程、输出 `stopped`、回收句柄与信号量。

## 3. 数据流（一帧）

```
SceneTree 渲染命令 → RenderingDevice 录制
  → screen_prepare_for_drawing: DSH acquire (槽租约等待)
  → 渲染器把场景画到导入的 VkImage（帧缓冲 = 共享纹理）
  → _execute_frame: 提交，附带 timeline 信号量值 N；RDS 通知 sink allocate_present(slot→N)
  → pump 线程: vkWaitSemaphores(N) 完成 → stdout 输出 frame{handle}
  → DSH broker: Electron sharedTexture 导入 NT 句柄 → renderer WebGPU 呈现
  → renderer done → broker 回发 release → stdin 线程 mark_slot_released → 槽可复用
```

resize 路径：broker resize → 主线程等全部租约释放 + pump 排干 → epoch++ → surface 消息 → DS 窗口尺寸 → 下一帧 prepare 时 flush+stall GPU → 重建 D3D11 池与帧缓冲 → 新 epoch 帧。

## 4. 构建开关

SCons 新增 `dsh_viewport=yes`（默认关）：仅 `platform=windows arch=x86_64`、要求 Vulkan；追加 `DSH_VIEWPORT_ENABLED`。输出 `bin\godot.windows.template_release.x86_64.exe`（`target=template_release`；editor 目标同样适用但未验证）。`platform/windows/SCsub` 新增三个源文件（无开关时也编译，内容被宏剔除）。

## 5. 已知限制与后续

- 多 GPU：hello 上报渲染适配器（LUID 匹配 DXGI），与 Chromium 活动适配器不一致时 broker 拒绝——与 graphics101 相同的已知限制。
- 每生产者单挂载、4 槽、2048×2048、Windows x64 / Electron 44.7.0 ——协议 2 既定配额。
- 引擎错误信息（如脚本缓存缺失）走 stderr，broker 以诊断事件显示，不污染协议。
- 停止序列依赖 broker：stop + stdin EOF → 主循环当帧退出 → 清理 → `stopped` → 退出码 0；3s 看门狗内可完成（实测远小于）。
- **Editor 模式**（2026-10-25 构建验证通过）：同一份重构承载 Godot editor。要点：editor 是 `Main::start` 的 EditorNode 分支（普通 SceneTree payload）；多窗口（协议 v2.1）已实施：editor 的弹窗/对话框成为真子窗口（独立 surface/帧环/客户端图层），FBX 导入预览与 Game tab 可用；`has_feature(FEATURE_WINDOW_EMBEDDING)` 在 editor stage 为真，游戏经第二个 broker session 呈现（`EmbeddedProcessDSH`）；DS 必须创建 `NativeMenu` 单例（EditorNode 菜单初始化无条件查询）；`OS_Windows::alert` 在 worker 模式转 stderr（原生消息框会挂起隐藏进程）；editor 按需重绘（hover 不触发），隐藏经 `can_any_window_draw` 完全停帧；`target=editor` 的 `main.cpp` 不得包含平台 worker 头文件（windows.h 宏污染 editor GUI 头），`Main::iteration` 经 `DSHViewportMode::worker_stop_check` 函数指针轮询。`godot:verify:editor` 全绿（滚轮驱动 12 帧、inputSeq 47、隐藏停帧、epoch 推进、干净停止）。
- 后续里程碑：worker 运行真实工程场景（producer args 已预留 `--path` 等 32 个槽位）、DirectX 兜底、第二引擎复用验证。`godot.editor.v1` 与 `godot.window.v1` 命名空间已落地（多窗口协议 v2.1，见 `multi-window-protocol-v3.zh.md`）。
