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

1. **Capture Screen** — **Electron（macOS）**：应用内列表选取**整台显示器**或**单个窗口**（主进程 `desktopCapturer`，非 Apple 系统全屏 picker；整屏请在列表中选显示器条目）。**浏览器**：使用浏览器自带的屏幕共享界面。
2. **Start Camera** — 圆形画中画，可拖拽调整位置
3. **Whiteboard** — Excalidraw 白板，支持绘图、标注
4. **Live Meeting** — WebRTC 视频会议，支持聊天、屏幕共享、录制、虚拟背景、实时转录
5. **Record** — 录制屏幕 + 摄像头合成画面，支持保存 WebM / MP4

**录制与成片（当前版本）**

- **输出画幅**：横屏可选 **16∶9** 或 **16∶10**（与常见外接屏 / MacBook 内建屏对应）；竖屏可选 **3∶4** 或 **9∶16**，分辨率档 **1080p / 2K / 4K**（具体像素由 `outputAspect` 表统一计算）。
- **黑边与内容适配**：可设黑边背景（纯黑或自定义图），内容在画幅内 **拉伸 / 等比包含 / 等比裁切**（`letterboxMode`）。
- **共享窗口 / 白板占比**：**Share %**（约 40–100%）控制屏幕共享或白板在成片中的占比；横屏、竖屏捕获下可在黑边内 **平移** 共享窗口；仅白板录制时可 **平移** 已适配的白板表面。
- **白板录制小地图**：录制白板时可用 **布局小地图** 预览最终成片框，在小地图内拖动 **画中画**、调整 Share 占比或平移白板区域，与主界面合成逻辑对齐。
- **设置面板**：**可拖动、可改大小的浮动设置窗**（无全屏遮罩，便于对照画面调参），位置与尺寸会写入设置并持久化。

**PiP 背景 vs macOS 系统摄像头效果（含 Presenter Overlay）**

- **系统里「背景 / Portrait」**：由 macOS 在系统层处理；Electron/网页通过 `getUserMedia` 拿到的通常是**未带系统虚拟背景**的原始摄像头画面，所以 **DreamWorks 圆环里不会显示**你在系统菜单里选的天空。**打成安装包 / 正式版也一样**，不是开发版才受限。
- **应用内 PiP bg**：在 Settings 里 **PiP bg**（在 **Bg** 上方）选 **Custom image** 并上传，由应用内分割实现换背景；需要**实时摄像头**，且不要用 Source 里的静态「Use image」顶替真人。

### Excalidraw 白板：体验、存储与和录制的算力平衡

本节概括我们在 **Excalidraw** 集成上的工程取舍：让画布跟手、**贴图与场景不丢**、并在 **白板 + 摄像头录制** 时尽量少抢 CPU/GPU。

#### 交互与流畅度

- **缩放 / 触摸板**：`wheel` 只挂在**白板根节点**上，并配合 `composedPath` 过滤；避免在 `document` 上对全局 `wheel` 使用 `passive: false`，否则双指缩放会与主线程同步耦合、手感发涩。
- **平移（手型工具）**：`onChange` 在第三参已有 **files** 时尽量不再每帧调用 `getFiles()`；仅在实际编辑合并 **files** 映射，减轻大手笔场景下的主线程压力。
- **纸纹背景**：发现 Excalidraw 在平移时会改 `viewBackgroundColor` 时，用 **ref 修补 + 节流后的 `updateScene`**，避免在手型拖拽循环里和内核抢布局。

#### 图片与存储（不丢贴图 / 纹理）

- **多项目**：白板以 `whiteboardProjects` 存盘；单项目内保留 `elements`、`appState`、可选的 `**files`**（嵌入图片等二进制映射）。
- `**dreamwork` 备份字段**：在 `data.dreamwork` 中冗余保存 `**whiteboardTexture`**（纸纹 id）与完整 `**files`**，防止 Excalidraw 序列化路径未带齐 sibling 键时落地丢图。
- `**latestSceneRef**`：在 React 重渲染或 API 暂不可用时，仍能拿到最近一次场景的 **elements / appState / files**，供 **flush** 与导出使用。
- **持久化节奏**：结构性改动较快落盘；纯视口类变化可 `**requestIdleCallback` + rAF** 延后写入。Web 上磁盘写入 `**setTimeout(0)` 微延迟**，减轻 `JSON.stringify` 与 storage 同步卡住下一帧平移；**flushPersist**（切项目、页签隐藏、`beforeunload`、卸载）仍 **同步队列**，保证退出前数据一致。
- **Electron 与 Web 同一路径落盘**：自动保存统一为 `saveWhiteboardProjects(loadSettings(), …)` + `saveSettings` 同步合并，**不再**在 Electron 分支用 `loadSettingsAsync().then(...)` 拼盘，避免异步读盘与连续保存竞态把 `whiteboardProjects` 覆盖成旧快照（曾可能导致「白板内容消失」的观感）。

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

**日常开发：** 保持 **一个** `npm run dev` 终端常开即可。修改 `src/` 由 Vite **热更新**；修改 `electron/`（主进程、preload）时 **electronmon** 会**自动重启** Electron 窗口，一般不必反复输入 `npm run dev`（只有关掉终端或结束进程后才需再开）。

**仅 Web 模式（无 Electron）：** `npm run dev:web`，然后访问 [http://localhost:5173](http://localhost:5173)

**Snap Camera Kit（可选，自用 / 私有）：** 复制 `.env.example` 为 `.env`，设置 `VITE_ENABLE_SNAP_CAMERA_KIT=true` 及 `VITE_SNAP_API_TOKEN`、`VITE_SNAP_LENS_ID`、`VITE_SNAP_LENS_GROUP_ID`（见 [Snap Camera Kit](https://camera-kit.snapchat.com/) 开发者后台）。若计划**开源或公开发布**本仓库或分支，请先阅读 `src/config/featureFlags.ts` 与 Snap 条款再保留该集成。

**Live Meeting：** 终端 1 运行 `npm run signaling`，终端 2 运行 `npm run dev`。多用户测试可在浏览器中打开 2+ 标签页访问 [http://localhost:5173](http://localhost:5173)

**构建 macOS 应用：**

- `npm run pack` — 生成 `.app`，输出至 `release/mac-arm64/DreamWorks.app`（可直接双击运行）
- `npm run dist` — 生成 `.dmg` 和 `.zip` 安装包，输出至 `release/`

### 截图


| 主界面               | Live Meeting                | 录制与导出       |
| ----------------- | --------------------------- | ----------- |
| 主界面：录屏 + 画中画 + 白板 | Live Meeting：视频会议（Local 模式） | 录制与导出：控制与导出 |


### 项目进展

**录制与界面：** 可配置成片比例与分辨率、黑边与 Share / 白板布局、白板录制布局小地图、浮动可持久化设置面板（与当前 `src/` 实现一致）。

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

1. **Capture Screen** — Electron (macOS): in-app picker listing **full displays** and **individual windows** (`desktopCapturer`, not Apple’s fullscreen system sheet). Browser build uses the browser’s picker.
2. **Start Camera** — Circular PiP, draggable
3. **Whiteboard** — Excalidraw overlay for drawing and annotation
4. **Live Meeting** — WebRTC video calls with chat, screen share, recording, virtual backgrounds, live transcription
5. **Record** — Composite screen + webcam; save as WebM or MP4

**Recording & export (current build)**

- **Output frame:** Landscape **16∶9** or **16∶10**; portrait **3∶4** or **9∶16**; resolution tiers **1080p / 2K / 4K** (pixel sizes from a single `outputAspect` table).
- **Letterboxing:** Background can be black or a **custom image**; content fit modes **stretch / contain / crop** inside the encode frame (`letterboxMode`).
- **Share / whiteboard fill:** **Share %** (~40–100%) scales how much of the frame the screen share or whiteboard occupies; pan the share window inside letterbox on landscape/portrait capture, and pan the fitted whiteboard **surface** in whiteboard-only recording.
- **Whiteboard recording minimap:** While recording the board, use the **layout minimap** to preview the final frame—drag **PiP**, adjust Share %, or pan the board area in sync with the main compositor.
- **Settings UI:** **Floating Settings** window—drag the header, resize from the corner, no fullscreen dimmer—geometry is **persisted** so your layout survives restarts.

### Excalidraw whiteboard: UX, storage, and balancing CPU/GPU with recording

This section summarizes how we integrate **Excalidraw**: keep the canvas responsive, **persist images and scenes reliably**, and **avoid fighting the GPU/CPU** when **recording the whiteboard with the webcam PiP**.

#### Interaction & smoothness

- **Zoom / trackpad:** `wheel` listeners are attached to the **whiteboard root** only, with `composedPath` filtering—**not** the whole `document` with `passive: false`, which can serialize pinch-zoom on the main thread and feel “sticky.”
- **Pan (hand tool):** In `onChange`, when Excalidraw passes **files** as the third argument, we avoid calling `getFiles()` on every tick; we merge the **files** map only when edits require it, which helps on image-heavy boards.
- **Paper texture:** If panning flips `viewBackgroundColor`, we **patch via ref** and apply a **throttled `updateScene`**, avoiding fighting Excalidraw’s hand-drag loop every frame.

#### Images & storage (no lost embeds / texture)

- **Projects:** Boards are stored under `**whiteboardProjects`**; each project keeps `elements`, `appState`, and optional `**files`** (binary map for pasted images, etc.).
- `**dreamwork` backup:** `data.dreamwork` redundantly stores `**whiteboardTexture`** (texture id) and the full `**files`** map when needed, so a slim serialization path doesn’t drop blobs.
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

**Day-to-day dev:** Keep **one** `npm run dev` running. Edits under `src/` hot-reload via Vite; edits under `electron/` trigger **electronmon** to **restart** the Electron window—no need to re-run `npm run dev` each time (only after you stop the terminal or kill the process).

**Web-only (no Electron):** Run `npm run dev:web`, then open [http://localhost:5173](http://localhost:5173)

**Snap Camera Kit (optional, private / self-use):** Copy `.env.example` to `.env` and set `VITE_ENABLE_SNAP_CAMERA_KIT=true` plus `VITE_SNAP_API_TOKEN`, `VITE_SNAP_LENS_ID`, and `VITE_SNAP_LENS_GROUP_ID` from the [Snap Camera Kit](https://camera-kit.snapchat.com/) developer portal. If you plan to **open-source or publicly ship** this repo or a fork, re-read `src/config/featureFlags.ts` and Snap’s terms before keeping this integration.

**Live Meeting:** Terminal 1: `npm run signaling`. Terminal 2: `npm run dev`. For multi-user testing, open 2+ browser tabs at [http://localhost:5173](http://localhost:5173)

**Build for macOS:**

- `npm run pack` — Produces `.app` in `release/mac-arm64/DreamWorks.app` (double-click to run)
- `npm run dist` — Produces `.dmg` and `.zip` installers in `release/`

### Screenshots


| Main UI                            | Live Meeting                          | Recording & export             |
| ---------------------------------- | ------------------------------------- | ------------------------------ |
| Main UI: screen + PiP + whiteboard | Live Meeting: video call (Local mode) | Recording: controls and export |


### Project status

**Recording & UI:** Configurable encode aspect and resolution, letterbox/fit options, Share / whiteboard layout controls, whiteboard-recording layout minimap, and a persisted floating Settings panel (matches current `src/`).

**Live Meeting:** Join/create room ✅, audio/video ✅, screen share ✅, chat ✅, in-call recording ✅, virtual backgrounds ✅, live transcription ✅, **LAN mode (free same-WiFi meetings)** ✅ (embedded signaling in Electron)

### Roadmap

**Focus: free LAN meetings** — Run meetings over the same local network (e.g. different floors or buildings on the same Wi-Fi) with no cloud. The Electron app embeds a signaling server; the host creates a room and shares the URL; participants join via the LAN address. No cloud server, no subscription, low latency, data stays on your network.

**Planned:** Deeper whiteboard–meeting integration, recording/export improvements, Windows and Linux support.

### Troubleshooting

**Capture Screen not working on macOS / no “Entire Screen” in the picker:**

1. **Screen Recording must be ON (blue)** for the exact app you’re running — **Electron** when using `npm run dev`, **DreamWorks** when using the built `.app`. If you see both **DreamWork** and **DreamWorks** in the list, enable the one that matches your build (or enable both while testing).
2. After changing permission, **quit and reopen** the app (macOS often won’t refresh the picker until restart).
3. **macOS + Electron:** The main process uses a `**desktopCapturer`-based** `setDisplayMediaRequestHandler` (no `useSystemPicker`). **Capture Screen** opens an in-app picker (sections *Full display (entire monitor)* vs *A single window*; `screen:` sources are full displays, `window:` sources are individual windows). Enable **Screen Recording** for **Electron** / **DreamWorks**. The renderer still uses `src/lib/displayMedia.ts` (video first, then optional audio).
4. **Apple’s system picker vs this list:** Enabling only `useSystemPicker` (true native UI) caused `**getDisplayMedia` → “Not supported”** in testing on this Electron + macOS combo, so the app uses `**desktopCapturer` + the in-app sheet** instead. Upgrading Electron later may allow revisiting the native path.

**Whiteboard / teleprompter text “missing” after `npm run pack`:** Your edits are **not** inside the `.app` — they are stored in the OS user folder, e.g. macOS: `~/Library/Application Support/DreamWorks/settings.json`. The packaged app uses the **same** path, so data should carry over. If it doesn’t:

1. **Old folder name:** Older builds may have used `~/Library/Application Support/dreamwork/` — the app **auto-migrates** from `dreamwork` to `DreamWorks` when the new file is empty or missing.
2. **Web-only dev:** If you only ran the UI in a **browser** (`localhost`), data lived in **browser localStorage**, not in that file — use **Electron** (`npm run dev` or `electron .`) so saves go to disk, or copy settings manually.
3. **Bundle a snapshot into the next pack:** Run `npm run copy-settings-to-defaults` (copies your current `settings.json` into `defaults/`), then `npm run pack`. See `defaults/README.md`.

---

## Tech stack

- **Electron 33** — Desktop framework (see `package.json` for pinned minor)
- **React 19 + TypeScript + Vite 7** — Frontend
- **Tailwind CSS v4 + Shadcn/UI** — Styling and components
- **getDisplayMedia + getUserMedia + MediaRecorder + Canvas 2D** — Media and recording

---

## Related docs

- [使用指南与技术说明](docs/USER_GUIDE.md) — 功能详解、操作步骤、适用场景（中文）
- [局域网会议测试指南](docs/TEST_LAN_MEETING.md) — 如何测试同一 WiFi 下多设备开会（中文）
- [Tauri vs Electron comparison](docs/TAURI_VS_ELECTRON.md) — Framework comparison (Chinese)
- [脸部 Effect：MediaPipe 精修 vs Jeeliz PoC](docs/FACE_EFFECTS_MEDIAPIPE_VS_JEELIZ.md) — 资源与趣味向选型对比（中文）

