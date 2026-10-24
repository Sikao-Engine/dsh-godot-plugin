# dsh-godot-plugin

DeepSeek Harness 3D fork 的独立 Godot 集成插件。目前通过 Graphics101 提供原生 Vulkan 视口，消费通用输入与命名扩展协议 2；不包含 Godot runtime 或编辑器。职责划分、当前进度与替换 runtime 的 API 见[第一版接口设计](doc/design/native-viewport-api-v1.zh.md)。

## 快速开始

在当前目录执行（Windows CMD）：

```bat
node "F:\repos\ai\deepseek-harness\node_modules\pnpm\bin\pnpm.mjs" install
node "F:\repos\ai\deepseek-harness\node_modules\pnpm\bin\pnpm.mjs" run check
node "F:\repos\ai\deepseek-harness\node_modules\pnpm\bin\pnpm.mjs" run dsh:doctor
```

PATH 中 pnpm 与源码要求一致时，可改用 `pnpm`。源码要求 `pnpm@11.28.5`；本机 PATH 当前为 `12.5.1`，所以以上命令使用源码自带的固定版本。

### 原生视口最简构建与启动

完全退出已有 Desktop 后，在 `F:\repos\myrepo\dsh-godot-plugin` 执行以下 Windows CMD 命令。前提是两仓依赖已安装，且本机具备 Visual Studio 2022 C++ Build Tools、Windows SDK 与 Vulkan SDK（含 glslc）；首次 CMake 配置需要下载 nlohmann/json。

```bat
set "DSH_BUILD_NATIVE_VIEWPORT=1"
set "DSH_DESKTOP_NATIVE_VIEWPORT=1"
node "F:\repos\ai\deepseek-harness\node_modules\pnpm\bin\pnpm.mjs" run release:stage
node "F:\repos\ai\deepseek-harness\node_modules\pnpm\bin\pnpm.mjs" run dsh:build
node "F:\repos\ai\deepseek-harness\node_modules\pnpm\bin\pnpm.mjs" run dsh:desktop
```

仅需两个启用参数：`DSH_BUILD_NATIVE_VIEWPORT=1` 在构建时包含 broker 与 preload；`DSH_DESKTOP_NATIVE_VIEWPORT=1` 在启动时授权原生 worker。两者不能互相替代，默认均关闭。当前限定 Windows x64 / Electron 44.7.0；通用 API 使用线协议 2，旧协议 1 插件不能混用。`dsh:desktop` 会清除继承的 `ELECTRON_RUN_AS_NODE`，避免 Electron 被误启动为 Node 模式。

`release:stage` 编译原生 worker 和插件客户端，将 exe 与 shader 放入 `native/win32-x64`，并更新 `runtime-manifest.json` 中的 SHA-256；不能只运行 `graphics101:build` 后就启动，否则 Desktop 使用的已暂存 exe 与摘要不会更新。`dsh:build` 构建上游产物并执行构建检查，不打安装包。首次或上游代码变更时运行完整流程；仅修改插件时可省略 `dsh:build`，但上游现有产物必须已开启原生视口。仅重启且两仓产物未变时，只需设置启动参数并运行 `dsh:desktop`。

这些脚本统一设置开发 `DSH_HOME` 为当前目录的 `.dsh-dev/home`，Electron 浏览器数据为 `.dsh-dev/electron-user-data`。Web 与 Desktop 的插件选择仍相互独立。启动 Desktop 后，在“插件”页安装 `link:F:/repos/myrepo/dsh-godot-plugin`，按插件管理器提示重启。不能用普通源码 CLI 管理保留的 desktop profile。协议发现应报告 `protocol: 2`；右侧 Graphics101 视口持续产帧表示基本呈现路径可用，不代表 Godot runtime 已接入或完整故障恢复已验收。

Web 调试不提供原生视口，使用以下独立流程：

```bat
pnpm run dsh:install:web
pnpm run dsh:web
```

详细构建、第三方插件、桌面加载与未来原生嵌入边界见 [入门报告](doc/getting-started.zh.md)。

后续 GPU 视口与 Godot 接入采用 PC 优先、Vulkan 首选、DirectX 兜底里程碑；完整阶段、DSH Electron 最小接口及上游 PR 设计见 [开发总计划](doc/design/development-plan.zh.md) 和 [路线图](doc/roadmap.md)。

## 文件

- `src/index.ts`：Cordis 服务 `ctx.godotIntegration`，`status()` 明确报告尚未嵌入 runtime。
- `cordis.patch.yml`：可被插件管理器发现的 bundle 配置。
- `scripts/dsh-dev.mjs`：源码路径、隔离 home、构建与启动入口。
- `tests/plugin.test.mjs`：清单、挂载、卸载、重新挂载验证。
- `locale/`：插件页中英文元信息。

`pnpm run dev` 只监听并编译本插件。修改后重启 DSH Host；默认 HMR 只保证配置重载，不承诺任意源码热更新。

本仓库暂为 `private: true`。发布前须移除开发链接依赖、确认兼容版本和打包内容；本阶段不发布 npm 包。
