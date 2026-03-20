# DreamWorks

> Experience-first screen recorder with circular webcam PiP, whiteboard, and live meeting. Built with Electron + React — a full desktop shell, not a minimal byte-sized utility.  
> 体验型录屏：圆形摄像头画中画、白板、在线会议。基于 Electron + React（完整桌面壳，安装体积大，不以「几 MB 极简」为卖点）。

DreamWorks 主界面

---

## 中文

### 我们为什么要做这个软件

在远程协作和内容创作中，我们常常需要同时展示屏幕、摄像头和手绘思路，但现有工具要么功能割裂，要么体积臃肿、体验卡顿。**DreamWorks** 希望把录屏、画中画、白板和在线会议整合进一个应用，让演示和会议更顺畅、更专注。

**DreamWorks 能帮你：**

- 一键录屏 + 摄像头画中画，无需切换多个软件
- 用白板实时画图、标注，配合屏幕共享讲清楚想法
- 在**同一局域网**内发起免费会议，无需依赖云服务
- 导出 WebM / MP4，方便分享和存档

### 核心优势

**丝滑体验**

- 界面简洁，操作路径短：屏幕 → 摄像头 → 录制，三步即可开始
- 白板、录屏、会议在同一窗口内切换，减少打断感
- 圆形画中画可拖拽定位，适配不同演示场景

**Mac 系统兼容性**

DreamWorks 基于 **Electron 33** 构建，支持以下 macOS 版本：


| 系统版本                       | 支持情况  |
| -------------------------- | ----- |
| **macOS 11 (Big Sur)**     | ✅ 支持  |
| **macOS 12 (Monterey)**    | ✅ 支持  |
| **macOS 13 (Ventura)**     | ✅ 支持  |
| **macOS 14 (Sonoma)**      | ✅ 支持  |
| **macOS 15 (Sequoia)**     | ✅ 支持  |
| macOS 10.15 (Catalina) 及更早 | ❌ 不支持 |


支持 **Intel** 与 **Apple Silicon (M1/M2/M3)** 架构。

### 功能概览

1. **Capture Screen** — 使用**系统原生**屏幕/窗口选取界面（macOS 为 Apple UI）。整屏请在原生界面中选**显示器 / Desktop**（通常在上方或顶栏），不要只选当前应用窗口。
  - **浏览器 (仅网页)**：使用浏览器自带的屏幕共享界面。
2. **Start Camera** — 圆形画中画，可拖拽调整位置
3. **Whiteboard** — Excalidraw 白板，支持绘图、标注
4. **Live Meeting** — WebRTC 视频会议，支持聊天、屏幕共享、录制、虚拟背景、实时转录
5. **Record** — 录制屏幕 + 摄像头合成画面，支持保存 WebM / MP4

### Excalidraw 白板：体验、存储与和录制的算力平衡

本节概括我们在 **Excalidraw** 集成上的工程取舍：让画布跟手、**贴图与场景不丢**、并在 **白板 + 摄像头录制** 时尽量少抢 CPU/GPU。

#### 交互与流畅度

- **缩放 / 触摸板**：`wheel` 只挂在**白板根节点**上，并配合 `composedPath` 过滤；避免在 `document` 上对全局 `wheel` 使用 `passive: false`，否则双指缩放会与主线程同步耦合、手感发涩。
- **平移（手型工具）**：`onChange` 在第三参已有 **files** 时尽量不再每帧调用 `getFiles()`；仅在实际编辑合并 **files** 映射，减轻大手笔场景下的主线程压力。
- **纸纹背景**：发现 Excalidraw 在平移时会改 `viewBackgroundColor` 时，用 **ref 修补 + 节流后的 `updateScene`**，避免在手型拖拽循环里和内核抢布局。

#### 图片与存储（不丢贴图 / 纹理）

- **多项目**：白板以 `whiteboardProjects` 存盘；单项目内保留 `elements`、`appState`、可选的 `**files`**（嵌入图片等二进制映射）。
- `**dreamwork` 备份字段**：在 `data.dreamwork` 中冗余保存 `**whiteboardTexture`**（纸纹 id）与完整 `**files**`，防止 Excalidraw 序列化路径未带齐 sibling 键时落地丢图。
- `**latestSceneRef**`：在 React 重渲染或 API 暂不可用时，仍能拿到最近一次场景的 **elements / appState / files**，供 **flush** 与导出使用。
- **持久化节奏**：结构性改动较快落盘；纯视口类变化可 `**requestIdleCallback` + rAF** 延后写入。Web 上磁盘写入 `**setTimeout(0)` 微延迟**，减轻 `JSON.stringify` 与 storage 同步卡住下一帧平移；**flushPersist**（切项目、页签隐藏、`beforeunload`、卸载）仍 **同步队列**，保证退出前数据一致。

#### 录制时摄像头与白板的 CPU/GPU 权衡

- **合成帧率**：白板录制使用 **固定目标帧率（如 30fps）** 的 canvas 捕获 + **rAF 节流**，避免与 Excalidraw 每帧抢满主线程。
- **非录制时省绘制**：全屏白板且未在录制时，**跳过**对大面积离屏合成的空闲重绘，把算力留给画布与指针。
- **画中画采样**：白板录制优先走 **门户内可见 `video` 直出**，并省略仅用于防抖的 **mirror cache** 填充路径，减少重复 `drawImage` 与格式转换。
- **发光 / 装饰**：白板录制时段 **抑制重阴影（glow）**，减轻合成与 GPU 混合成本。
- **白板位图来源**：录制侧在可能的情况下 stack 视口内多层 canvas，并按需 `**exportToCanvas`**；导出节奏与白板是否带摄像头等条件平衡，避免与合成环路同时打满。

---

### 本地使用指南

**环境要求**：Node.js 18+，npm 或 yarn

**安装与运行：**

```bash
git clone https://github.com/Funghi88/DreamWorks.git
cd DreamWorks
npm install
npm run dev
```

应用会在 Electron 窗口中打开。

**仅 Web 模式（无 Electron）：** `npm run dev:web`，然后访问 [http://localhost:5173](http://localhost:5173)

**Live Meeting：** 终端 1 运行 `npm run signaling`，终端 2 运行 `npm run dev`。多用户测试可在浏览器中打开 2+ 标签页访问 [http://localhost:5173](http://localhost:5173)

**构建 macOS 应用：**

- `npm run pack` — 生成 `.app`，输出至 `release/mac-arm64/DreamWorks.app`（可直接双击运行）
- `npm run dist` — 生成 `.dmg` 和 `.zip` 安装包，输出至 `release/`

### 截图


| 主界面           | Live Meeting     | 录制与导出   |
| ------------- | ---------------- | ------- |
| 主界面           | Live Meeting     | 录制与导出   |
| 录屏 + 画中画 + 白板 | 视频会议界面（Local 模式） | 录制控制与导出 |


### 项目进展

**Live Meeting 功能状态：** 加入/创建房间 ✅、音视频通话 ✅、屏幕共享 ✅、文字聊天 ✅、会议内录制 ✅、虚拟背景 ✅、实时转录 ✅、**局域网模式（同一 Wi-Fi 免费会议）** ✅（Electron 内置信令）

### 未来规划

**核心方向：局域网免费会议** — 在同一局域网下（如不同办公楼但同一 Wi-Fi）实现完全免费的线上会议。Electron 内置信令服务，主机创建房间后分享地址，参与者通过局域网地址加入。无需云服务器、无订阅费用、低延迟、数据不出内网。

**其他规划：** 白板与会议协作整合、录制导出优化、Windows/Linux 支持。

### 故障排除

**Capture Screen 在 macOS 上无效：** 开发时在 **系统设置 → 隐私与安全性 → 屏幕录制** 中为 **Electron** 授权；打包应用则为 **DreamWorks** 授权。

---

### Why We Built DreamWorks

Remote collaboration and content creation often require showing your screen, camera, and hand-drawn ideas at once. Most tools either split these into separate apps or feel heavy and sluggish. **DreamWorks** brings screen capture, PiP webcam, whiteboard, and live meeting into one app—so you can present and meet without juggling windows.

**What DreamWorks does for you:**

- One-click screen recording with circular webcam overlay—no app switching
- Real-time whiteboard for sketching and annotating alongside screen share
- **Free meetings over the same LAN**—no cloud dependency
- Export to WebM or MP4 for sharing and archiving

### Core Advantages

**Smooth experience**

- Minimal UI with a short flow: Screen → Camera → Record
- Whiteboard, recording, and meeting live in one window—fewer context switches
- Draggable circular PiP that fits any layout

**macOS compatibility**

DreamWorks is built on **Electron 33** and supports:


| macOS version                      | Support |
| ---------------------------------- | ------- |
| **macOS 11 (Big Sur)**             | ✅       |
| **macOS 12 (Monterey)**            | ✅       |
| **macOS 13 (Ventura)**             | ✅       |
| **macOS 14 (Sonoma)**              | ✅       |
| **macOS 15 (Sequoia)**             | ✅       |
| macOS 10.15 (Catalina) and earlier | ❌       |


Both **Intel** and **Apple Silicon (M1/M2/M3)** are supported.

### Features

1. **Capture Screen** — Native OS screen/window picker. Browser build uses the browser’s picker.
2. **Start Camera** — Circular PiP, draggable
3. **Whiteboard** — Excalidraw overlay for drawing and annotation
4. **Live Meeting** — WebRTC video calls with chat, screen share, recording, virtual backgrounds, live transcription
5. **Record** — Composite screen + webcam; save as WebM or MP4

### Excalidraw whiteboard: UX, storage, and balancing CPU/GPU with recording

This section summarizes how we integrate **Excalidraw**: keep the canvas responsive, **persist images and scenes reliably**, and **avoid fighting the GPU/CPU** when **recording the whiteboard with the webcam PiP**.

#### Interaction & smoothness

- **Zoom / trackpad:** `wheel` listeners are attached to the **whiteboard root** only, with `composedPath` filtering—**not** the whole `document` with `passive: false`, which can serialize pinch-zoom on the main thread and feel “sticky.”
- **Pan (hand tool):** In `onChange`, when Excalidraw passes **files** as the third argument, we avoid calling `getFiles()` on every tick; we merge the **files** map only when edits require it, which helps on image-heavy boards.
- **Paper texture:** If panning flips `viewBackgroundColor`, we **patch via ref** and apply a **throttled `updateScene`**, avoiding fighting Excalidraw’s hand-drag loop every frame.

#### Images & storage (no lost embeds / texture)

- **Projects:** Boards are stored under `**whiteboardProjects`**; each project keeps `elements`, `appState`, and optional `**files**` (binary map for pasted images, etc.).
- `**dreamwork` backup:** `data.dreamwork` redundantly stores `**whiteboardTexture`** (texture id) and the full `**files**` map when needed, so a slim serialization path doesn’t drop blobs.
- `**latestSceneRef`:** Holds the latest **elements / appState / files** even when React or the API is between states—used for **flush** paths and exports.
- **Persistence pacing:** Structural edits flush sooner; view-only changes may use `**requestIdleCallback` + rAF**. On the web, disk writes are **deferred one macrotask** to keep the next pan smooth; `**flushPersist`** (project switch, tab hidden, `beforeunload`, unmount) still runs **synchronously** so data is consistent on exit.

#### CPU/GPU trade-offs while recording (camera vs whiteboard)

- **Composite rate:** Whiteboard recording uses a **fixed target FPS** for canvas capture plus **rAF throttling**, so the compositor doesn’t starve Excalidraw every frame.
- **Idle work:** When **not** recording, full-page whiteboard mode **skips** expensive idle composite repaints so the canvas stays prioritized.
- **PiP sampling:** For whiteboard recording we prefer **drawing straight from the visible portal `<video>`** and **skip filling** the mirror-only canvas cache path when possible, cutting redundant `drawImage` work.
- **Decorations:** **Heavy glow / shadow** around the PiP is **suppressed** during whiteboard recording to reduce blending cost.
- **Board pixels for the encoder:** The recorder may prefer stacking **in-viewport canvases** and periodically `**exportToCanvas`**, tuned so export bursts don’t align every frame with the composite loop.

---

### Local setup

**Requirements:** Node.js 18+, npm or yarn

**Install and run:**

```bash
git clone https://github.com/Funghi88/DreamWorks.git
cd DreamWorks
npm install
npm run dev
```

The app opens in an Electron window.

**Web-only (no Electron):** Run `npm run dev:web`, then open [http://localhost:5173](http://localhost:5173)

**Live Meeting:** Terminal 1: `npm run signaling`. Terminal 2: `npm run dev`. For multi-user testing, open 2+ browser tabs at [http://localhost:5173](http://localhost:5173)

**Build for macOS:**

- `npm run pack` — Produces `.app` in `release/mac-arm64/DreamWorks.app` (double-click to run)
- `npm run dist` — Produces `.dmg` and `.zip` installers in `release/`

### Screenshots


| Main UI                   | Live Meeting               | Recording & Export            |
| ------------------------- | -------------------------- | ----------------------------- |
| Main UI                   | Live Meeting               | Recording                     |
| Screen + PiP + Whiteboard | Video meeting (Local mode) | Recording controls and export |


### Project status

**Live Meeting:** Join/create room ✅, audio/video ✅, screen share ✅, chat ✅, in-call recording ✅, virtual backgrounds ✅, live transcription ✅, **LAN mode (free same-WiFi meetings)** ✅ (embedded signaling in Electron)

### Roadmap

**Focus: free LAN meetings** — Run meetings over the same local network (e.g. different floors or buildings on the same Wi-Fi) with no cloud. The Electron app embeds a signaling server; the host creates a room and shares the URL; participants join via the LAN address. No cloud server, no subscription, low latency, data stays on your network.

**Planned:** Deeper whiteboard–meeting integration, recording/export improvements, Windows and Linux support.

### Troubleshooting

**Capture Screen not working on macOS:** When developing with `npm run dev`, the process runs as **Electron**. Add **Electron** under System Settings → Privacy & Security → Screen Recording. For the built app, add **DreamWorks** instead.

---

## Tech stack

- **Electron** — Desktop framework
- **React + TypeScript + Vite** — Frontend
- **Tailwind CSS v4 + Shadcn/UI** — Styling and components
- **getDisplayMedia + getUserMedia + MediaRecorder + Canvas 2D** — Media and recording

---

## Related docs

- [使用指南与技术说明](docs/USER_GUIDE.md) — 功能详解、操作步骤、适用场景（中文）
- [局域网会议测试指南](docs/TEST_LAN_MEETING.md) — 如何测试同一 WiFi 下多设备开会（中文）
- [Tauri vs Electron comparison](docs/TAURI_VS_ELECTRON.md) — Framework comparison (Chinese)

