# dsh-godot-plugin

DeepSeek Harness 3D fork 的 Godot 集成插件。输出层重构后的 fork 引擎以原生 worker 形态提供 Godot 3D 视口：Vulkan 直写 D3D11 共享纹理（零拷贝、无回读），经线协议 2 与 DSH Desktop broker 交换帧与通用输入；消费通用输入与命名扩展协议 2。职责划分见 `doc/design/godot-worker-output.zh.md`，第一版接口设计见 `doc/design/native-viewport-api-v1.zh.md`，交互协议 v2（坐标映射/能力协商/文本 IME/指针锁定）见 `doc/design/interaction-protocol-v2.zh.md`。

## 构建方法（三步）

前置：Node ≥ 24.9、pnpm 11.28.5、Python 3 + SCons、VS 2022+ Build Tools + Windows SDK、Vulkan 驱动。开发机一键检查：`pnpm run godot:doctor`。

```bat
:: 1. scons 构建 fork 引擎（dsh_viewport=yes 输出层）
pnpm run godot:build
:: 2. 后处理脚本：暂存 worker + 生成 runtime-manifest.json（SHA-256/工具链/协议）
pnpm run godot:stage
```

随后 `pnpm run godot:verify`（进程内假 broker 协议验收）与 `pnpm run check`（typecheck+构建+测试）应全绿；桌面端到端启动与授权见 `doc/acceptance/build-and-package.zh.md` 第 1 节。

## 打包导出

## 打包导出与发布
```bat
pnpm run release:pack :: dist\dsh-godot-plugin-0.2.0.tgz（npm tarball，含 worker + editor）
node scripts\publish.mjs version 0.3.0 :: 递增版本（或 patch|minor|major）
node scripts\publish.mjs github :: gh release create v0.2.0（需干净树 + tag，附 SHA256SUMS.txt）
node scripts\publish.mjs npm :: 清洁 staging 后 npm publish（可 --tag beta）
```
发布流程（详见 `doc/acceptance/build-and-package.zh.md` 第 2 节）：
1. `node scripts/publish.mjs version <x.y.z>` 递增版本，补 `CHANGELOG.md` 对应小节；
2. `pnpm run check` 与 `pnpm run godot:verify` 全绿，桌面端到端按验收矩阵过一遍；
3. `git tag v<x.y.z> && git push origin v<x.y.z>` —— `.github/workflows/release.yml` 自动完成 scons 构建 → stage → pack → 建 Release（资产：tgz + SHA256SUMS.txt，notes 取自 CHANGELOG）；也可本地 `pnpm run release:pack && node scripts/publish.mjs github` 手动发布。

## 用户安装（GitHub Release）
Release 资产 `dsh-godot-plugin-<version>.tgz` 是**预构建**包（含 60 MiB worker，无需任何工具链）。三种等价方式：
```bat
:: A. 应用内「插件」页：安装本地文件，选下载好的 tgz
:: B. CLI 安装本地文件
dsh plugin --profile desktop add "C:\path\to\dsh-godot-plugin-0.2.0.tgz"
:: C. CLI 直链安装（无需先下载）
dsh plugin --profile desktop add https://github.com/Sikao-Engine/dsh-godot-plugin/releases/download/v0.2.0/dsh-godot-plugin-0.2.0.tgz
```
注意：`github:owner/repo@tag` 形态会从 git 源码构建——本仓库的引擎二进制与子模块不进 git（见 .gitignore），该形态**装出来没有 worker**，仅供能完整构建引擎的开发者使用；终端用户请用 Release 资产 tgz。npm 源用户：`dsh plugin --profile desktop add dsh-godot-plugin@<version>`。

## 当前能力

- producer `dsh-godot-plugin/godot`，扩展 `godot.demo.v1`（reset/rotate/query）与 `godot.viewport.v1`（setRelativeMouseMode/setRightDrag）；hello 声明 features：`interaction.map.v2`、`input.text`、`input.ime`、`pointer.lock`、`input.drop`（文件拖放默认导入 Godot,可勾选关闭）。内置旋转立方体演示场景（左键环绕、中键/右键/Shift+左键平移、滚轮/WASD/QE、R 重置、Space 旋转）。
- **editor 模式**（构建验证通过）：`godot:build:editor` → `godot:stage:editor` 产出 `dsh-godot-editor.exe`，以 `-e --path <工程>` 作为 producer args 运行完整 Godot editor；`godot:verify:editor` 假 broker 8 步全绿。两个 producer 同时注册，面板「模式」下拉随时切换运行时/编辑器（切换自动重挂载视口）。文本输入/IME 与指针锁定已随交互协议 v2 落地（hello features 能力协商、`input.text`/`input.ime`、`key` 字符 unicode、imeState 隐藏输入桥、指针锁定 UI，见 `doc/design/interaction-protocol-v2.zh.md`）；剪贴板仍为显式延后项（见验收文档 1.6/1.7）。
- Windows x64 / Electron 44.7.0 / D3D11 NT RGBA8 传输；2048×2048 配额、4 帧槽租约。
- 图形学 101（graphics101）保留为 `native/graphics101` 开发验证样例（`pnpm run graphics101:*`），不再随插件发布。

## 文件

- `godot/`：fork 子模块（分支 `dsh_godot_plugin`），输出层重构 + worker。
- `scripts/godot.mjs`：build/stage/verify/doctor 工具链入口。
- scripts/publish.mjs：pack / version（版本递增）/ GitHub Release（附 SHA256SUMS + CHANGELOG notes）/ npm 发布；scripts/ci-pin-deps.mjs：CI 专用 link: 依赖钉版。
- .github/workflows/release.yml：tag 推送触发全自动化发布（scons 构建 → stage → pack → Release）；ci.yml：PR 跑 check + CHANGELOG 版本小节守卫。
- `src/index.ts`：Cordis 服务 `ctx.godotIntegration`，注册原生 producer。
- `src/client.js`：右侧「Godot 视口」面板（attach/输入/WebGPU 呈现；手势抑制、resize 去抖与瞬态重映射）。
- `src/interaction-map.mjs`：CSS↔物理坐标映射、瞬态重映射与 resize 调度纯函数（client 与单测共用）。
- `tests/plugin.test.mjs`：清单、挂载/卸载、runtime-manifest 契约；`tests/interaction-map.test.mjs`：映射与调度纯函数单测。
- `doc/`：设计、验收与路线图。

## 限制

worker 模式不运行用户工程场景（后续里程碑）；多 GPU 适配器一致性同 graphics101 已知限制；`license: UNLICENSED` 对外发布前需改。`pnpm run dev` 只监听编译插件 JS；引擎改动需重跑 `godot:build` + `godot:stage`。
