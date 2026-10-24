# 原生视口第一版通用 API 与进度

## 摘要

本插件消费 DSH 3D fork 的通用原生视口 API。第一版通用设计使用线协议 2，明确淘汰早期的相机命令协议 1；不表示 Godot runtime 已接入。上游负责进程、GPU 纹理租约和通用事件，下游负责引擎行为与编辑器协议。

## 当前进度

| 能力 | 当前状态 | 实现位置 |
|---|---|---|
| Cordis 插件与右侧视口 | 已实现注册、挂载和卸载路径 | src/index.ts、src/client.js |
| 原生渲染 | Godot worker（fork 4.8.beta）：演示场景；graphics101 保留为开发样例 | godot/（platform/windows/dsh_*） |
| GPU 输出 | Vulkan 与 D3D11 共享纹理，NT 句柄复制到 broker | godot/platform/windows/dsh_shared_frames_win32.cpp |
| Desktop 导入 | Electron sharedTexture → VideoFrame → 客户端 WebGPU | 上游 Desktop broker 与 preload |
| 通用交互 | 指针、滚轮、DOM code 键盘、焦点、resize 与 visibility | 上游协议 2；godot/platform/windows/dsh_viewport_worker.cpp 输入映射 |
| 引擎操作 | graphics101.camera.v1 已退役；godot.demo.v1 提供 reset 与 rotate | 下游 demo 控制器 |
| Godot runtime | 已接入（worker 模式，协议 2 全链路 `pnpm run godot:verify` 通过） | godot/ 输出层重构，见 godot-worker-output.zh.md |

现状由源码和本次实际执行的检查确定；已有旧报告中的 GPU 验证不能自动成为新协议的验证证据。完整 Desktop 组合、重启、GPU 丢失和插件热卸载仍需独立验收。

## 分层

1. Host 插件注册 producer：`protocol: 2`、包内 executable、sha256、args、extensions；卸载时 revoke。
2. 客户端通过 `capabilities.protocol` 与 `list()` 发现能力，`attach(id)` 等待 worker hello 与适配器检查。
3. 客户端提交通用控制，worker 使用 JSONL 接收；上游不再解释相机操作或数字键码。
4. 原生适配器将通用输入转换为相机或 Godot 输入，产出共享纹理帧。
5. 客户端 presenter 等待 GPU 队列完成；preload 和 main 依序释放导入，最后向 worker 发送 release。

第一版保留 Windows x64 / Electron 44.7.0 / D3D11 NT RGBA8，不提供假装可用的跨平台或 CPU fallback。协议不是 native window reparent，也不公开 HWND、原始 IPC 或任意 executable 路径。

## 上层交互 API

`control(generation, { kind: 'input', seq, event })` 发送 pointer、wheel、key 或 focus。指针位置为视口局部 CSS 像素，左上原点；resize 为物理像素并携带 scale。滚轮转换为 CSS 像素，键盘使用 DOM code，修饰位为 Shift=1、Control=2、Alt=4、Meta=8。失焦、隐藏和取消捕获清除拖动或按住状态。

`control(generation, { kind: 'extension', seq, namespace, name, payload })` 发送有界 JSON。命名空间必须由 producer 注册并携带版本。Graphics101 只声明 `graphics101.camera.v1`：reset 的 payload 为 null，rotate 的 payload 为 `{ value: boolean }`。Worker 可反向输出 extension 事件。序号只保证交互准入与应用顺序，不代表请求结果、GPU 完成或持久化。

`onFrame()` 借用 VideoFrame，禁止保留或 close，回调必须等待 GPU 使用完成。`dispose()` 等待 worker 真正退出。错误之后不自动重试命令或回收仍被使用的 slot。

## 替换 Godot runtime

保持上游 API 不变，下游替换 executable 和 producer ID，更新 manifest 摘要及声明的扩展。该替换已按 worker 模式实现（见 godot-worker-output.zh.md）：producer `dsh-godot-plugin/godot`、扩展 `godot.demo.v1`、协议 2 全链路验收 `pnpm run godot:verify`。Godot 适配器负责将通用事件映射为 Godot InputEvent，处理 focus、surface 尺寸与 CSS/物理像素转换，完成 GPU 导出和 lease 同步。

场景树、节点选择、变换、资源打开、undo/redo、编辑模式与运行模式保留在下游 `godot.editor.v1` 等独立协议中。需要 RPC 的操作在 payload 内规定 requestId、result、error、取消与幂等语义，不能把 frame.inputSeq 当成调用完成。尚未有 Godot 实现，不提前冻结场景 schema。

Godot Vulkan texture 不能直接当成可用 Electron 句柄。替换 runtime 前先验证外部纹理格式、跨进程句柄、同一 GPU、GPU 完成和旧 surface 释放；运行时外部 helper 也必须遵守这些所有权要求。

## 迁移与维护

线协议 1 不做兼容回退。两仓同时构建；更新 release staging 中的 executable 和 digest，再重启 Desktop。旧插件发送 orbit/dolly 或旧文本 stdin 命令时，新协议不接受。

上游长期保留纯通用载体，下游保留 Graphics101 验证样例和 Godot 适配。Fork 以独立身份、更新源和发布验证矩阵维护；同步 upstream 不改变实验状态或暗示主干承诺。后续合入按协议定义、Cordis 注册服务、Desktop provider、GPU 生命周期验证分批评审，而不是把 demo 业务整体推入 Desktop。

## 开发备注

后续设计尚非承诺：公开浏览器安全类型包和 Cordis 服务；注册与撤销完成确认；错误码；多视口配额配置；bounded JSONL framing 与背压；第二个引擎验证；其他 OS 的资源传输。上游协议细节由 `apps/desktop/native-viewport.md` 与对应源码维护，本文件不复制其完整字段目录。
