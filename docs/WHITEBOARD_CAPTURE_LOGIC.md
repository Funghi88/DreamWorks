# Whiteboard 与 Capture Screen 逻辑说明

## 一、布局结构 (contentAreaRef)

```
┌─────────────────────────────────────────────────────────────────┐
│  contentAreaRef (flex, 主内容区)                                  │
│  ┌──────────────────────┬────┬──────────────────────────────┐   │
│  │ Whiteboard            │ 14 │ Capture Screen               │   │
│  │ (fullPageContentRef)  │ px │ (previewRef / screenMiniStripRef)│
│  │                       │Handle│                              │   │
│  └──────────────────────┴────┴──────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### 两种模式

| 模式 | activeScreenStream | Whiteboard | Handle | Capture Screen |
|------|-------------------|------------|--------|----------------|
| **白板模式** | false | flex-1 (主区域) | 14px | width=whiteboardPanelWidth (默认 40px) |
| **录屏模式** | true | width=whiteboardPanelWidth | 14px | flex-1 (主区域) |

- `whiteboardPanelWidth` 默认 40，可拖拽 ResizeHandle 调整
- 白板模式：右侧是 Capture Screen 的 mini strip（40px），可拖拽展开
- 录屏模式：左侧是白板的 mini strip，右侧是屏幕主区域

---

## 二、Composite 绘制 (drawComposite)

### 输入
- `preview`: 当 !activeScreenStream 时 = overlay div 或 contentAreaRef（fallback）
- `w, h`: 录制时用 RECORD_RESOLUTIONS（1920×1080 等），否则用 preview 尺寸
- **Overlay 渲染条件**：`!activeScreenStream && (showPip && (cameraStream || avatarImageSrc) || isRecording)` — 录制白板时必须渲染 overlay，否则 compositeRef 为 null，无法显示录制内容（黑屏）

### 分支逻辑

1. **有屏幕流 (screenVideo.srcObject)**  
   → 画 letterbox 背景 + 屏幕视频

2. **白板模式 (!activeScreenStream)**  
   → 画 letterbox 背景 + 白板内容 + **右侧面板 (14px handle + 40px bar)**

3. **其他**  
   → 只画 letterbox 背景

### 白板模式录制时的布局（应保持）

```
┌─────────────────────────────────────────────────────────────────┐
│ 0                     w-54                              w        │
│ ├─────────────────────────────────────────┤├──┤├────────┤       │
│ │          Whiteboard 区域                  │14││  40px   │       │
│ │  (白板内容，可为 TV 风格)                  │px││  bar   │       │
│ │                                          │  ││         │       │
│ └─────────────────────────────────────────┴──┴┴─────────┘       │
└─────────────────────────────────────────────────────────────────┘
```

- `miniW` = 40（右侧 bar 宽度）
- `handleZonePx` = 14（handle 区域）
- `whiteboardSurfaceW` = w - 40 - 14 = w - 54
- 右侧必须绘制：14px 浅色 handle 区 + 40px 深色 bar

---

## 三、ref 分配

| ref | 白板模式 | 录屏模式 |
|-----|----------|----------|
| previewRef | overlay div（含 composite） | Capture Screen div |
| compositeRef | overlay 内的 canvas | Capture Screen 内的 canvas |
| fullPageContentRef | 白板 div | 白板 div |
| screenMiniStripRef | Capture Screen div | - |
| contentAreaRef | 父容器 | 父容器 |

---

## 四、摄像头 (PIP)

- 位置：`fullPagePipPos`，可拖拽
- 边界：contentAreaRef 内
- 白板模式：overlay 覆盖全 contentArea，摄像头可放在任意位置
