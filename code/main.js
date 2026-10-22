const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  Notification,
  nativeImage,
  shell,
  systemPreferences,
  desktopCapturer,
  dialog,
  ipcMain,
} = require("electron");
const path = require("path");
const fs = require("fs");
const net = require("net");

if (app.isPackaged) {
  process.env.LUYIN_USER_DATA = app.getPath("userData");
}

// 标记当前由 Electron 桌面壳启动，服务端据此开放截图、通知等桌面能力。
process.env.LUYIN_RUNTIME = "electron";

const server = require("./server/index");

const PORT = 3456;
let floatWin = null;
let dashWin = null;
let tray = null;
// 开发态录音目录改为 code/ 下，打包后由 LUYIN_USER_DATA 指向系统用户数据目录。
const DEV_USER_DATA = __dirname;
const gotSingleInstanceLock = app.requestSingleInstanceLock();

// 防止用户重复打开同一个桌面应用实例，避免第二个实例再次监听固定端口。
if (!gotSingleInstanceLock) {
  app.quit();
}

function getResourcePath(...segments) {
  // 打包后资源位于 process.resourcesPath，开发态仍从 code/ 目录读取。
  const root = app.isPackaged ? process.resourcesPath : path.join(__dirname, "buildResources");
  return path.join(root, ...segments);
}

async function ensureMicPermission() {
  if (process.platform !== "darwin") return true;
  const status = systemPreferences.getMediaAccessStatus("microphone");
  if (status === "granted") return true;
  return await systemPreferences.askForMediaAccess("microphone");
}

async function ensureScreenPermission() {
  if (process.platform !== "darwin") return true;
  const status = systemPreferences.getMediaAccessStatus("screen");
  if (status === "granted") return true;
  /* 调用一次 desktopCapturer 来触发系统权限弹窗 */
  try {
    await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } });
  } catch {}
  const after = systemPreferences.getMediaAccessStatus("screen");
  if (after !== "granted") {
    dialog.showMessageBoxSync({
      type: "warning",
      title: "需要屏幕录制权限",
      message: "截图功能需要「屏幕录制」权限。\n请在系统偏好设置 → 隐私与安全性 → 屏幕录制中允许本应用，然后重启应用。",
      buttons: ["去设置", "稍后"],
    }) === 0 &&
      shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
      );
    return false;
  }
  return true;
}

function createFloatWindow() {
  floatWin = new BrowserWindow({
    width: 64,
    height: 64,
    x: 60,
    y: 200,
    alwaysOnTop: true,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    transparent: true,
    titleBarStyle: "hidden",
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  floatWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  floatWin.setWindowButtonVisibility(false);
  floatWin.loadURL(`http://localhost:${PORT}`);
  // 悬浮球没有系统窗口按钮，右键弹出托盘菜单，给用户一个明确退出入口。
  floatWin.webContents.on("context-menu", () => {
    if (tray) tray.popUpContextMenu();
  });
  floatWin.on("closed", () => (floatWin = null));
}

/* ── 悬浮窗动态缩放 ── */
ipcMain.on("resize-float", (_event, width, height) => {
  if (!floatWin) return;
  const [x, y] = floatWin.getPosition();
  floatWin.setBounds({ x, y, width, height }, true);
});

function createDashboardWindow() {
  if (dashWin) {
    dashWin.show();
    dashWin.focus();
    return;
  }
  dashWin = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "录音助手 - 控制面板",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: "#f1f5f9",
    webPreferences: { contextIsolation: true },
  });
  dashWin.loadURL(`http://localhost:${PORT}/dashboard`);
  dashWin.on("closed", () => (dashWin = null));
}

function createTray() {
  const icon = nativeImage
    .createFromPath(getResourcePath("trayTemplate.png"))
    .resize({ width: 18, height: 18 });
  // macOS 菜单栏适合模板图标，系统会自动适配深浅色模式。
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("录音助手");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开仪表盘", click: createDashboardWindow },
      {
        label: "显示悬浮球",
        click: () =>
          floatWin ? floatWin.show() : createFloatWindow(),
      },
      {
        label: "打开录音目录",
        click: () => {
          const dir = process.env.LUYIN_USER_DATA
            ? path.join(process.env.LUYIN_USER_DATA, "recordings")
            : path.join(DEV_USER_DATA, "recordings");
          fs.mkdirSync(dir, { recursive: true });
          shell.openPath(dir);
        },
      },
      { type: "separator" },
      { label: "退出", click: () => app.quit() },
    ])
  );
  tray.on("click", createDashboardWindow);
}

// 启动内置 HTTP 服务前先探测端口，端口被开发版或旧进程占用时给出可理解提示。
function checkPortAvailable(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", (error) => {
      resolve(error.code !== "EADDRINUSE");
    });
    probe.once("listening", () => {
      probe.close(() => resolve(true));
    });
    probe.listen(port);
  });
}

/* ── 截图处理（通过 Electron desktopCapturer）── */
async function handleScreenshot(savePath) {
  if (floatWin && floatWin.isVisible()) floatWin.hide();
  if (dashWin && dashWin.isVisible()) dashWin.hide();

  await new Promise((r) => setTimeout(r, 300));

  try {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 1920, height: 1080 },
    });
    if (!sources.length) throw new Error("未找到屏幕源");

    const img = sources[0].thumbnail;
    fs.writeFileSync(savePath, img.toPNG());
  } finally {
    if (floatWin) floatWin.show();
    if (dashWin) dashWin.show();
  }
}

/* ── 监听 server 事件 ── */
server.emitter.on("notify", ({ title, body }) => {
  const n = new Notification({ title, body, silent: false, urgency: "critical" });
  n.show();
  n.on("click", createDashboardWindow);
});

server.emitter.on("alarm-triggered", (data) => {
  if (floatWin && !floatWin.isDestroyed()) {
    floatWin.webContents.send("alarm-triggered", data);
  }
});

server.emitter.on("open-dashboard", createDashboardWindow);

server.emitter.on("take-screenshot", async ({ savePath, callback }) => {
  try {
    await handleScreenshot(savePath);
    callback(null);
  } catch (e) {
    callback(e);
  }
});

/* ── 应用生命周期 ── */
if (gotSingleInstanceLock) {
  app.on("second-instance", () => {
    createDashboardWindow();
  });

  app.whenReady().then(async () => {
    await ensureMicPermission();
    await ensureScreenPermission();

    const portAvailable = await checkPortAvailable(PORT);
    if (!portAvailable) {
      dialog.showMessageBoxSync({
        type: "warning",
        title: "录音助手已在运行",
        message:
          "端口 3456 已被占用，请先退出正在运行的录音助手或开发服务，再重新打开应用。",
        buttons: ["知道了"],
      });
      app.quit();
      return;
    }

    server.start(PORT);
    createTray();
    setTimeout(createFloatWindow, 500);
  });
}

app.on("window-all-closed", (e) => e.preventDefault());
