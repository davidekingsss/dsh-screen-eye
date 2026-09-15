# dsh-screen-eye

给 macOS 上的 DeepSeek Harness 装一只**自主的眼睛**：agent 截屏后**在同一次工具调用里直接拿到图**，于是它能自己去看正在运行的应用、弹窗、报错，或者自己刚写的界面——不必再让你手动截图。

仅支持 macOS。无原生构建步骤、不带预编译二进制、零依赖。

## 它提供什么

两个模型可调用的工具：

| 工具 | 作用 |
|---|---|
| `screenshot` | 截屏，并把图片本身作为 `image` 内容块返回给模型——模型是真的看得见。 |
| `screen_permission` | 报告 macOS 当前是否允许本进程截屏；不允许时直接打开对应的系统设置面板。 |

`mode` 决定截什么：`screen`（默认，整个桌面）、`display`（单块屏幕）、
`region`（指定矩形），以及需要人交互的 `window` / `select`（等待用户点选
窗口或拖拽出选区）。

## 为什么需要这个插件

多数截图工具假设难点在于「取像素」。在 macOS 上难点是**权限**，而且它失败
的样子像 bug：

```
screencapture: could not create image from display
```

macOS 把截屏能力锁在「屏幕录制」权限后面，而该权限挂在**责任进程**上——也就是
macOS 认为要对整棵进程树负责的那个应用。而 DeepSeek Harness 的宿主往往不是
一个正常的 GUI 应用：应用内插件市场通过一个 detached 的辅助进程重启宿主，
宿主因此被挂到 `launchd` 之下，其上方不存在任何应用身份。这样的进程去申请
屏幕时，macOS 无法把请求归属到任何用户可以授权的对象上，于是**直接拒绝，且
连授权弹窗都不会出现**。

这个权限无法用程序授予：TCC 数据库受 SIP 保护，`tccutil` 只能重置，
`CGRequestScreenCaptureAccess` 对非 bundle 进程拒绝弹窗。所以本插件只做真正
做得到的事：

- **检测**：真的去截一次并按结果分类，而不是靠启发式猜测；
- **算准目标**：从正在运行的宿主推导出**必须被授权的那一个可执行文件**，而不是
  泛泛描述；
- **打开面板**：按需直接跳转到系统设置里对应的那一页；
- **把步骤当作工具结果返回**：于是 agent 交给你的是一份修复指引，而不是一段
  报错。

## 安装

```sh
dsh plugin --profile web add github:davidekingsss/dsh-screen-eye
# 然后重启 dsh
```

若用本地检出目录，而不是已发布的源：

```sh
dsh plugin --profile web add link:/path/to/dsh-screen-eye
```

本插件没有构建步骤、没有依赖，安装期不编译任何东西。

## 授予屏幕录制权限（一次性）

调用一次 `screenshot`。如果缺权限，返回结果会明确告诉你该怎么做；
`screen_permission` 配合 `action: "open_settings"` 会直接替你打开设置面板。
简言之：

1. 打开 **系统设置 → 隐私与安全性 → 屏幕与系统音频录制**。
2. 点 **+**，按 **⌘⇧G**，粘贴工具报告的那个路径（通常是运行 harness 的
   `node` 二进制），选中它。
3. 把它的开关打开。

**不需要重启**——授权对下一次截图即生效。

若你是从终端启动 harness，改为给那个终端 App 授权，效果相同。

> macOS 可能定期要求重新确认此权限，把同一个开关重新打开即可。

## 配置

所有键都是可选的。

| 键 | 默认值 | 含义 |
|---|---|---|
| `outputDir` | `<DSH home>/screen-eye` | 截图 PNG 的落盘目录。 |
| `locale` | `en` | 引导文案语言：`en` 或 `zh`。 |
| `timeoutMs` | `120000` | 单次截图的协作式时间预算。 |
| `keepRecent` | `50` | `outputDir` 里保留的最新截图数量。一张截图是几 MB 的 PNG，而用眼睛的 agent 会截很多张，所以这个目录默认是有上限的。设为 `0` 表示全部保留。 |
| `requireImageCapableModel` | `true` | 当调用方模型未声明图片输入时直接拒绝，而不是返回一张它看不见的图。 |
| `deleteAfterCommit` | `false` | 提交到附件存储后删除 PNG。默认关闭，以便返回的路径可再次读取。 |

清理**只会删除本插件自己写出的文件**：`outputDir` 的直接子项、且文件名严格匹配
本插件生成的形状（`shot-<时间戳>-<后缀>.png`）的普通文件。它绝不递归、绝不动
其他命名规则的文件，也绝不会删掉刚刚返回给你的那一张。

```yaml
# cordis.patch.yml
- insert:
    - id: screen-eye
      name: dsh-screen-eye
      config:
        locale: zh
        outputDir: /Users/me/Pictures/agent-shots
        keepRecent: 200
```

## 实现

```
screenshot 工具 ──▶ lib/capture.mjs ──▶ /usr/sbin/screencapture ──▶ PNG
                       │
                       └──▶ attachments.saveImage() ──▶ image 内容块 ──▶ 模型
```

截图走系统自带的 `screencapture(1)`，而不是自带一个私有辅助二进制。这是刻意的
取舍：`screencapture` 不需要任何编译产物、由 Apple 签名，并且在当前 macOS 上
内部已经使用 ScreenCaptureKit。自带辅助二进制则意味着要产出多架构构建和一个
ad-hoc 签名——而它的哈希每次重新构建都会变，**哈希一变，用户的屏幕录制授权
就静默失效**。

图片通过与内置 `read_image` 完全相同的附件通道抵达模型，因此其校验、降采样与
会话回放行为与任何其他图片一致。

## 平台支持

仅 macOS，且在两处强制：bundle patch 带
`disabled: !!js process.platform !== 'darwin'`，其他平台**连模块都不会被
import**；`apply()` 再检查一次，使得绕过 patch 的直接挂载也无法注册没有引擎
的截图工具。

Windows 不存在等价的权限闸门——任何进程都可以截屏，所以 Windows 引擎根本不
需要引导流程。之所以没有包含它，是因为在本仓库的开发环境里无法测试它，而
声明未经测试的平台支持，比明说边界更糟。
[`docs/windows.md`](docs/windows.md) 记录了关于它的调研结论、一个朴素实现会
踩到的坑，以及如果你想加，接缝在哪里。

## 环境要求

- macOS，以及 harness 自身的 Node 运行时（截图链路不需要额外安装任何包）。
- 一个声明了图片输入的模型路由。保持 `requireImageCapableModel` 默认值时，
  纯文本路由会在事前被拒绝，并在消息里点名该模型，而不是悄悄截一张它看不见
  的图。

## 开发

```sh
npm install
node test/selftest.mjs
```

该测试套件无需启动 harness：逻辑模块被直接导入，工具定义经由桩上下文执行，
因此在一台从未装过 harness 的机器上同样能跑——CI 走的就是这条路。真正实拍的
用例只在本机已获得屏幕录制权限时运行，所以在授权之前套件依然是绿的。

插件导入的三个 `@deepseek-ai/*` 包在 `devDependencies` 里**精确钉版本**，这是
刻意的：这几个包把当前版本线发在 `next` dist-tag 下，而 `latest` 仍指向一个
老得多的版本，不钉版本就会装到旧的那一个、import 直接失败。

[`docs/verification.md`](docs/verification.md) 记录了**实际跑过**的内容——
自测、隔离 profile 中的加载器验收、以及一次端到端 agent 回合——并说明每一项
证明了什么、没证明什么。

## 许可证

MIT
