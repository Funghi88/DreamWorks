# 局域网会议功能测试指南

本文档说明如何测试 DreamWorks 的 **Local（同一 WiFi）** 会议功能，验证不同设备能否在同一局域网下成功开会。

---

## 前置条件

1. **局域网模式仅支持 Electron 应用**（打包的 .app 或 `npm run dev`），不支持纯 Web 模式
2. 所有设备需连接**同一 Wi-Fi**
3. 麦克风、摄像头权限需已授权

---

## 测试方案一：同一台 Mac（快速验证）

用一台 Mac 同时模拟「主持人」和「参与者」，先确认流程能跑通。

### 步骤

1. **启动应用**
   ```bash
   cd DreamWorks
   npm run dev
   ```
   Electron 窗口会打开，并加载前端。

2. **主持人（Host）**
   - 点击 **Live Meeting**
   - 选择 **Local (same WiFi)**
   - 选择 **Create room**
   - 输入昵称（如 `Host`）
   - 点击 **New** 生成房间号（记下或复制该房间号，如 `abc123xy`）
   - 点击 **Join Meeting**
   - 加入成功后，界面会显示分享地址，例如：
     ```
     Share with participants: http://192.168.1.5:38472
     Same machine: http://localhost:38472
     ```
   - 需要分享给参与者的两样东西：**地址** + **房间号**

3. **参与者（Joiner）**
   - 打开浏览器，访问 **http://localhost:5173**
   - 点击 **Live Meeting**
   - 选择 **Local (same WiFi)**（浏览器端会显示 Mode 选项）
   - 选择 **Join room**
   - 在「Host address」输入框中粘贴地址（同一台机器用 `http://localhost:38472`）
   - 输入昵称（如 `Guest`）
   - 在「Room ID」输入框中输入 **Host 创建的房间号**（Host 界面会显示「Room ID: xxx」）
   - 点击 **Join Meeting**

4. **验证**
   - 两个窗口应能互相看到对方的视频
   - 可测试：静音/开麦、开关摄像头、聊天、屏幕共享

---

## 测试方案二：两台设备（真实局域网）

用两台连接同一 Wi-Fi 的设备（如两台 Mac，或 Mac + 另一台电脑）。

### 设备 A（主持人）

1. 运行 DreamWorks：
   - 开发：`npm run dev`
   - 或使用打包应用：`release/mac-arm64/DreamWorks.app`
2. 按「方案一」中 Host 的步骤创建房间并加入
3. 复制显示的地址，例如：`http://192.168.1.5:38472`
4. 将该地址和房间号发给设备 B

### 设备 B（参与者）

**若设备 B 是 Mac：**

- 安装并运行 DreamWorks（开发或打包版）
- 选择 Local → Join room
- 粘贴设备 A 的地址（如 `http://192.168.1.5:38472`）
- 输入相同房间号，加入

**若设备 B 是其他电脑（Windows/Linux）或手机：**

- 需要能访问 DreamWorks 的 Web 前端
- 开发时，需在主机上把 Vite 暴露到局域网：

  ```bash
  # 在项目根目录
  npx vite --host --port 5173
  ```

- 设备 B 在浏览器中访问：`http://<设备A的IP>:5173`
- 例如：`http://192.168.1.5:5173`
- 然后按 Join 流程，输入信令地址和房间号加入

---

## 常见问题排查

| 现象 | 可能原因 | 处理 |
|-----|---------|------|
| Joiner 无法连接 | 信令地址错误 | 确认使用 Host 显示的完整地址（含端口） |
| 连接超时 | 不在同一网络 | 确认两台设备连同一 Wi-Fi |
| 连接超时 | 防火墙拦截 | 检查 Mac 防火墙是否允许 DreamWorks/Node |
| 看不到对方视频 | 摄像头/麦克风未授权 | 在系统设置中为浏览器/应用授权 |
| 浏览器无法访问 5173 | Vite 未暴露到局域网 | 使用 `vite --host` 启动 |

---

## 获取本机 IP（用于分享）

在 Mac 终端执行：

```bash
# 查看 Wi-Fi 的局域网 IP
ipconfig getifaddr en0
```

或：**系统设置 → 网络 → Wi-Fi → 详细信息** 中查看 IP 地址。

---

## 测试检查清单

- [ ] Host 能成功创建房间并加入
- [ ] Host 界面显示分享地址（含 IP 和端口）
- [ ] Joiner 能通过地址 + 房间号加入
- [ ] 双方能互相看到视频
- [ ] 双方能互相听到音频
- [ ] 聊天功能正常
- [ ] 屏幕共享正常（若支持）
- [ ] 会议内录制正常（若支持）

---

*测试完成后，可将结果反馈到项目 issue 或文档中。*
