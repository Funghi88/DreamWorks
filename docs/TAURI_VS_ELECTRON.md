# Tauri vs Electron 框架对比

本文档从架构、性能、生态、开发体验等维度对比 Tauri 与 Electron，为桌面应用技术选型提供参考。

---

## 一、架构差异

| 维度 | Tauri | Electron |
|------|-------|----------|
| **前端渲染** | 系统原生 WebView（macOS WebKit、Windows WebView2、Linux WebKitGTK） | 内嵌 Chromium |
| **后端运行时** | Rust | Node.js |
| **打包方式** | 前端资源 + 小型 Rust 二进制 | 前端资源 + Chromium + Node.js 运行时 |
| **IPC 通信** | `tauri.invoke()` 直接调用 Rust 命令 | `ipcMain` / `ipcRenderer` 消息通道 |

**核心区别**：Tauri 复用系统 WebView，体积和内存占用更小；Electron 自带完整 Chromium，保证跨平台渲染一致性，但体积和资源消耗更大。

---

## 二、性能与资源占用

| 指标 | Tauri | Electron |
|------|-------|----------|
| **安装包体积** | 约 3–5 MB | 约 80–150 MB |
| **空闲内存** | 约 30–40 MB | 约 200–300 MB（复杂应用可达 400+ MB） |
| **启动时间** | 通常 < 500 ms | 约 1–2 秒 |
| **内存相对占用** | 基准 | 约为 Tauri 的 2 倍或更多 |

Tauri 在体积、内存和启动速度上明显优于 Electron，适合对资源敏感的轻量级应用。

---

## 三、安全模型

| 维度 | Tauri | Electron |
|------|-------|----------|
| **设计理念** | 安全优先，默认最小权限 | 功能优先，权限较开放 |
| **权限控制** | 基于 capability 的细粒度权限 | 需手动配置 sandbox、CSP 等 |
| **Node 暴露** | 无 Node.js，无 `require()` 等风险 | 需注意避免暴露 Node 高危 API |
| **系统 API** | 通过 Rust 命令显式暴露 | 通过 preload 和 IPC 暴露 |

Tauri 的权限模型更严格，适合对安全要求高的场景；Electron 需要开发者自行做好隔离和权限控制。

---

## 四、开发体验

| 维度 | Tauri | Electron |
|------|-------|----------|
| **技术栈** | 前端（任意） + Rust | 前端（任意） + Node.js |
| **学习曲线** | 需了解 Rust 基础 | 纯 JS/TS 即可上手 |
| **IPC 模式** | `invoke("command", args)` 直接调用 | 需定义 channel、处理 request/response |
| **调试** | 前端 DevTools + Rust 调试 | 成熟的前端 DevTools 生态 |
| **热重载** | 支持 | 支持（配合 Vite 等） |
| **生态成熟度** | 生态在快速成长 | 生态成熟，案例多 |

Electron 对前端开发者更友好；Tauri 在 IPC 设计上更简洁，但需要一定的 Rust 能力。

---

## 五、跨平台支持

| 平台 | Tauri | Electron |
|------|-------|----------|
| **macOS** | ✅（需 Xcode） | ✅ |
| **Windows** | ✅（需 WebView2） | ✅ |
| **Linux** | ✅（需 webkit2gtk） | ✅ |
| **构建复杂度** | 各平台依赖不同 | 相对统一 |
| **渲染一致性** | 依赖系统 WebView，可能有差异 | Chromium 统一，一致性更好 |

Electron 在跨平台一致性上更稳定；Tauri 依赖系统 WebView，不同平台表现可能略有差异。

---

## 六、适用场景

### 更适合 Tauri 的场景

- 轻量级工具、仪表盘、内部应用
- 对安装包体积、内存、启动速度敏感
- 团队具备或愿意学习 Rust
- 安全要求较高的应用

### 更适合 Electron 的场景

- 功能复杂、DOM 操作多的应用（如 IDE、协作工具）
- 需要大量 npm 生态和 Node 能力
- 追求跨平台渲染一致性
- 团队以 JS/TS 为主，希望快速迭代

---

## 七、典型应用案例

**Electron**：VS Code、Slack、Discord、Figma、Notion 等  
**Tauri**：1Password、Clash Verge、部分轻量级工具和编辑器

---

## 八、迁移考量（Tauri → Electron）

若从 Tauri 迁移到 Electron，主要变化包括：

1. **IPC**：`tauri.invoke` 改为 `ipcRenderer.invoke` + `ipcMain.handle`
2. **系统 API**：通过 preload 脚本暴露，而非 Rust 命令
3. **打包**：使用 electron-builder 等工具替代 Tauri 的打包流程
4. **体积与性能**：安装包和内存占用会明显增加，需在文档和用户预期中说明

---

## 九、总结

| 考量因素 | 倾向 |
|----------|------|
| 体积、内存、启动速度 | Tauri |
| 安全模型 | Tauri |
| 开发效率、生态成熟度 | Electron |
| 跨平台一致性 | Electron |
| 纯前端团队 | Electron |
| 轻量级、工具类应用 | Tauri |
| 复杂、功能密集型应用 | Electron |

选择时需结合项目目标、团队技术栈和资源约束综合权衡。
