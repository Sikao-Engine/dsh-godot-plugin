# Changelog

All notable changes to dsh-godot-plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`publish.mjs github` extracts the section `## [X.Y.Z]` matching the released
version as the GitHub Release notes — always add one before tagging.

## [Unreleased]

## [0.2.0] - 2026-10-25

### Added

- Native Godot 3D viewport producer `dsh-godot-plugin/godot`: forked Godot
  engine worker (Vulkan -> D3D11 shared textures, wire protocol 2), built via
  `dsh_viewport=yes` scons target.
- Extensions `godot.demo.v1` (reset/rotate/query) and `godot.viewport.v1`
  (setRelativeMouseMode/setRightDrag); hello declares features
  `interaction.map.v2`, `input.text`, `input.ime`, `pointer.lock`, `input.drop`.
- Editor mode: second producer `dsh-godot-plugin/godot-editor` runs the full
  Godot editor (`-e --path <packageRoot>/native/editor-project`) with
  multi-window protocol v2.1 (editor popups as real sub-windows, FBX import
  preview, Game tab embedding); runtime/editor switch from the panel mode
  dropdown.
- Interaction protocol v2: coordinate mapping with transient remap on resize,
  text/IME input bridging (unicode key events, imeState hidden-input bridge,
  candidate window anchored at the engine caret), pointer lock UI.
- Built-in rotating-cube demo scene (orbit/pan/zoom, R reset, Space rotate).
- Packaging pipeline: `release:pack` (npm tarball with 60 MiB worker),
  `publish.mjs github|npm|all`, runtime-manifest.json with SHA-256/toolchain/
  protocol metadata, `publish.mjs version` bump command.

### Known limitations

- Windows x64 / Electron 44.7.0 / D3D11 NT RGBA8 only; 2048x2048 quota,
  4-slot frame lease.
- Worker mode does not run user project scenes yet.
- Clipboard bridging deferred (acceptance doc 1.6/1.7).
- Multi-GPU adapter consistency same as graphics101.
- `license: UNLICENSED` — replace with the real license before publishing
  outside the team.

[Unreleased]: https://github.com/Sikao-Engine/dsh-godot-plugin/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Sikao-Engine/dsh-godot-plugin/releases/tag/v0.2.0
