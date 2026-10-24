# dsh-godot-plugin 构建与打包验收

日期：2026-10-25。适用版本：插件 0.2.0 + fork 分支 `dsh_godot_plugin`（上游 4.8.beta）。输出层重构说明见 `doc/design/godot-worker-output.zh.md`。

## 0. 产物形态

| 产物 | 路径 | 说明 |
|---|---|---|
| Godot worker 可执行文件 | `native/win32-x64/dsh-godot-worker.exe` | scons 构建的 fork 引擎（`dsh_viewport=yes`），协议 2 原生 worker |
| 运行时清单 | `runtime-manifest.json` | producer id、扩展、SHA-256、工具链、需求（stage 时重新生成） |
| 插件 JS | `lib/` | Cordis 服务（注册 producer）+ 客户端视口面板 |

限定：Windows x64 / Electron 44.7.0 / DSH `0.2.1-rc.3` 原生视口预览 fork（协议 2）。扩展命名空间 `godot.demo.v1`。

## 1. 构建方法（开发机）

流程：**装依赖 → scons 构建 → 后处理脚本（stage）→ 从仓库根目录安装进 DSH**。

### 1.1 前置条件

| 依赖 | 检查 | 不满足时 |
|---|---|---|
| Node ≥ 24.9 | `node --version` | 安装 Node 24/26 |
| pnpm 11.28.5 | `node <DSH>/node_modules/pnpm/bin/pnpm.mjs --version` | 用 DSH 源码内置 pnpm（本机 PATH 的 12.5.1 与源码不一致） |
| Python 3 + SCons | `pnpm run godot:doctor` | `python -m pip install scons` |
| VS 2022+ Build Tools + Windows SDK | `pnpm run godot:doctor` | 安装 Visual Studio（MSVC 14.5x / Windows SDK 10） |
| Vulkan 驱动 | 运行时由 GPU 驱动提供 | 无需 Vulkan SDK（构建用 volk + 内置头） |

```bat
node ..\deepseek-harness-3d\node_modules\pnpm\bin\pnpm.mjs install
node scripts\godot.mjs doctor
```

`doctor` 输出各组件状态、fork commit、worker 二进制是否存在。DSH 源码路径默认取 `../deepseek-harness-3d`（候选回退 `../../ai/deepseek-harness`），可用环境变量 `DSH_SOURCE_DIR` 覆盖。

### 1.2 scons 构建（第一步）

```bat
pnpm run godot:build
```

等价于在 `godot/` 目录执行：

```
scons platform=windows target=template_release arch=x86_64 dsh_viewport=yes ^
      lto=none production=no optimize=speed trace_dev=no accesskit=no d3d12=no -j<核心数>
```

- 首次全量约 15–40 分钟（增量构建秒级到十秒级）。
- 额外参数放 `--` 之后，如 `pnpm run godot:build -- optimize=size`。
- 产物：`godot\bin\godot.windows.template_release.x86_64.exe`。
- `dsh_viewport=no`（默认）构建的引擎与上游行为一致，worker 代码全部编译期剔除。

### 1.3 后处理脚本（第二步）

```bat
pnpm run godot:stage
```

`scripts/godot.mjs stage` 做四件事：

1. 复制 worker 到 `native/win32-x64/dsh-godot-worker.exe`；
2. 计算 SHA-256 写入 `runtime-manifest.json`；
3. 记录工具链（SCons/Python 版本、target/arch）与两仓 commit；
4. 声明扩展 `godot.demo.v1`、协议 2、运行需求。

### 1.4 从仓库根目录安装进 DSH（第三步）

插件管理器从**本仓库根目录**直接安装（`package.json` 的 `dsh.bundle.patch` + `cordis.patch.yml` 使其可被发现）。两种等价方式：

开发用（源码 CLI，隔离 home，安装为 link 依赖）：

```bat
pnpm run dsh:install:web       :: 安装进 .dsh-dev\home 的 web profile
pnpm run dsh:web               :: 启动 Web Host
```

桌面原生视口（必须用应用内插件页，普通 CLI 不能管理 desktop 保留 profile）：

1. `pnpm run dsh:desktop` 启动 Desktop（需 DSH 源码已构建且 `DSH_DESKTOP_NATIVE_VIEWPORT=1` 授权，见 `scripts/dsh-dev.mjs`）；
2. 「插件」页安装 `link:D:\ws\repos\dsh-godot-plugin`，按提示重启；
3. Host 日志应出现 `Godot worker ready (...)` 与 `Godot producer registered: dsh-godot-plugin/godot`；未先 stage 会明确报 `runtime-manifest.json missing`。

### 1.5 验收（构建后必跑）

```bat
pnpm run godot:verify              :: 运行时 worker：假 broker 7 步全绿（ok:true），60fps 持续产帧
pnpm run check                     :: 插件 typecheck + 构建 + node --test
pnpm run dsh:dump                  :: 组合树应含 dsh-godot-plugin 条目
```

桌面端到端（需要 Electron）：插件页看到「Godot 视口」标签页 → 启动 → 右侧视口持续产帧（真机 RTX 5070 Ti 上 60fps）；协议发现 `protocol: 2`；`godot:verify` 已过不等于桌面组合已过，桌面验收记录沿用 `doc/getting-started.zh.md` 第 10 节格式单独填写。

### 1.6 Editor worker（构建验证已通过，长尾交互延后）

同一套输出层重构直接承载 Godot editor——editor 就是 SceneTree 的一个 payload（`main.cpp:4687` 的 `EditorNode` 分支），渲染与输入管线与运行时完全一致。子窗口因 `has_feature(FEATURE_SUBWINDOWS)=false` 自动内嵌（`window.cpp:3382`），与 editor 的 `single_window_mode` 叠加后无需多窗口支持。

```bat
pnpm run godot:build:editor        :: target=editor（137 MiB，debug_symbols 便于崩溃定位）
pnpm run godot:stage:editor        :: native/win32-x64/dsh-godot-editor.exe + runtime-manifest.editor.json
pnpm run godot:verify:editor       :: 假 broker 编辑真工程：surface/滚轮驱动 12 帧/输入+扩展(inputSeq 47)/
                                    :: 隐藏停帧/二次 resize/停止，7 步全绿（ok:true）
```

两个 producer（`dsh-godot-plugin/godot`、`dsh-godot-plugin/godot-editor`，配额 8 内）同时注册；面板第二行「模式」下拉从 `nativeViewports.list()` 动态发现可用 producer，切换运行时/编辑器并自动重挂载视口。**重启 Host** 按钮为前向兼容：仅在 `dshDesktop.app.restart` API 存在时显示（需要 DSH 侧提供对应 IPC；当前 fork 未改动，按钮自动隐藏）。editor 产物默认**不进**发布包（`files` 白名单只含运行时 worker）。

editor producer 的注册 args 为 `-e --path <packageRoot>/native/editor-project`（manifest `projectDir` 字段在注册时解析），因此切到编辑器看到的是**真实 Godot editor 编辑包内工程**；不带这些参数的 editor 二进制会回退成内置 demo 场景（这就是早期"切了还是方块"的原因）。注意两点：① 137 MiB editor 首次冷启动（Windows Defender 扫描）可能超过 broker 5s hello 时限导致首次附加失败——状态栏会提示，停止/启动再 attach 一次即可（缓存热后秒开）；② 编辑器会向工程目录写 `.godot/` 缓存，包安装目录只读的场景需要后续做工程拷贝链（当前开发 link 安装无此问题）。

已验证的 editor 行为：EditorNode 启动崩溃修复（DS 需创建 `NativeMenu` 单例）；`OS::alert` 在 worker 模式转 stderr（原生消息框会挂起隐藏进程）；滚轮/点击驱动按需重绘；隐藏完全停帧。**延后项**：文本输入/IME（协议输入 type 校验只接受 4 种，计划走 `godot.editor.v1` 扩展通道承载 `InputEventKey.unicode`）、剪贴板（DisplayServer 本地 buffer 可进程内复制粘贴）、relative mouse mode（3D freelook）、真实工程供给与保存链路。

## 2. 打包导出方法

### 2.1 打出 npm tarball（本地）

```bat
pnpm run release:stage         :: 插件 tsc + 客户端 bundle + godot stage（四件套齐备）
pnpm run release:pack          :: dist\dsh-godot-plugin-0.2.0.tgz
```

`release:pack` = `publish.mjs pack`：校验 `lib/`、`cordis.patch.yml`、`runtime-manifest.json`、`native/win32-x64/dsh-godot-worker.exe` 齐备 → `npm pack` → 打印内容清单（必须包含 `lib/`、`cordis.patch.yml`、`locale/`、`native/win32-x64/`、`runtime-manifest.json`）。tarball 约 60 MiB（worker 本体）。

安装方使用（应用内插件页或源码 CLI）：

```bat
dsh plugins install dist\dsh-godot-plugin-0.2.0.tgz
dsh plugins install dsh-godot-plugin@0.2.0        :: npm 源方式
dsh plugins install github:sailing-innocent/dsh-godot-plugin@v0.2.0   :: Git spec 方式
```

### 2.2 发布到 GitHub Release

```bat
:: 前置：gh CLI 已认证（publish.mjs 会执行 gh auth status）；工作区干净；tag 已存在
git tag v0.2.0
git push origin v0.2.0
pnpm run release:publish -- --dry-run    :: 预演（不真正创建）
node scripts\publish.mjs github           :: 或只发 GitHub
```

`publish.mjs github`：校验 origin 为 GitHub 远端、工作区干净、`v<version>` tag 存在 → `gh release create v0.2.0 dist/<tgz> --notes-file doc/acceptance/build-and-package.zh.md`。Git spec 安装（`github:owner/repo@tag`）即拉取该 Release 资产或仓库 tarball。

### 2.3 发布到 npm 源

```bat
node scripts\publish.mjs npm              :: 或 npm run release:publish（npm + github 全量）
node scripts\publish.mjs npm -- --tag beta    :: 预发布通道
```

`publish.mjs npm` 在系统临时目录生成**清洁 staging 副本**：剔除开发期 `link:` 依赖与 `scripts` 字段（`files` 白名单本就只含运行时产物），再 `npm publish --access public`。默认 registry 取 `npm_config_registry`（公司内部源可直接配置后发布）。发布前 checklist：

- [ ] `package.json` 无 `link:` 依赖残留（脚本会提示但不会替你删）；
- [ ] `version` 已递增、与 Git tag 一致；
- [ ] `license` 当前为 `UNLICENSED`——对外发布前改为实际许可证；
- [ ] `engines.dsh` 与实际上游协议版本一致（当前 `0.2.1-rc.3`）。

### 2.4 版本与同步流程

1. fork 改动合并后：`pnpm run godot:build && pnpm run godot:stage`（manifest 记录新 godotCommit）；
2. 递增 `package.json` version；
3. `pnpm run release:pack` 本地验收；
4. tag → `publish.mjs github` / `publish.mjs npm`；
5. 下游升级：`dsh plugins install dsh-godot-plugin@<new>`。

## 3. 故障对照

| 现象 | 原因与处理 |
|---|---|
| stage 报 worker binary not found | 先 `pnpm run godot:build` |
| verify hello 失败/超时 | 无 Vulkan 驱动或适配器不匹配；看 stderr 诊断 |
| 插件加载报 manifest missing | 未 stage；运行 `pnpm run godot:stage` 后重启 Host |
| 桌面无「Godot 视口」页 | 未设 `DSH_DESKTOP_NATIVE_VIEWPORT=1` 或用了非预览 fork 的 DSH |
| attach 报 adapter IDs differ | 多 GPU：Chromium 选了别的新卡；与 graphics101 相同限制 |
| 帧停但进程在 | broker 未按约回 release；10s 看门狗报错，attach 会失败属预期 |
