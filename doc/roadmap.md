# 开发路线

总设计见 [dsh-godot-plugin 开发总计划](design/development-plan.zh.md)。计划已调整为 **PC 优先、Vulkan 首选、DirectX 兜底首个 demo 里程碑**；显示路径始终是 sharedTexture → VideoFrame → WebGPU，不采用 HWND 或 CPU 帧流回退。

## 已有基础

- [x] 阅读 DSH/Cordis 架构与 Desktop profile 归属。
- [x] 初始化独立 `dsh-godot-plugin` bundle、Host 服务、类型检查与构建。
- [x] 验证真实 Cordis 挂载、卸载、再次挂载。
- [x] 安装到隔离 Web profile，验证真实服务和认证 HTML。
- [x] DSH 源码构建与开发 Electron 启动验证。
- [x] 提供源码开发入门与模型/第三方认证排查文档。
- [ ] 完成 Electron 窗口中本地 Godot 插件骨架加载人工验收。

## 实施里程碑（设计完成，代码尚未实现）

| 阶段 | 交付 | 关键门禁 |
| --- | --- | --- |
| M0-A | Vulkan/Windows shared texture 能力探针 | D3D 资源互操作、同适配器、外部 ownership 与同步 |
| M0-B | DSH sandbox/preload 能力探针 | 不开放任意 Electron，不全局关闭 sandbox |
| M1 | C++ Graphics101 三角形、相机输入、独立 Electron viewer | GPU 无回读、输入/resize、租约与故障清理 |
| M2 | DSH 通用 Native Viewport seam、Graphics101 内嵌 | Host/main/client 职责、安全校验、可撤销资源 |
| M3 | 可安装发行的 DSH 插件 demo | 干净机器、tarball、原生资源、能力版本 |
| M4 | 修改 Godot，提供 Vulkan runtime producer | Render graph 输出/同步、真实场景与输入 |
| M5-A | DSH Godot 编辑工作台与游戏分发 | 编辑保存、运行停止、导出、升级卸载 |
| M5-B | 完整 Godot Editor 嵌入（独立门禁） | 多窗口、popup、IME、拖放、编辑器快捷键 |

上游 DSH 路线：RFC → capability/session seam → sharedTexture transport 与外部 demo。暂不创建或提交远端 PR。

Vulkan 探针建议时间盒 3～5 个有效开发日；失败保留证据，首个发行 demo 显式选 DirectX，继续独立验证 Vulkan，不降低显示路径要求。

下一步实际开发限定 M0 与 M1，不先改 Godot。阶段验收标准、目录草案、发行与移动端边界均在总设计中。
