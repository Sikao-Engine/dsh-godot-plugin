# 为什么dsh-godot-plugin可以存在

Deepseek-Harness设计之初是webui，用cordis完成插件（本质上是一个nodejs package包），借助node运行时支持重载。而游戏引擎必然是一个桌面端，需要自己用图形API完成场景的渲染。虽然理论上可以编译为一个node extension由node启动，但是没有对应的桌面端组件，应用价值有限。

后续DSH