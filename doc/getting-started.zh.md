# DSH Godot 插件开发入门报告

日期：2026-10-24。参考源码：`F:\repos\ai\deepseek-harness`，DSH `0.2.1-rc.3`、Cordis `4.0.5`。本报告的命令适用于 Windows CMD。

> 2026-10-25 更新：插件已进入 Godot worker 阶段（输出层重构完成，协议 2 全链路通过）。当前有效的构建/打包/发布验收步骤以 `doc/acceptance/build-and-package.zh.md` 为准；本文档保留插件管理器与 DSH 环境的基础说明，其中 graphics101 相关命令现以 `pnpm run graphics101:*` 前缀运行。

## 1. 需求与第一步边界

目标不是给聊天界面加一个 Godot 链接，而是独立开发 `dsh-godot-plugin`，未来让 DSH 承载 Godot 项目编辑、实时预览和应用分发。

你已确认第一步只做插件开发闭环。本阶段建立可编译、可发现、可安装、可卸载的 Host 插件；不下载 Godot，不假装已嵌入引擎，不改 DSH 内核，不发布软件。

## 2. 架构理解

DSH 不是带少量扩展点的固定内核，而是 Cordis 插件树。模型、工具、会话、agent loop、Web UI 都来自插件。插件通过 `inject` 等待服务，用 `ctx` 消费接口，用可逆副作用管理资源。

配置组合从低到高为：

1. profile 中依次列出的 bundle patch；
2. profile 自己的 `cordis.patch.yml`；
3. Harness home patch；
4. 本次启动的 `--patch` overlays。

patch 按 id 定位条目，替换整份 config，不是递归合并。一个普通 npm 包不会自动被管理器启用：需要 `package.json` 中的 `dsh.bundle.patch` 和实际 patch 文件。

Desktop 是 Electron 壳 + 私有 Node Host + 完整 Web 应用。Electron 用 RunAsNode 启动 Host；窗口先加载本地 Web 资源，收到启动注入后激活客户端插件。后端和前端经认证的 HTTP/WebSocket/RPC 通信，不是让渲染进程任意访问 Node。

Desktop 独占 `$DSH_HOME/profiles/desktop`。同一 home 下 Web 与 Desktop 共享受支持的产品数据，但插件包、启用选择、锁文件和 node_modules 独立。普通 npm/source CLI 不可启动或管理 desktop；开发桌面插件应走应用内“插件”页。

本插件目前只提供 `ctx.godotIntegration.status()`。它的 `runtimeEmbedded: false` 是真实能力声明；尚无客户端面板、模型工具或 Godot 进程。

## 3. 当前环境

- 本机 Node：`v25.6.1`，满足源码 `>=24.9.0`；后续建议使用源码 CI 覆盖的 Node 24/26。
- PATH pnpm：`12.5.1`；源码固定 `11.28.5`。本次使用源码 node_modules 中 `pnpm/bin/pnpm.mjs`，避免版本漂移。
- 源码已有安装依赖及 CLI、Web、Desktop、Cordis 产物。
- 当前插件目录未被 Git 识别为仓库；`.gitignore` 已准备，但不自动创建提交或远端。
- 插件的 Cordis 开发依赖链接到这份 checkout，以免引入另一份框架。`link:` 安装产生 peer 警告，但本地链接包自己拥有这份开发依赖；仍需实际加载验证。

所有辅助脚本使用 `.dsh-dev/home` 与 `.dsh-dev/electron-user-data`，避免改动日常 home 的凭据和插件。它们不读取或打印 API key。

## 4. 从源码构建 DSH

在任意目录可用绝对 `--dir`：

```bat
node --version
node "F:\repos\ai\deepseek-harness\node_modules\pnpm\bin\pnpm.mjs" --version
node "F:\repos\ai\deepseek-harness\node_modules\pnpm\bin\pnpm.mjs" --dir "F:\repos\ai\deepseek-harness" install
node "F:\repos\ai\deepseek-harness\node_modules\pnpm\bin\pnpm.mjs" --dir "F:\repos\ai\deepseek-harness" run build
```

全新 checkout 尚无内置 pnpm 时，先准备 Node/Corepack，再用 `corepack pnpm --dir "F:\repos\ai\deepseek-harness" install`，让 Corepack 按该仓库 packageManager 选择版本。

`build` 包含原生 system addon、Typert 生成、Host/Client 编译与 bundle、Electron 主进程 bundle、Web 前端、仓库 aggregate 类型检查。`build:artifacts` 只生产运行所需产物；`typecheck` 不产生完整可启动桌面/Web 资源。首次构建原生依赖可能需要 Windows 编译工具；失败时按具体诊断准备工具链，不能用旧产物冒充新构建通过。

可用当前仓库的 `pnpm run dsh:build` 调用同一个完整构建。

## 5. 构建本插件

在当前目录：

```bat
node "F:\repos\ai\deepseek-harness\node_modules\pnpm\bin\pnpm.mjs" install
node "F:\repos\ai\deepseek-harness\node_modules\pnpm\bin\pnpm.mjs" run check
```

`check` 执行严格类型检查、生成 `lib/index.js` / 声明，再运行 Node 测试。`pnpm run dev` 持续编译本插件；DSH 源码构建不负责构建这个树外包。

改变源码 checkout 位置时，需同时调整 package.json 的 Cordis link 与 `DSH_SOURCE_DIR`。环境变量只改变辅助脚本的源码路径，不自动重写依赖链接。

## 6. 加载默认插件与 Web 本地插件

以下 `pnpm` 均指 `11.28.5`，也可替换成前述绝对 Node + pnpm.mjs。

```bat
pnpm run dsh:install:web
pnpm run dsh:dump
pnpm run dsh:web
```

Web profile 首次从随附模板初始化，默认组合包括 `dsh-base`、`dsh-web-app`；不用逐个安装核心插件。`dsh:dump` 显示组合树，应包含 id/name 为 `dsh-godot-plugin` 的条目。`dsh:web` 使用共享 dsh launcher 启动 Web，不自动打开浏览器；使用终端给出的地址。

插件安装记录位于 `.dsh-dev/home/profiles/web/package.json`，本地依赖指向当前目录，并被选入 `dsh.profile.bundles`。以后编译本插件、重启 Host 即可加载新代码。需要卸载时：

```bat
set "DSH_HOME=F:\repos\myrepo\dsh-godot-plugin\.dsh-dev\home"
pnpm --dir "F:\repos\ai\deepseek-harness" run dsh plugin --profile web remove dsh-godot-plugin
```

这是独立 Web smoke 路径，不意味着 Desktop 同时启用了插件。

## 7. 启动 Electron 与加载桌面插件

先完成源码构建，再从当前目录启动：

```bat
pnpm run dsh:desktop
```

它调用源码 `start:desktop`，重建一次性开发 npm 项目、准备 primary-runtime，再启动已有产物。首次准备可能下载固定的 Python/Node/pnpm 依赖，耗时明显。想重新构建再启动，可在 DSH 源码运行 `pnpm run dev:desktop`；要保持同一隔离环境，应提前设置：

```bat
set "DSH_HOME=F:\repos\myrepo\dsh-godot-plugin\.dsh-dev\home"
set "DSH_DESKTOP_USER_DATA_DIR=F:\repos\myrepo\dsh-godot-plugin\.dsh-dev\electron-user-data"
pnpm --dir "F:\repos\ai\deepseek-harness" run dev:desktop
```

Electron 二进制未安装时，源码指南给出的准备命令是：

```bat
pnpm --dir "F:\repos\ai\deepseek-harness" --filter @deepseek-ai/dsh-desktop exec install-electron
```

欢迎页可选择“稍后配置”，无需 API key 验证插件加载。真实模型请求才需要你在应用中设置凭据；不要提交密钥。

桌面加载顺序：

1. 首次启动，让 Electron 初始化 desktop profile 与默认 Web 模板 bundle。
2. 进入主应用“插件”页，安装 `link:F:/repos/myrepo/dsh-godot-plugin`。
3. 确认列表显示“Godot 集成”，组件 id 为 `dsh-godot-plugin`，无加载错误；按管理器提示重启。
4. Host 输出应出现 `bootstrap ready; Godot runtime is not embedded`。只看列表 enabled 不足以证明加载成功。
5. 修改本插件后先 `pnpm run build`，再用开发菜单“重启应用与 Host”；刷新页面不重新构建，也不保证 Host 代码重载。

默认 HMR 只监控配置，本报告采用显式重建+重启，不配置任意源码 HMR 根。

## 8. 安装第三方插件

推荐应用内“插件”页：可安装 registry 的 `package@version`、Git spec、本地 bundle 或 tarball。先检查来源与版本要求，只安装可信代码。

Web CLI 示例（占位符需要替换为真实包）：

```bat
set "DSH_HOME=F:\repos\myrepo\dsh-godot-plugin\.dsh-dev\home"
pnpm --dir "F:\repos\ai\deepseek-harness" run dsh plugin --profile web add <package-name>@<exact-version>
pnpm --dir "F:\repos\ai\deepseek-harness" run dsh plugin --profile web list
```

官方可选 bundle 在插件页启用；源码开发的官方按需安装使用当前 checkout 的 `link:`，不是任意 registry 副本。核心默认 bundle 已随运行时提供。

安装版 Desktop：先启动一次初始化 profile，然后从托盘/菜单完全退出，再使用该 Desktop 自己安装的 dsh 命令：

```bat
dsh plugin --profile desktop add <package-name>@<exact-version>
dsh plugin --profile desktop list
```

该命令必须来自 Desktop 的“管理 dsh 命令”注册，不能换成 PATH 上另一个 npm dsh。重新打开应用后使用改动。源码开发桌面采用 UI，不绕过保留 profile 限制。

安全边界：第三方 Host 插件在宿主进程中执行，不受工作区沙箱保护；原生 addon 必须匹配 Electron Node ABI/平台/架构；依赖生命周期脚本需要单独审核。遇到 DSH 兼容性拒绝不默认添加版本豁免，遇到脚本被拦不默认全部批准。

## 9. Godot runtime / 编辑器 / 分发边界

以下是后续设计判断，不是第一步已经实现的能力：

- Web/WASM 游戏预览与完整原生 Godot 编辑器不同，不能把 iframe 预览称为完整编辑器嵌入。
- Godot 原生窗口嵌入不属于普通 DSH Web client API；需要研究 Godot 版本支持、原生窗口句柄/父子关系、尺寸/DPI、输入、焦点、GPU、生命周期与跨平台行为。普通插件不会自动获得 Electron 主进程接口。
- 原生进程或引擎扩展应由可卸载的 Host 服务管理；UI 通过可信 RPC seam 发命令、收状态。不要启用渲染进程 Node integration 来规避隔离。
- 需要模型调用时，再注册 `ctx.tools` 消费者；需要持久化、回放的模型可见结果，应记入会话事件，不把瞬态渲染状态当成模型历史。
- 分发最终需明确“DSH+插件+Godot runtime”与“导出的独立游戏”两种产物；分别处理 export templates、资源/PCK、许可证、签名、更新与版本一致性。第三方插件安装并不自动纳入 DSH 官方签名应用资源。

下一阶段应先冻结目标 Godot 版本与 Windows x64 场景，再选择原生 editor 窗口嵌入或游戏 preview 验证；本阶段不先创造未验证的原生桥接 API。

## 10. 验证记录

- 插件依赖安装：通过，使用 pnpm `11.28.5`。
- 插件类型检查、构建：通过。
- Node 测试：2/2，通过 bundle 清单、真实 Cordis 挂载/卸载/再次挂载。
- 本地插件安装进隔离 Web profile：通过，保存为 link 依赖。
- 完整 DSH 源码构建：通过，10 个 gate 全部成功（285.93 秒），记录 358 个客户端产物。
- 共享 CLI 配置组合：通过，默认 bundle 与本地 `dsh-godot-plugin` 条目同时存在。
- 首次 Web smoke 返回 303：这是携带启动 token 的认证重定向，不是页面启动故障。后续专项脚本处理重定向与 Cookie，并通过测试观察插件读取真实 `ctx.godotIntegration.status()`；不依赖默认日志级别。
- Electron `44.7.0` 二进制、primary-runtime 准备：通过，内置 Office runtime round trips 检查通过。
- 首次 Electron GUI 启动失败：当前执行环境继承 `ELECTRON_RUN_AS_NODE=1`，Electron 因此以 Node 模式解释 GUI 参数，报 `bad option: --remote-debugging-port=9222`。插件辅助启动脚本已仅对 GUI 启动子环境删除此变量，未改系统环境或 DSH 源码。
- 修正后 Electron 已重新提交启动；本次现场检查尚未发现 desktop profile，9222 调试接口拒绝连接，窗口和 desktop 本地插件加载未验收。后台任务结束结果仍待返回，不将启动请求等同于成功。

手动直接运行源码 GUI 命令时，在该终端先执行 `set "ELECTRON_RUN_AS_NODE="`；Host 自己会正确设置私有 RunAsNode 模式。

可重复 Web 专项验证：先 `pnpm run dsh:install:web`，再 `pnpm run test:web`。脚本使用随机端口，不打印启动 token，验证后关闭自己启动的测试 Host。

## 参考源码文档

- `F:\repos\ai\deepseek-harness\docs\architecture.zh.md`
- `F:\repos\ai\deepseek-harness\docs\cordis-primer.zh.md`
- `F:\repos\ai\deepseek-harness\docs\development.zh.md`
- `F:\repos\ai\deepseek-harness\apps\desktop\README.zh.md`
- `F:\repos\ai\deepseek-harness\packages\boot\plugin-manager\README.zh.md`
- `F:\repos\ai\deepseek-harness\docs\cookbook\adding-a-package.zh.md`
