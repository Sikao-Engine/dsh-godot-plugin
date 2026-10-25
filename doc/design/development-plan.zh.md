# dsh-godot-plugin 开发总计划

日期：2026-10-24。本文为设计与验收计划，不表示下述图形桥接已实现。

## 1. 目标与冻结决策

最终目标：以独立 DSH 插件提供 Godot runtime 的原生 GPU 视口、编辑工作流及分发能力；必要的 Electron 能力以通用、最小、可撤销的 Desktop 接口向上游提 PR，而非给插件开放任意 Electron 对象。

你已确认：

- PC 优先，第一条验证线是 Windows x64。
- **Vulkan 优先**；设置外部纹理互操作门禁，失败时首个可发行 demo 使用已验证的 DirectX 路线，Vulkan 攻关独立继续。
- 唯一显示路径为原生 GPU texture → Electron sharedTexture → VideoFrame → WebGPU → DSH DOM canvas。
- 禁止用 HWND 子窗口直显、CPU 像素流、软件渲染冒充成功；后端切到 DirectX 不改变该显示要求。
- GPU 内部 copy/blit 允许，必须明确记录次数。“GPU 无回读”不等于所有阶段都零 GPU copy。
- 第一阶段不改 Godot，先用小型 C++ Graphics 101 控制变量；先证明图形互操作，再证明 DSH 插件安装发行，最后修改 Godot。
- 当前 Godot checkout 的 `version.py` 声明 `4.6.3-rc`；正式实施前记录 commit 与实际构建版本，不能仅凭版本文件称其为稳定发行版。

Vulkan 有利于 Godot 后端和未来平台复用，但 **Electron Desktop 并不是移动端容器**。移动端将复用 Godot 项目、原生渲染与控制协议，显示宿主和资源句柄传递另行实现；iOS 等平台不能假定原生 Vulkan 可用。

## 2. 参考 demo：哪些已经证实，哪些尚未证实

参考：`F:\repos\myrepo\RoboCute-repo\RoboCute\samples\electron`。

### 已有代码事实

- 当前 `README.md` 与 `protocol.js` 明确 sharedTexture 为唯一显示路径。
- `REPORT.md` 是旧 HWND/readback 实验历史，不能作为当前零回读方案。
- Windows 实现只接受 `dx`：`shared_surface_win32.cpp:46` 的 `surfaceCaps()` 对 `vk` 返回 unsupported。
- Windows 导出纹理由 **D3D11** 在与引擎相同 LUID 的适配器上创建，`CreateSharedHandle` 产生 NT handle；D3D12 打开它并用私有 COPY queue 写入，再 DuplicateHandle 到 Electron main。
- main 使用 `sharedTexture.subtle.importSharedTexture()` / `startTransferSharedTexture()`；preload 使用 `finishTransferSharedTexture()`；renderer 用 `VideoFrame` 和 WebGPU `importExternalTexture()`。
- 4 槽环、最多 2 帧在途 + 1 排队，epoch 管理 resize，inputSeq 记录帧已应用输入，renderer GPU 完成读取后归还租约。
- 原 demo 记录 D3D12 直接分配的共享纹理有黑帧/GPU 异常；D3D11 分配 + D3D12 私有 copy 是该设备和代码路径的实测解法，不应泛化成所有驱动的定理。

### 必须重新验证

1. Vulkan 与 Windows/Chromium D3D 资源的互操作；普通 Vulkan OPAQUE_WIN32 内存句柄不能直接当成 Electron 接受的 D3D texture handle。
2. DSH 的 **sandboxed preload** 能否使用所需 subtle API。RoboCute 示例 preload 能运行，不等于在 DSH 的 sandbox 配置下能运行。
3. `VideoFrame`、回调和传输对象跨 contextBridge 的实际生命周期；不能把任意 Electron imported 对象直接公开给页面。
4. DSH main/Host 进程分离后的能力注册、句柄归属和清理。
5. 原 demo 的输入延迟命名：`protocol.js` 曾称 input-to-photon，实际仅是输入发出到绘制提交；本计划只使用 input-to-submit。
6. sender/source 校验：示例的简单 IPC handler 不足以成为 DSH 产品安全边界，不能照抄。

本次只阅读源码和已有实验记录，没有重跑 RoboCute 或 GPU 验收，不宣称已有结果覆盖本项目。

## 3. 分层架构

```text
DSH Client 插件 / React 视口 tab
    │ 普通 JSON 控制、状态、工程操作：DSH RPC
    │ 视口会话 attach / input / resize：受限 Desktop client facade
    ▼
DSH 自有 sandboxed preload
    │ 接收 transfer，受控产生 VideoFrame，处理 GPU read-complete
    ▼
Electron main / 通用 Native Viewport Broker（DSH 自有）
    │ GPU 帧导入、目标绑定、租约、资源配额、能力撤销
    │ private IPC：注册与撤销
    ├──────── DSH Host / dsh-godot-plugin
    │             │ 工程、配置、工具、日志、插件生命周期
    │             │ 派生受控原生 worker，注册生产者
    │             ▼
    └──────── Graphics101 / Godot worker（C++ 原生进程）
                  │ Vulkan 优先 / DirectX 可选
                  │ 共享 surface ring、fence、输入、copy/blit
                  ▼
             原生 GPU rendering
```

不把 GPU frame transfer、原生 HANDLE、VideoFrame 塞进 HTTP/WebSocket/普通 DSH RPC。控制面和低频状态走已有 RPC；图像面走 Electron 私有 transport；日志只记录非敏感元数据。

原生引擎不得运行在 renderer 或 Electron main 中，避免 addon/引擎崩溃直接损坏 shell。初版偏向独立 C++ EXE + 命名管道，降低 Electron ABI 耦合；如复用 N-API worker 更快，需专门维护 loader/Node-API 版本与运行时测试，仍放在独立进程。

### 控制归属

- DSH Host 插件拥有业务 session、工程路径、worker 生命周期和可逆注册。
- Desktop broker 拥有帧通道、window/document 绑定、导入对象与撤销权。
- renderer 拥有 canvas/WebGPU 提交与视口输入。
- 原生 worker 拥有引擎设备、纹理与生产端 fence。
- native worker 内部渲染线程消费命令，不让 JavaScript 或 IPC 回调线程直接调用 Godot 渲染器。

## 4. M0：基线与双前提门禁

目标：在投入 Godot 修改前明确两项独立风险。

### M0-A：Vulkan→Windows shared surface

建议时间盒：3～5 个有效开发日，作为投入上限，不是完成承诺。

输出 `interop-probe`：枚举 Vulkan/DXGI/Chromium 适配器、有效 LUID、外部内存类型、format、usage、tiling、dedicated allocation 要求。查询相关能力，不只查询扩展名存在。

首选候选：

```text
D3D11 创建 Electron 可接受的 NT-handle RGBA8 纹理
    → Vulkan 以匹配的 D3D11_TEXTURE 外部内存类型导入为 VkImage
    → Vulkan copy/blit 或直接 color attachment 写入
    → Vulkan fence 确认完成、释放外部 ownership
    → Electron sharedTexture 导入并显示
```

需要逐项验证：

- `VK_KHR_external_memory_win32` 及核心/对应外部资源能力；D3D11_TEXTURE 类型实际 IMPORTABLE、兼容资源参数与 memory type。
- `VkExternalMemoryImageCreateInfo`、`VkImportMemoryWin32HandleInfoKHR` 与 dedicated allocation 条件；导入句柄关闭规则按 handle 类型遵守 Vulkan 规范。
- `VkPhysicalDeviceIDProperties.deviceLUIDValid`、deviceLUID 与 DXGI adapter；Chromium GPU 信息如果不提供可用 LUID，单 GPU先验只能限缩支持范围，不能假定多 GPU 已匹配。
- VkImage layout 和 `VK_QUEUE_FAMILY_EXTERNAL` ownership acquire/release（按实际实现规范）；不能只等 CPU fence 就忽略跨 API ownership。
- renderer 完成读取前不再次写入该槽；Vulkan 和 Chromium 间的同步方案须实测，没有现成共享 semaphore 就依靠发布/归还租约隔离访问，并遵守外部内存同步规则。
- RGBA/BGRA、线性/sRGB、alpha、坐标翻转、HDR→SDR边界。

若 D3D11_TEXTURE 导入不可用，允许在同一时间盒内评估**有证据的 GPU-only 中转**（如驱动支持的 Vulkan-D3D12 资源互操作），但不得把 opaque VkDeviceMemory handle 按 D3D texture handle 发送。所有增加的 copy 和同步都记入结果。

门禁通过：Electron WebGPU 显示非黑正确色块/三角形，持续 1500 帧，0 GPU process exit、0 validation error、0 lease timeout，且无运行时 CPU 像素回读。

失败决策：保存 extension/format/driver/adapter 与失败原因；首个 demo 使用 D3D11 export + D3D12 GPU copy 的已验证路线。Vulkan不是静默运行时回退：明确选择后端并在 UI 展示。

### M0-B：DSH sandbox/bridge 可行性

在本地 DSH 分支中加入最小探针，不先开放通用 Electron import：

- 在现有 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false` 下测试 subtle API可用性。
- 验证 VideoFrame跨隔离世界与回调清理，frame source只对自有 top-frame 可见。
- 若 sandbox 不支持所需 API，记录具体缺失和上游依据；研究 Electron 官方可支持的隔离方案。**默认不全局关闭 sandbox，不开放 nodeIntegration。**
- 如必须改变隔离策略，先写独立 ADR 与安全分析，再决定是否继续上游路线；不能把这一步埋入“插件正常安装”。

M0-A 与 M0-B 可并行；任一没有明确方案，不进入 DSH 可发行承诺。

## 5. M1：C++ Graphics 101 程序

### 教学程序边界

- Windows x64、C++20、CMake、Windows SDK/MSVC、Vulkan SDK；编译工具与依赖准确版本入 manifest。
- Vulkan standalone 模式：普通 Win32 窗口/swapchain仅用于原生独立程序验收，不属于 DSH 内嵌显示路线。
- shared-output 模式：不创建可见嵌入 HWND，把同一场景输出到离屏 color target和export surface；底层渲染逻辑、输入命令和相机共用。
- 三个 RGB 顶点构成三维三角形，深度缓冲、透视投影、model/view/projection matrix；背景用棋盘或固定色块帮助检查翻转/色彩。
- 鼠标拖动 orbit、滚轮 dolly；W/A/S/D平移、Q/E升降、R复位、Space切换三角形旋转。
- 限制pitch与相机距离；dt驱动运动；focus lost清空按键、pointer cancel结束拖动。
- resize重建target与projection；零尺寸/隐藏暂停发布；恢复重新检查device状态。
- 不引入Godot、RoboCute、完整资源系统或物理系统；首个程序只做 graphics 与bridge必要功能。

### 建议目录（实施时创建，当前未创建）

```text
native/graphics101/
  CMakeLists.txt
  src/main.cpp
  src/scene.cpp
  src/camera.cpp
  src/vulkan_renderer.cpp
  src/shared_surface_win32.cpp
  src/worker_protocol.cpp
  shaders/triangle.vert
  shaders/triangle.frag
samples/electron-graphics101/
  main / preload / renderer / protocol / smoke
```

不要先造完整抽象引擎；只分开 scene/camera、backend renderer、platform export。DirectX renderer只在M0决策需要时加入。

### 验收

- 独立窗口正确显示透视三角形；自动输入导致相机矩阵和图像变化。
- 鼠标、键盘、复位、focus lost、resize测试通过；每帧回报已应用inputSeq。
- shared-output worker 生成同一场景，通过standalone Electron viewer显示。
- 100次resize、100次create/destroy及10分钟压力测试；无validation报错、句柄持续增长或worker残留。
- 诊断截图/验收像素检测允许一次性canvas readback，单列为测试工具，不进入帧传输路径。

## 6. 共享纹理与输入协议契约

协议建议名 `NativeViewport Protocol v1`，不直接把RoboCute字符串复制为DSH公共API。

### 平面与消息

| 平面 | 消息 | 内容 |
| --- | --- | --- |
| 控制 | hello/capabilities | 协议、backend、format、adapter、transport能力 |
| 控制 | create/start/stop | 业务session绑定、worker运行状态 |
| 控制 | input | seq、pointer/key状态、orbit/dolly/移动delta |
| 控制 | resize/visibility | 设备像素尺寸、DPR、可见状态 |
| 帧 | offer/transfer | sessionGeneration、epoch、slot、frameId、尺寸、inputSeq、timestamp |
| 帧 | readComplete/release | 准确票据，与GPU完成事件关联 |
| 状态 | surface/stats/error | 帧率、环占用、超时、丢帧、backend、non-sensitive错误 |

initial配置可沿用4槽、2在途+1排队、latest-wins，但作为实验参数，不作为永远固定的公共API。

不变量：

1. 生产GPU完成且外部ownership正确转移后才能offer。
2. 消费GPU完成、VideoFrame关闭、preload确认后才能释放已交付租约。
3. **超时不强制复用已交付纹理**；停止session、撤销transport，等安全清理或进程退出。
4. 旧epoch/旧generation/重复ACK不得释放新帧；broker绑定ACK发送者、文档与票据。
5. 未导入的排队帧可直接归还；导入部分失败则按实际创建阶段清理，不能概括为所有异常都立即ACK。
6. resize旧环保留到其租约归还；限缩旧环数量和总显存，超额时暂停重建或断开，不无限积累。
7. 页面卸载/GPU lost/Host重启必须撤销，不能靠JS finalizer决定安全复用。
8. timing统一明确时钟域：input-to-submit由renderer发出与提交时间统计；引擎GPU时间需timestamp query，不能将fence轮询间隔称纯GPU耗时。

键盘事件不无限队列化；合并pointer/resize，保留key down/up与reset顺序。canvas聚焦才收键盘，不截获聊天框或全局快捷键；pointer capture属于视口而非系统级hook。

## 7. M2：最小 DSH Desktop Native Viewport seam

### 当前源码判断

- `apps/desktop/src/preload-app.ts:112`只给自有应用top frame暴露固定`dshDesktop`产品API。
- `apps/desktop/src/ipc.ts:78`的`DshDesktopProductApi`没有sharedTexture或native viewport契约。
- `apps/desktop/src/main.ts`窗口设置保留sandbox和contextIsolation。
- `apps/desktop/src/host-process.ts`使用固定typed事件，未发现通用插件frame transport注册。
- `apps/desktop/tsdown.config.ts:17`为sandboxed preload限制import集合。

结论：**现有普通Host/Client插件格式可以挂业务与UI，但目前未见足够公共API完成此GPU transport。需要小范围本地DSH修改；接口形态必须通过M0-B验证。** 不把“未发现接口”写成所有Electron扩展都绝对不可能。

### 拟议 API（设计名，不是现有服务）

- Host能力：`ctx.desktopNativeViewports.registerProducer(descriptor)`，返回可撤销producer/session registry；只在Desktop提供。
- Client能力：`ctx.nativeViewports.capabilities()`、`attach(producerId, canvasBinding)`、session的`resize/input/visibility/dispose`。
- 帧呈现可由DSH提供受限presenter或经过验证的frame callback；优先让preload保持imported lifetime，页面拿短期VideoFrame而非native handle。到底由preload还是client负责WebGPU submit由M0-B决定。
- registration返回opaque id，不让页面指定任意PID、handle、exe路径或IPC channel。
- 相机/工程/模型工具仍由插件自己的DSH RPC提供，不把engine方法全集塞进公共DesktopAPI。

### 身份与信任限制

所有同源Client插件共享页面JS环境，`pluginId`字符串或同一window里的随机token不能证明调用来自哪个插件。第一版能力按**受信任的应用top-frame**而非“强插件隔离”授权；敏感producer注册仅经Host私有通道与用户启用记录处理。若要不同Client插件互不信任，必须另行隔离文档/进程，不能在本PR中虚构隔离。

Host插件本来就运行于宿主权限；新增接口仍不得让renderer提交任意HANDLE/PID，并需限制import格式、尺寸、slot数、速率与总显存，避免broker成为资源/句柄滥用入口。

### worker注册与资源通道

- Host只登记已安装启用包的producer、资源目录和受控worker；main审核并创建本地会话绑定。
- Windows HANDLE 必须在import所在main进程有效，数值序列化不能替代DuplicateHandle。
- preferred实现由broker掌握worker关联，原生resource helper执行限定source→target duplication；若初版沿用worker对main的PROCESS_DUP_HANDLE权限，明确为可信native插件能力并记录风险，不伪称安全沙箱。
- worker路径限制在包发行目录；hash/version登记用于诊断与完整性检测，不等于第三方代码可信。
- 不加载第三方main.js/preload.js，不提供`require('electron')`、任意ipcRenderer.invoke、shell.execute或BrowserWindow引用。
- 外部浏览器页、iframe、webview、DevTools页不得获得viewport bridge；沿用owning window/top-frame校验并叠加session绑定。

### 生命周期

Cordis卸载 →停止发布 →撤销producer/session →结束未完成控制请求 →GPU引用有序清理 →终止worker →释放host/native句柄。Host崩溃时main独立撤销；renderer崩溃时不能把未确认纹理当成FREE；GPU lost时新session必须重新探测。

M2通过条件：Graphics101在现有DSH shell里可见、输入可用、chat与viewport互不截键；切tab、隐藏、浮窗、Host restart、插件disabled、卸载、window close全通过清理测试。

## 8. M3：以 dsh-plugin 格式安装与发行 Graphics101 demo

不另建一份假DSH Electron shell。正式验收必须是源码DSH或支持新能力的打包DSH。

### 拟议包结构

```text
dsh-godot-plugin/
  package.json           dsh.bundle + dsh.client、exports与兼容要求
  cordis.patch.yml
  lib/                   Host/Client与类型声明
  native/win32-x64/      graphics101.exe、必要DLL、shader
  locale/
  runtime-manifest.json  后端、协议、构建commit、文件hash、支持平台
```

Demo阶段产品UI明确“Graphics101 demo”，不声称Godot已接入；保持`runtimeEmbedded`状态真实。以后同一插件用Godot producer替换triangle producer，frame契约与client presenter不变。

Client UI优先复用现有`ctx.sidebarRightTabs` + `sidebar.right.pane.tab`注册路径，提供graphics101页和全屏视口；无需替换根UI。tab的visible/abort signal控制暂停与释放；多occurrence是否共享一个engine须明确，第一版单producer单活动视口。

构建与发行：

1. 构建Host/Client与native/shader，生成release manifest。
2. 删除tree外开发`link:`依赖的发行耦合，确认Cordis peer由运行时满足。
3. 检查`pnpm pack`文件清单：无凭据/源码checkout绝对路径/缓存，无遗漏shader/DLL。
4. tarball安装到干净desktop profile，bundle与client被发现，worker从安装目录定位。
5. 先按平台包或固定win32-x64产物发行；不让安装时从未知URL下载任意binary，不默认运行编译脚本。
6. 能力不支持时UI显示明确unsupported，不按需开启Node integration。

两种分发产物必须分开：

- **插件tarball**：依赖已具有native viewport seam的DSH；旧官方DSH安装不会自动获得Electron接口。
- **开发/预览Desktop安装器**：临时DSH fork + plugin/runtime，记录安全能力、签名与升级归属；官方PR合并发布后再验证干净官方DSH + tree外插件。

验收至少包含一台无源码checkout、无Vulkan SDK/编译器的Windows x64环境。运行时驱动/VC runtime要求明确；原生EXE不要求Electron模块ABI，N-API可选路径则单独做兼容测试。

## 9. DSH 官方 PR 拆分

这里只设计PR，不创建远端PR或执行push。

### PR-0：RFC/设计说明

提交通用native viewport场景、进程图、威胁模型、GPU生命周期、sandbox探针结果、experimental Electron依赖与非Desktop行为。提前问维护者接口是否接受，不等Godot fork完成才争论架构。

### PR-1：能力协商与可撤销 session

- 通用typed protocol/capability facade，无Godot专属命名。
- Host↔main注册/撤销、自有window/top-frame校验、quotas、Web absent-service行为。
- 纯协议、无Electron测试、负向sender/session测试与卸载测试。

### PR-2：sharedTexture transport与最小样例

- main broker、sandboxed preload receiver、client presenter，集中封装experimentalAPI。
- 精确版本/能力检测，资源限制与失败状态。
- frame ring/epoch/stale ACK/GPU completion/renderer gone等测试。
- Graphics101可作为外部消费样例或最小fixture；避免将整个Godot或RoboCute依赖带进DSH核心。
- 构建/packaging、客户端能力声明、架构文档和配置目录按源码规范同步。

这些PR可由维护者要求合并或重排；不能PR-1新增无人使用的抽象后长期不交付PR-2。真正合并前始终标注experimental。

DSH改动落点候选：`apps/desktop/src`、`apps/desktop-host/src`、host protocol及新通用client capability包；确切目录按维护者建议。预加载bundle与安装器runtime metadata要一起更新，不能只修改TS类型。

## 10. M4：Godot Vulkan runtime producer

### 源码结论与接入位置

本地Godot已有成熟RenderingServer/RenderingDevice Vulkan实现，但成熟渲染后端并不自动提供跨进程export。

- `drivers/vulkan/vulkan_hooks.h:44`允许instance/device/physical-device构建介入；不是现成frame exporter。
- `drivers/vulkan/rendering_device_driver_vulkan.cpp:2218`的`texture_create_from_extension()`接收已存在VkImage并创建view；不是跨进程VkDeviceMemory导出，也不自动解决ownership。
- `platform/windows/rendering_context_driver_vulkan_windows.cpp:54`实现的是Win32 VkSurface；不能把这个surface当成Electron共享纹理。
- viewport→render target→RD texture路径存在于`servers/rendering/renderer_viewport.cpp`、`renderer_rd/storage_rd/texture_storage.cpp`等；需定位最终已tonemap的画面和提交时序，而非随意取一个未完成或HDR中间texture。

### 实施顺序

1. 固定Godot commit，在原生独立模式构建运行简单3D scene，保存baseline。
2. 新增可选native viewport模块/输出模式，默认Godot构建行为不变；无连接时不加载DSH bridge。
3. 接受受控viewport尺寸与输入，将Godot生成的最终color target在render thread内copy/blit到M0验证的共享纹理环。
4. 在Godot RenderingDevice graph/barrier体系内登记读/写与交接；如需nativequeue操作，扩展driver的窄接口，不能在RD管理之外并发写同一VkImage。
5. Godot GPU fence/外部ownership就绪后发布，收到GPU消费release才复用。
6. 输入映射Godot InputEventMouseMotion/Button/Key等，维护focus、resize、坐标与DPR；线程安全命令队列消费。
7. bridge保持C/POD或进程消息ABI，不暴露Godot C++ ABI给Electron。
8. runtime用同一producer协议替换triangle；client/native viewport broker不引入Godot特殊frame传输逻辑。

### 验收

- Godot 3D scene+2D overlay在DSH canvas正确呈现；camera与交互对象响应输入。
- UI叠层、resize、hidden/resume、场景切换、Host重启、runtime退出符合统一契约。
- validation干净、无CPU帧流、0GPU crash/lease timeout，30分钟运行；测试GPU/驱动记录明确。
- 普通Godot仍可独立启动/运行/导出；bridge是可选功能，不破坏未接入路径。

如果Graphics101暂用DirectX通过，而Godot Vulkan互操作门禁仍未通过，不得直接宣布Godot接入完成；需先完成Godot Vulkan exporter，或单独验证Godot自身支持的D3D12构建与output，再作显式范围决策。

## 11. M5：编辑器与分发完成度

“Godot runtime显示成功”不是“完整编辑器实现”。分为两个清晰交付：

### M5-A：DSH Godot 编辑工作台

DSH插件提供项目选择、资源浏览、scene/inspector面板、运行/停止、日志和视口，Godot以受控进程执行场景和工程操作。需开发对应编辑命令/RPC；仅显示游戏frame不能代替这些能力。

### M5-B：完整Godot Editor嵌入（独立可选门禁）

如果目标是完整原生Godot editor UI进入DSH canvas，需要验证主editor viewport、popup/多window、dialogs、text/IME、drag/drop、clipboard、快捷键、工具tips等能否由共享输出和输入桥实现。默认不隐藏这些问题；不要求“runtime接入”阶段一并宣称完成。

### 分发

- 编辑工作台包：DSH能力版本 + plugin + Godot runtime/editor，许可证、shader/assets、VC runtime、签名、更新与crash诊断。
- 独立游戏：Godot export templates + PCK/resources +平台runtime，不必附带Electron/DSH。
- 移动端：Godot原生export与移动容器，不移植Electron Desktop；touch、surface/swapchain、平台权限单独验证。
- Android可另验Vulkan，其他移动平台按实际Godot后端能力选择；Linux dmabuf/SCM_RIGHTS、macOS IOSurface/Mach传递作为PC后续扩展。

M5完成要求：干净机器安装、编辑/保存/重开工程、运行/停止、游戏导出、升级/回滚与卸载均有可复验记录，不能只以一张视口截图判定整个项目完成。

## 12. 测试矩阵、指标与风险

| 层 | 测试 |
| --- | --- |
| native | validation、外部format查询、ownership、fence、句柄归属、resize旧环 |
| protocol | seq/epoch/generation、重复/伪造ACK、过期session、尺寸/速率上限 |
| Desktop | sandbox能力、contextBridge、top-frame拒绝、preload重载、GPU process gone |
| 插件 | 安装启用、服务依赖、禁用、卸载、HMR/Host restart、client缺能力 |
| UI | focus/键盘、pointer cancel、DPR、缩放/浮窗、hidden pause、菜单遮挡 |
| 发行 | tarball/installer、离线启动、路径含空格、无源码、无SDK、版本不兼容 |
| Godot | render graph时序、场景/工程生命周期、2D/3D、正常独立export回归 |

指标：engine render GPU时间、export GPU copy时间、broker CPU耗时、presented fps、input-to-submit p50/p95、queue深度、lease hold、显存/句柄数量。初始在参考PC测60fps目标，不承诺所有设备60fps；1/10/30分钟分别形成不同阶段记录。

最高风险与止损：

1. Vulkan external D3D资源不兼容：M0时间盒、能力报告、明确DirectX demo后端选择。
2. sandbox API不可用：M0-B先验，独立安全ADR，不全局放宽权限。
3. 消费同步错误导致GPU crash：准确GPU complete租约，故障断开不抢槽。
4. 同源插件误称安全隔离：按trusted top-frame能力模型陈述，别伪造per-plugin安全身份。
5. DSH升级/experimentalAPI变动：adapter封装、版本与能力检测、CI/驱动矩阵。
6. Godot中间texture/异步render graph：在driver/graph可识别的提交点导出，不跨线程偷读。
7. 上游不接收seam：维持明确fork发行，不声称普通官方DSH可无修改安装全部功能。

## 13. 顺序与完成定义

```text
M0-A Vulkan互操作 ──┐
                   ├─ M1 Graphics101 + standalone Electron
M0-B sandbox桥接 ──┘                │
                       RFC/PR协商 ──┤
                                   ▼
                          M2 DSH通用GPU viewport
                                   ▼
                          M3 tree外插件发行demo
                                   ▼
                          M4 Godot runtime producer
                                   ▼
                       M5-A编辑工作台 / 独立游戏分发
                                   ▼
                       M5-B完整Editor（独立验收）
```

下一次实际开发只开始M0能力探针与M1原生三角形，不同时重构DSH/Godot。每个阶段交付源码commit、构建命令、安装产物、测试记录、支持矩阵与已知失败；未过门禁不填完成。

## 14. 首轮实施记录（2026-10-24）

本轮按确认范围仅实施 M0 能力探针与 M1 原生基础，没有修改 DSH/Godot，也没有完成 shared-output。可复验记录见 `tests/graphics101-baseline.json`；完整本机运行结果由 `pnpm run graphics101:verify` 写入 `.graphics101-results/manifest.json`（不提交本机路径与大型 GPU 报告）。

- `native/graphics101`：C++20/CMake/Vulkan 原生 RGB 三角形、深度、MVP、orbit/dolly/WASD/QE/reset/旋转、focus lost、pointer cancel、resize、最小化暂停。`pnpm run graphics101:build` 构建，`pnpm run graphics101:run` 启动。
- 原生 smoke：180 帧、100 次 resize 请求、自动输入与矩阵变化、0 validation error；这不是图像像素验收，也不覆盖 100 次 create/destroy 与 10 分钟压力测试。
- M0-A 初步实测：RTX 2060 SUPER 与 UHD Graphics 630 均匹配 DXGI/Vulkan LUID、创建 D3D11 NT handle，并成功将 RGBA8 D3D11_TEXTURE 导入、dedicated allocation、绑定 VkImage（transfer-dst 与 transfer-dst + color-attachment 两种 usage）。BGRA8 只查能力，没有实际导入。
- M0-B 初步实测：使用 DSH 安装的准确 Electron 44.7.0，在独立能力 fixture 中保留 sandbox/contextIsolation、禁用 nodeIntegration；import/finish/receiver API 可见，合成 VideoFrame 可以跨 contextBridge 回调。preload 关闭 frame 后页面对象宽度变为 0，不能把回调返回后的 frame 当成有效资源。尚未在真实 DSH preload 中运行。
- 重要 API 差异：本机 `sharedTexture.subtle.startTransferSharedTexture` 为 undefined，不能照搬参考示例；须继续验证 imported 对象上的准确传输契约。
- **门禁状态：M0-A 未通过、M0-B 未通过、M1 部分实现、M2 未开始。** Vulkan external ownership/实际写入、Electron 1500 帧显示、真实 GPU 消费完成租约、Chromium 多 GPU LUID 匹配均未验证。

判断：原生 3D 引入 DSH 仍值得继续验证，已有导入绑定与 sandbox API 可见性的正向证据；不足以宣称 GPU transport 或 DSH 内嵌成功。下一轮先解决准确版本的 transfer API 与真实纹理生命周期，再进入 shared-output，不关闭 sandbox、不用 CPU 帧流替代。

## 15. 独立 Electron sample（首轮验收通过）

按第二轮确认范围，先完成 `samples/electron-graphics101`，再修改 DSH。该 sample 是独立图形互操作验证壳，不是替代 DSH 的发行 shell。

- `pnpm run graphics101:build` 构建 worker；`pnpm run graphics101:electron` 打开网页 UI + 原生 3D canvas；`pnpm run graphics101:electron:smoke` 执行 1500 帧、100 次 resize 请求、输入 seq、RGB 像素诊断与退出检查。
- 显示路线：独立 C++ EXE 不创建 HWND → D3D11 分配 RGBA8 NT texture → Vulkan dedicated import 并直接 color attachment 渲染 → external ownership release + fence → main import → imported 对象的 `startTransferSharedTexture()` → sandbox preload finish/getVideoFrame → WebGPU canvas。
- `startTransferSharedTexture()` 属于 imported 对象，不属于 `sharedTexture.subtle`；首轮 undefined 结果不是 Electron 缺少传输能力。
- 生产端直接渲染到共享 surface，export GPU copy 为 0；WebGPU 全屏采样/渲染仍是一遍 GPU 呈现，不宣称整个链路零 GPU 操作。仅 smoke 最后一帧进行一次测试 readback，常规帧通道无 CPU 像素传输。
- 4 槽、最多 2 在途 + 1 排队；renderer queue completion、VideoFrame close、preload GPU release callback 后 ACK。resize 等旧环全部归还才重建，避免旧环无限累积。超时停止，不抢占 leased slot。
- 网页 UI 提供相机控制、暂停、全屏、输入测试框和诊断；canvas 聚焦才接键盘。固定 owning window/top-frame/local document 校验；页面不可指定 PID/handle/worker 路径。
- 安全限制：worker 对固定 main PID 使用 PROCESS_DUP_HANDLE，这是可信 native demo 能力，不是原生沙箱。Chromium 只核对 vendor/device ID，尚无精确 LUID，因此多块同型号 GPU 不在已验证支持范围。
- 仍待独立验证：真实 DSH preload/Host 拆分、100 次 create/destroy、10 分钟压力、句柄增长、GPU lost/renderer crash、发行安装。M0-B 的 DSH 专属部分及 M2 不因独立 sample 成功而标完成。

本机 RTX 2060 SUPER / Electron 44.7.0 实测：1500 帧呈现、100 次 resize 请求、102 个 epoch、RGB 三色像素均通过；1501 个交付租约全部归还，0 validation error / GPU exit / lease timeout，worker 正常 code 0 退出。M0-A 在该设备/驱动/格式范围内通过；M0-B 独立 sandbox transport 通过，但真实 DSH 接入仍待验证，M1 压力矩阵未完成。最终结果见 `.graphics101-results/electron-smoke.json`，可提交摘要见 `tests/graphics101-electron-baseline.json`；历史第一轮证据保留在 `tests/graphics101-baseline.json`。

## 本地参考

- RoboCute `samples/electron/README.md`、`protocol.js`、`main.js`、`preload.js`、`renderer/renderer.js`、`FUTURE.md`。
- RoboCute `rbc/extensions/ext_node/src/platform/shared_surface_win32.cpp`与`shared_surface.h`；头部历史注释与当前实现不一致时以实际代码为准。
- DSH `docs/architecture.zh.md`、`apps/desktop/src/preload-app.ts`、`ipc.ts`、`host-process.ts`、`apps/desktop/tsdown.config.ts`。
- DSH `packages/client/ui-sidebar-right/README.zh.md`：公开tab注册与生命周期。
- Godot `version.py`、`drivers/vulkan`、`servers/rendering`、`platform/windows/rendering_context_driver_vulkan_windows.cpp`。
