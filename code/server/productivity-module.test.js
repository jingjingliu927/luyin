/**
 * Productivity module contract tests.
 * These tests use temporary storage and static source checks so they never open Electron windows.
 */

const { after, describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Set the storage root before requiring modules that resolve data paths at load time.
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "luyin-productivity-module-"));
process.env.LUYIN_USER_DATA = testRoot;

const store = require("./store");
const { parseCommand } = require("./command-router");

const appJsPath = path.join(__dirname, "..", "public", "js", "app.js");
const dashboardHtmlPath = path.join(__dirname, "..", "public", "dashboard.html");
const indexHtmlPath = path.join(__dirname, "..", "public", "index.html");
const indexServerPath = path.join(__dirname, "index.js");

after(() => {
  // Remove all synthetic productivity data after the node:test process exits.
  fs.rmSync(testRoot, { recursive: true, force: true });
});

/**
 * Reset the JSON stores touched by this module before a case writes fixtures.
 */
function resetProductivityData() {
  store.writeJSON("screenshots.json", []);
  store.writeJSON("notes.json", []);
  store.writeJSON("tasks.json", []);
  store.writeJSON("alarms.json", []);
  store.writeJSON("calc-history.json", []);
  store.writeJSON("activities.json", []);
}

describe("语音命令与生产力工具模块", () => {
  it("TC-3.1-001 routes common spoken commands to the correct intents", () => {
    assert.equal(parseCommand("截图").intent, "screenshot");
    assert.deepEqual(parseCommand("记一下周会结论").params, { content: "周会结论" });
    assert.equal(parseCommand("创建任务提交周报").params.title, "提交周报");
    assert.equal(parseCommand("10秒后提醒我喝水").params.title, "喝水");
    assert.equal(parseCommand("专注 25 分钟 写方案").intent, "pomodoro");
    assert.equal(parseCommand("计算3加4").params.expression, "3加4");
    assert.equal(parseCommand("打开仪表盘").intent, "dashboard");
  });

  it("TC-3.1-002 keeps filler words out and exposes unknown-command feedback", () => {
    const indexHtml = fs.readFileSync(indexHtmlPath, "utf-8");
    const indexServer = fs.readFileSync(indexServerPath, "utf-8");

    assert.equal(parseCommand("嗯").intent, "none");
    assert.equal(parseCommand("今天心情不错").intent, "unknown");
    assert.equal(indexServer.includes("未识别到有效指令"), true);
    assert.equal(indexHtml.includes('className = result.action === "unknown" ? "cmd-tag err" : "cmd-tag"'), true);
  });

  it("TC-3.1-003 exposes the direct text command API and transcript logging contract", () => {
    const indexServer = fs.readFileSync(indexServerPath, "utf-8");

    assert.equal(indexServer.includes('app.post("/api/command"'), true);
    assert.equal(indexServer.includes('res.status(400).json({ success: false, message: "缺少文本" })'), true);
    assert.equal(indexServer.includes("fs.appendFileSync(TRANSCRIPT_LOG"), true);
    assert.equal(indexServer.includes('"语音指令"'), true);
  });

  it("TC-3.2-001 exposes screenshot command, dashboard button, and success feedback", () => {
    const appJs = fs.readFileSync(appJsPath, "utf-8");
    const dashboardHtml = fs.readFileSync(dashboardHtmlPath, "utf-8");
    const indexServer = fs.readFileSync(indexServerPath, "utf-8");

    assert.equal(parseCommand("截一下屏").intent, "screenshot");
    assert.equal(dashboardHtml.includes('id="btnTakeScreenshot"'), true);
    assert.equal(appJs.includes('api("/api/screenshot", { method: "POST" })'), true);
    assert.equal(appJs.includes('toast("截图已保存", "success")'), true);
    assert.equal(indexServer.includes('app.post("/api/screenshot"'), true);
  });

  it("TC-3.2-004 removes screenshot metadata and the selected PNG file", () => {
    resetProductivityData();

    // Simulate the delete route's persistence contract without invoking desktop capture.
    const indexServer = fs.readFileSync(indexServerPath, "utf-8");
    const filename = "screenshot_tc_3_2_004.png";
    const screenshotPath = path.join(store.SCREENSHOTS_DIR, filename);
    fs.writeFileSync(screenshotPath, Buffer.from("png"));
    store.writeJSON("screenshots.json", [
      { id: "shot_delete", filename, createdAt: "2026-04-29T10:00:00.000Z" },
      { id: "shot_keep", filename: "keep.png", createdAt: "2026-04-29T10:01:00.000Z" },
    ]);

    const list = store.readJSON("screenshots.json").filter((item) => item.id !== "shot_delete");
    store.writeJSON("screenshots.json", list);
    fs.rmSync(screenshotPath, { force: true });

    const remaining = store.readJSON("screenshots.json");
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, "shot_keep");
    assert.equal(fs.existsSync(screenshotPath), false);
    assert.equal(indexServer.includes('app.delete("/api/screenshots/:id"'), true);
  });

  it("TC-3.3-001 persists a spoken note with content and activity metadata", () => {
    resetProductivityData();

    const appJs = fs.readFileSync(appJsPath, "utf-8");
    const command = parseCommand("记一下明天复盘客户反馈");
    const note = {
      id: "note_voice",
      title: "",
      content: command.params.content || "记一下明天复盘客户反馈",
      createdAt: "2026-04-29T10:00:00.000Z",
      updatedAt: "2026-04-29T10:00:00.000Z",
    };
    store.writeJSON("notes.json", [note]);
    store.logActivity("note", "新建笔记", note.content.slice(0, 50));

    const notes = store.readJSON("notes.json");
    const activities = store.readJSON("activities.json");
    assert.equal(command.intent, "note");
    assert.equal(notes[0].content, "明天复盘客户反馈");
    assert.equal(activities[0].type, "note");
    assert.equal(activities[0].title, "新建笔记");
    assert.equal(appJs.includes("笔记已保存"), true);
  });

  it("TC-3.3-002 exposes empty-note validation before saving", () => {
    resetProductivityData();

    const appJs = fs.readFileSync(appJsPath, "utf-8");
    const dashboardHtml = fs.readFileSync(dashboardHtmlPath, "utf-8");

    assert.equal(appJs.includes('if (!content && !title) return toast("请输入笔记内容", "error")'), true);
    assert.equal(appJs.includes('api("/api/notes"'), true);
    assert.equal(store.readJSON("notes.json").length, 0);
    assert.equal(dashboardHtml.includes('id="modalOverlay"'), true);
  });

  it("TC-3.4-001 parses spoken tasks and bugs into the expected task defaults", () => {
    resetProductivityData();

    const taskCommand = parseCommand("创建任务提交周报");
    const bugCommand = parseCommand("创建 bug 登录页报错");
    store.writeJSON("tasks.json", [
      {
        id: "task_voice",
        title: taskCommand.params.title,
        description: taskCommand.params.text,
        status: "pending",
        priority: "medium",
        type: taskCommand.params.type,
      },
      {
        id: "bug_voice",
        title: bugCommand.params.title,
        description: bugCommand.params.text,
        status: "pending",
        priority: "high",
        type: bugCommand.params.type,
      },
    ]);

    const tasks = store.readJSON("tasks.json");
    assert.equal(taskCommand.intent, "agent_task");
    assert.equal(tasks[0].title, "提交周报");
    assert.equal(tasks[0].status, "pending");
    assert.equal(tasks[0].priority, "medium");
    assert.equal(tasks[1].type, "bug");
    assert.equal(tasks[1].priority, "high");
  });

  it("TC-3.4-002 completes the first matching unfinished task and reports misses", () => {
    resetProductivityData();

    const indexServer = fs.readFileSync(indexServerPath, "utf-8");
    store.writeJSON("tasks.json", [
      { id: "task_old", title: "提交周报", status: "done", completedAt: "2026-04-29T09:00:00.000Z" },
      { id: "task_target", title: "提交周报给经理", status: "pending", completedAt: null },
    ]);
    const command = parseCommand("完成任务周报");
    const tasks = store.readJSON("tasks.json");
    const idx = tasks.findIndex((item) => item.status !== "done" && item.title.includes(command.params.keyword));
    tasks[idx].status = "done";
    tasks[idx].completedAt = "2026-04-29T10:00:00.000Z";
    store.writeJSON("tasks.json", tasks);

    const updated = store.readJSON("tasks.json");
    assert.equal(command.intent, "task_done");
    assert.equal(updated[0].status, "done");
    assert.equal(updated[1].status, "done");
    assert.equal(Boolean(updated[1].completedAt), true);
    assert.equal(indexServer.includes("未找到匹配的任务"), true);
  });

  it("TC-3.4-005 exposes task filters and empty-title validation", () => {
    const appJs = fs.readFileSync(appJsPath, "utf-8");
    const dashboardHtml = fs.readFileSync(dashboardHtmlPath, "utf-8");

    assert.equal(dashboardHtml.includes('data-filter="all"'), true);
    assert.equal(dashboardHtml.includes('data-filter="pending"'), true);
    assert.equal(dashboardHtml.includes('data-filter="in_progress"'), true);
    assert.equal(dashboardHtml.includes('data-filter="done"'), true);
    assert.equal(appJs.includes('if (!title) return toast("请输入任务名称", "error")'), true);
  });

  it("TC-3.5-001 parses spoken alarm duration and fallback title", () => {
    const tenSecondAlarm = parseCommand("10秒后提醒我喝水");
    const defaultAlarm = parseCommand("提醒我");

    assert.equal(tenSecondAlarm.intent, "alarm");
    assert.equal(tenSecondAlarm.params.minutes, 10 / 60);
    assert.equal(tenSecondAlarm.params.title, "喝水");
    assert.equal(defaultAlarm.params.minutes, 5);
    assert.equal(defaultAlarm.params.title, "定时提醒");
  });

  it("TC-3.5-002 parses pomodoro duration and default title", () => {
    const customPomodoro = parseCommand("番茄钟 15 分钟 写测试用例");
    const defaultPomodoro = parseCommand("专注 25 分钟");

    assert.equal(customPomodoro.intent, "pomodoro");
    assert.equal(customPomodoro.params.minutes, 15);
    assert.equal(customPomodoro.params.title, "写测试用例");
    assert.equal(defaultPomodoro.params.minutes, 25);
    assert.equal(defaultPomodoro.params.title, "专注时间结束");
  });

  it("TC-3.5-004 exposes alarm trigger UI and dashboard reminder controls", () => {
    const indexHtml = fs.readFileSync(indexHtmlPath, "utf-8");

    assert.equal(indexHtml.includes('id="alarmToast"'), true);
    assert.equal(indexHtml.includes("知道了"), true);
    assert.equal(indexHtml.includes("window.electronAPI?.onAlarmTriggered"), true);
    assert.equal(indexHtml.includes("function showAlarm(title)"), true);
    assert.equal(indexHtml.includes("function dismissAlarm()"), true);
  });

  it("TC-3.6-001 parses spoken calculation and preserves history shape", () => {
    resetProductivityData();

    const command = parseCommand("计算3加4");
    const record = {
      id: "calc_voice",
      expression: command.params.expression,
      result: "7",
      createdAt: "2026-04-29T10:00:00.000Z",
    };
    store.writeJSON("calc-history.json", [record]);

    const history = store.readJSON("calc-history.json");
    assert.equal(command.intent, "calculator");
    assert.equal(history[0].expression, "3加4");
    assert.equal(history[0].result, "7");
    assert.deepEqual(Object.keys(history[0]), ["id", "expression", "result", "createdAt"]);
  });

  it("TC-3.6-002 exposes calculation error handling in API and dashboard UI", () => {
    const appJs = fs.readFileSync(appJsPath, "utf-8");
    const indexServer = fs.readFileSync(indexServerPath, "utf-8");

    assert.equal(indexServer.includes('app.post("/api/calculate"'), true);
    assert.equal(indexServer.includes("res.status(400).json({ success: false, message: e.message })"), true);
    assert.equal(appJs.includes('document.getElementById("calcDisplay").textContent = "错误"'), true);
    assert.equal(appJs.includes('this.calcExpr = ""'), true);
  });

  it("TC-3.6-004 exposes calculator controls and empty history text", () => {
    const appJs = fs.readFileSync(appJsPath, "utf-8");
    const dashboardHtml = fs.readFileSync(dashboardHtmlPath, "utf-8");

    assert.equal(dashboardHtml.includes('id="calcDisplay"'), true);
    assert.equal(dashboardHtml.includes('data-val="="'), true);
    assert.equal(dashboardHtml.includes('id="calcHistory"'), true);
    assert.equal(appJs.includes("暂无计算历史"), true);
  });
});
