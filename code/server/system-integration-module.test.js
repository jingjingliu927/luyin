/**
 * Desktop system integration module contract tests.
 * These checks use temporary storage and static source assertions so they never open Electron windows.
 */

const { after, describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Set the storage root before requiring store.js because data paths are resolved at module load time.
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "luyin-system-integration-module-"));
process.env.LUYIN_USER_DATA = testRoot;

const store = require("./store");

const mainJsPath = path.join(__dirname, "..", "main.js");
const preloadJsPath = path.join(__dirname, "..", "preload.js");
const indexHtmlPath = path.join(__dirname, "..", "public", "index.html");
const dashboardHtmlPath = path.join(__dirname, "..", "public", "dashboard.html");
const appJsPath = path.join(__dirname, "..", "public", "js", "app.js");
const indexServerPath = path.join(__dirname, "index.js");
const transcriptLog = path.join(store.RECORDINGS_DIR, "transcripts.jsonl");

after(() => {
  // Remove all synthetic storage data after the node:test process exits.
  fs.rmSync(testRoot, { recursive: true, force: true });
});

/**
 * Read a project source file as UTF-8 text.
 * @param {string} filePath Source file path.
 * @returns {string} File contents.
 */
function source(filePath) {
  return fs.readFileSync(filePath, "utf-8");
}

/**
 * Reset local files touched by system integration checks.
 */
function resetSystemData() {
  store.writeJSON("screenshots.json", []);
  store.writeJSON("alarms.json", []);
  fs.mkdirSync(store.RECORDINGS_DIR, { recursive: true });
  fs.rmSync(transcriptLog, { force: true });
}

describe("桌面权限、通知与系统集成模块", () => {
  it("TC-5.1-001 exposes microphone permission checks and recording entry points", () => {
    const mainJs = source(mainJsPath);
    const indexHtml = source(indexHtmlPath);

    assert.equal(mainJs.includes("async function ensureMicPermission()"), true);
    assert.equal(mainJs.includes('systemPreferences.getMediaAccessStatus("microphone")'), true);
    assert.equal(mainJs.includes('systemPreferences.askForMediaAccess("microphone")'), true);
    assert.equal(indexHtml.includes("navigator.mediaDevices.getUserMedia"), true);
    assert.equal(indexHtml.includes('btn.classList.add("recording")'), true);
  });

  it("TC-5.1-003 guides denied screen recording permission to macOS settings", () => {
    const mainJs = source(mainJsPath);

    assert.equal(mainJs.includes("async function ensureScreenPermission()"), true);
    assert.equal(mainJs.includes('systemPreferences.getMediaAccessStatus("screen")'), true);
    assert.equal(mainJs.includes("desktopCapturer.getSources"), true);
    assert.equal(mainJs.includes("需要屏幕录制权限"), true);
    assert.equal(
      mainJs.includes("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"),
      true
    );
  });

  it("TC-5.1-004 exposes screenshot capture API, permission failure response, and dashboard refresh", () => {
    const indexServer = source(indexServerPath);
    const appJs = source(appJsPath);
    const dashboardHtml = source(dashboardHtmlPath);

    assert.equal(indexServer.includes('app.post("/api/screenshot"'), true);
    assert.equal(indexServer.includes('res.status(500).json({ success: false, message: e.message })'), true);
    assert.equal(indexServer.includes('store.writeJSON("screenshots.json", list)'), true);
    assert.equal(dashboardHtml.includes('id="btnTakeScreenshot"'), true);
    assert.equal(appJs.includes('toast("截图已保存", "success")'), true);
  });

  it("TC-5.2-001 opens or focuses the dashboard from the tray entry", () => {
    const mainJs = source(mainJsPath);

    assert.equal(mainJs.includes("function createTray()"), true);
    assert.equal(mainJs.includes('tray.setToolTip("录音助手")'), true);
    assert.equal(mainJs.includes('label: "打开仪表盘"'), true);
    assert.equal(mainJs.includes('tray.on("click", createDashboardWindow)'), true);
    assert.equal(mainJs.includes("dashWin.show();"), true);
    assert.equal(mainJs.includes("dashWin.focus();"), true);
  });

  it("TC-5.2-002 restores the floating ball from the tray menu", () => {
    const mainJs = source(mainJsPath);

    assert.equal(mainJs.includes('label: "显示悬浮球"'), true);
    assert.equal(mainJs.includes("floatWin ? floatWin.show() : createFloatWindow()"), true);
    assert.equal(mainJs.includes("function createFloatWindow()"), true);
    assert.equal(mainJs.includes("alwaysOnTop: true"), true);
  });

  it("TC-5.2-003 ensures the recordings directory before opening it from the tray", () => {
    const mainJs = source(mainJsPath);

    assert.equal(mainJs.includes('label: "打开录音目录"'), true);
    assert.equal(mainJs.includes('path.join(process.env.LUYIN_USER_DATA, "recordings")'), true);
    assert.equal(mainJs.includes('path.join(DEV_USER_DATA, "recordings")'), true);
    assert.equal(mainJs.includes("fs.mkdirSync(dir, { recursive: true })"), true);
    assert.equal(mainJs.includes("shell.openPath(dir)"), true);
  });

  it("TC-5.2-004 exposes a tray quit action that terminates the Electron app", () => {
    const mainJs = source(mainJsPath);

    assert.equal(mainJs.includes('label: "退出"'), true);
    assert.equal(mainJs.includes("app.quit()"), true);
    assert.equal(mainJs.includes('app.on("window-all-closed", (e) => e.preventDefault())'), true);
  });

  it("TC-5.3-001 dispatches both desktop notification and floating alarm events when an alarm triggers", () => {
    const indexServer = source(indexServerPath);

    assert.equal(indexServer.includes("function scheduleAlarm(alarm)"), true);
    assert.equal(indexServer.includes('emitter.emit("notify", { title: "闹钟提醒", body: alarm.title })'), true);
    assert.equal(indexServer.includes('emitter.emit("alarm-triggered", { id: alarm.id, title: alarm.title })'), true);
    assert.equal(indexServer.includes("triggered = true"), true);
    assert.equal(indexServer.includes('app.post("/api/alarms"'), true);
  });

  it("TC-5.3-002 renders the floating alarm layer and supports dismissal plus auto-close", () => {
    const indexHtml = source(indexHtmlPath);
    const preloadJs = source(preloadJsPath);

    assert.equal(indexHtml.includes('id="alarmTitle"'), true);
    assert.equal(indexHtml.includes("时间到了！"), true);
    assert.equal(indexHtml.includes("知道了"), true);
    assert.equal(indexHtml.includes("function showAlarm(title)"), true);
    assert.equal(indexHtml.includes("setTimeout(dismissAlarm, 30000)"), true);
    assert.equal(preloadJs.includes("onAlarmTriggered(callback)"), true);
  });

  it("TC-5.3-003 opens the dashboard when the desktop notification is clicked", () => {
    const mainJs = source(mainJsPath);

    assert.equal(mainJs.includes('server.emitter.on("notify"'), true);
    assert.equal(mainJs.includes("new Notification({ title, body"), true);
    assert.equal(mainJs.includes("n.show();"), true);
    assert.equal(mainJs.includes('n.on("click", createDashboardWindow)'), true);
  });

  it("TC-5.3-004 restores unexpired alarms during service startup", () => {
    const indexServer = source(indexServerPath);

    assert.equal(indexServer.includes("function restoreAlarms()"), true);
    assert.equal(indexServer.includes(".filter((a) => !a.triggered && new Date(a.time) > new Date())"), true);
    assert.equal(indexServer.includes(".forEach(scheduleAlarm)"), true);
    assert.equal(indexServer.includes("restoreAlarms();"), true);
  });

  it("TC-5.4-001 toggles floating ball recording state on single click", () => {
    const indexHtml = source(indexHtmlPath);

    assert.equal(indexHtml.includes('id="btn"'), true);
    assert.equal(indexHtml.includes("function handleClick()"), true);
    assert.equal(indexHtml.includes("recording ? stopAll() : startAll()"), true);
    assert.equal(indexHtml.includes('btn.classList.add("recording")'), true);
    assert.equal(indexHtml.includes('btn.classList.remove("recording", "speaking")'), true);
  });

  it("TC-5.4-002 expands or collapses the realtime panel from the dedicated toggle while recording", () => {
    const indexHtml = source(indexHtmlPath);

    assert.equal(indexHtml.includes('id="panelToggleBtn"'), true);
    assert.equal(indexHtml.includes("function handlePanelToggleClick(event)"), true);
    assert.equal(indexHtml.includes("!recording"), true);
    assert.equal(indexHtml.includes("togglePanel();"), true);
    assert.equal(indexHtml.includes("function togglePanel()"), true);
    assert.equal(indexHtml.includes("实时识别"), true);
  });

  it("TC-5.4-003 opens the dashboard from the realtime panel button", () => {
    const indexHtml = source(indexHtmlPath);

    assert.equal(indexHtml.includes("function openDashboard()"), true);
    assert.equal(indexHtml.includes('window.open("/dashboard", "_blank")'), true);
    assert.equal(indexHtml.includes('onclick="openDashboard()"'), true);
  });

  it("TC-5.4-004 reuses an existing dashboard window instead of duplicating it", () => {
    const mainJs = source(mainJsPath);

    assert.equal(mainJs.includes("function createDashboardWindow()"), true);
    assert.equal(mainJs.includes("if (dashWin)"), true);
    assert.equal(mainJs.includes("dashWin.show();"), true);
    assert.equal(mainJs.includes("dashWin.focus();"), true);
    assert.equal(mainJs.includes('dashWin.on("closed", () => (dashWin = null))'), true);
  });

  it("TC-5.4-005 hides and restores desktop windows around screenshot capture", () => {
    const mainJs = source(mainJsPath);

    assert.equal(mainJs.includes("async function handleScreenshot(savePath)"), true);
    assert.equal(mainJs.includes("if (floatWin && floatWin.isVisible()) floatWin.hide();"), true);
    assert.equal(mainJs.includes("if (dashWin && dashWin.isVisible()) dashWin.hide();"), true);
    assert.equal(mainJs.includes("fs.writeFileSync(savePath, img.toPNG())"), true);
    assert.equal(mainJs.includes("if (floatWin) floatWin.show();"), true);
    assert.equal(mainJs.includes("if (dashWin) dashWin.show();"), true);
  });

  it("TC-5.5-001 initializes development storage directories and returns empty collections safely", () => {
    resetSystemData();

    assert.equal(fs.existsSync(store.DATA_DIR), true);
    assert.equal(fs.existsSync(store.SCREENSHOTS_DIR), true);
    assert.equal(fs.existsSync(store.RECORDINGS_DIR), true);
    assert.deepEqual(store.readJSON("missing.json"), []);
    assert.deepEqual(store.readTranscripts(), []);
  });

  it("TC-5.5-002 routes packaged storage through LUYIN_USER_DATA instead of app install files", () => {
    const mainJs = source(mainJsPath);
    const storeJs = source(path.join(__dirname, "store.js"));

    assert.equal(mainJs.includes("if (app.isPackaged)"), true);
    assert.equal(mainJs.includes('process.env.LUYIN_USER_DATA = app.getPath("userData")'), true);
    assert.equal(storeJs.includes("const USER_DATA = process.env.LUYIN_USER_DATA || PROJECT_ROOT"), true);
    assert.equal(store.DATA_DIR.startsWith(testRoot), true);
    assert.equal(store.RECORDINGS_DIR.startsWith(testRoot), true);
  });

  it("TC-5.5-003 exposes recording list playback through the recordings static route", () => {
    resetSystemData();

    fs.appendFileSync(
      transcriptLog,
      `${JSON.stringify({ wav: "record_access.wav", text: "本地录音访问", time: "2026/4/30 08:00:00" })}\n`,
      "utf-8"
    );
    const appJs = source(appJsPath);
    const dashboardHtml = source(dashboardHtmlPath);
    const indexServer = source(indexServerPath);

    assert.equal(store.readTranscripts()[0].wav, "record_access.wav");
    assert.equal(indexServer.includes('app.use("/recordings", express.static(store.RECORDINGS_DIR))'), true);
    assert.equal(appJs.includes('api("/api/recordings")'), true);
    assert.equal(appJs.includes('src="/recordings/${r.wav}"'), true);
    assert.equal(dashboardHtml.includes('id="recordingList"'), true);
  });

  it("TC-5.5-004 exposes screenshot preview and deletion through the screenshots static route", () => {
    resetSystemData();

    store.writeJSON("screenshots.json", [{ id: "shot_access", filename: "shot_access.png" }]);
    const appJs = source(appJsPath);
    const indexServer = source(indexServerPath);
    const dashboardHtml = source(dashboardHtmlPath);

    assert.equal(store.readJSON("screenshots.json")[0].filename, "shot_access.png");
    assert.equal(indexServer.includes('app.use("/data/screenshots", express.static(store.SCREENSHOTS_DIR))'), true);
    assert.equal(indexServer.includes('app.delete("/api/screenshots/:id"'), true);
    assert.equal(appJs.includes('App.openLightbox(\'/data/screenshots/${s.filename}\')'), true);
    assert.equal(dashboardHtml.includes('id="screenshotGrid"'), true);
  });

  it("TC-5.5-005 keeps recordings, screenshots, and JSON metadata separated by data type", () => {
    const mainJs = source(mainJsPath);
    const storeJs = source(path.join(__dirname, "store.js"));

    assert.equal(storeJs.includes('const DATA_DIR = path.join(USER_DATA, "data")'), true);
    assert.equal(storeJs.includes('const SCREENSHOTS_DIR = path.join(DATA_DIR, "screenshots")'), true);
    assert.equal(storeJs.includes('const RECORDINGS_DIR = path.join(USER_DATA, "recordings")'), true);
    assert.equal(mainJs.includes('label: "打开录音目录"'), true);
    assert.equal(mainJs.includes("shell.openPath(dir)"), true);
  });
});
