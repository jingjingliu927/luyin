/**
 * Dashboard module contract tests.
 * These checks use a temporary storage root and static source assertions, so they never open Electron windows.
 */

const { after, describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Resolve dashboard storage before requiring store.js because data paths are created at module load time.
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "luyin-dashboard-module-"));
process.env.LUYIN_USER_DATA = testRoot;

const store = require("./store");

const appJsPath = path.join(__dirname, "..", "public", "js", "app.js");
const dashboardHtmlPath = path.join(__dirname, "..", "public", "dashboard.html");
const indexServerPath = path.join(__dirname, "index.js");
const transcriptLog = path.join(store.RECORDINGS_DIR, "transcripts.jsonl");

after(() => {
  // Remove synthetic dashboard data after the node:test process exits.
  fs.rmSync(testRoot, { recursive: true, force: true });
});

/**
 * Reset every local collection surfaced by the dashboard module.
 */
function resetDashboardData() {
  store.writeJSON("screenshots.json", []);
  store.writeJSON("notes.json", []);
  store.writeJSON("tasks.json", []);
  store.writeJSON("alarms.json", []);
  store.writeJSON("calc-history.json", []);
  store.writeJSON("activities.json", []);
  fs.mkdirSync(store.RECORDINGS_DIR, { recursive: true });
  fs.rmSync(transcriptLog, { force: true });
}

/**
 * Append a synthetic transcript record to the temporary transcript log.
 * @param {Record<string, unknown>} record Synthetic transcript record.
 */
function appendTranscript(record) {
  fs.appendFileSync(transcriptLog, `${JSON.stringify(record)}\n`, "utf-8");
}

describe("仪表盘与本地资料管理模块", () => {
  it("TC-4.1-001 aggregates local dashboard stats, activities, and pending tasks", () => {
    resetDashboardData();

    appendTranscript({ time: "2026/4/29 10:00:00", text: "首页统计录音", wav: "record_home.wav" });
    store.writeJSON("screenshots.json", [{ id: "shot_home", filename: "home.png" }]);
    store.writeJSON("notes.json", [{ id: "note_home", title: "首页笔记", content: "统计来源" }]);
    store.writeJSON("tasks.json", [
      { id: "task_pending", title: "处理待办", status: "pending", priority: "high" },
      { id: "task_done", title: "已完成事项", status: "done", priority: "medium" },
    ]);
    store.writeJSON("alarms.json", [{ id: "alarm_home", title: "开会", minutes: 5 }]);
    store.logActivity("note", "新建笔记", "统计来源");

    const appJs = fs.readFileSync(appJsPath, "utf-8");
    const stats = {
      recordings: store.readTranscripts().length,
      screenshots: store.readJSON("screenshots.json").length,
      notes: store.readJSON("notes.json").length,
      tasks: store.readJSON("tasks.json").length,
      tasksDone: store.readJSON("tasks.json").filter((task) => task.status === "done").length,
      alarms: store.readJSON("alarms.json").length,
    };
    const pending = store.readJSON("tasks.json").filter((task) => task.status !== "done");

    assert.deepEqual(stats, {
      recordings: 1,
      screenshots: 1,
      notes: 1,
      tasks: 2,
      tasksDone: 1,
      alarms: 1,
    });
    assert.equal(store.readJSON("activities.json")[0].title, "新建笔记");
    assert.equal(pending[0].id, "task_pending");
    assert.equal(appJs.includes('api("/api/stats")'), true);
    assert.equal(appJs.includes('api("/api/activities?limit=20")'), true);
    assert.equal(appJs.includes('api("/api/tasks")'), true);
  });

  it("TC-4.1-004 exposes dashboard refresh and empty home-state text", () => {
    const appJs = fs.readFileSync(appJsPath, "utf-8");
    const dashboardHtml = fs.readFileSync(dashboardHtmlPath, "utf-8");

    assert.equal(dashboardHtml.includes('id="btnRefresh"'), true);
    assert.equal(dashboardHtml.includes('id="activityList"'), true);
    assert.equal(dashboardHtml.includes('id="pendingTasks"'), true);
    assert.equal(appJs.includes("暂无动态"), true);
    assert.equal(appJs.includes("全部完成"), true);
    assert.equal(appJs.includes('toast("已刷新", "success")'), true);
  });

  it("TC-4.2-001 returns an empty recording list and keeps the recording page shell", () => {
    resetDashboardData();

    const appJs = fs.readFileSync(appJsPath, "utf-8");
    const dashboardHtml = fs.readFileSync(dashboardHtmlPath, "utf-8");

    assert.deepEqual(store.readTranscripts(), []);
    assert.equal(appJs.includes("暂无录音记录"), true);
    assert.equal(dashboardHtml.includes('id="recordingList"'), true);
    assert.equal(dashboardHtml.includes("录音与转写记录"), true);
    assert.equal(dashboardHtml.includes('id="btnMeetingSummary"'), true);
  });

  it("TC-4.2-003 renders utterance expansion, command summary, and agent reply hooks", () => {
    resetDashboardData();

    appendTranscript({
      time: "2026/4/29 11:00:00",
      wav: "record_detail.wav",
      text: "记录会议结论",
      utterances: [
        { sentenceId: 1, text: "第一句", speakerLabel: "说话人1", speakerRawId: "role_1" },
        { sentenceId: 2, text: "第二句", speakerLabel: "说话人2", speakerRawId: "role_2" },
      ],
      command: { action: "note", message: "笔记已保存" },
      agent: { agentReply: "任务已创建" },
    });

    const appJs = fs.readFileSync(appJsPath, "utf-8");
    const list = store.readTranscripts();

    assert.equal(list[0].utterances.length, 2);
    assert.equal(list[0].command.message, "笔记已保存");
    assert.equal(list[0].agent.agentReply, "任务已创建");
    assert.equal(appJs.includes("展开逐句"), true);
    assert.equal(appJs.includes("recording-badge command"), true);
    assert.equal(appJs.includes("recording-badge agent"), true);
  });

  it("TC-4.2-005 validates manual speaker label input and PUT route contract", () => {
    const appJs = fs.readFileSync(appJsPath, "utf-8");
    const indexServer = fs.readFileSync(indexServerPath, "utf-8");

    assert.equal(appJs.includes("请输入说话人姓名"), true);
    assert.equal(appJs.includes("说话人已标注"), true);
    assert.equal(appJs.includes("/api/recordings/${encodeURIComponent(pending.wav)}/speakers"), true);
    assert.equal(indexServer.includes('app.put("/api/recordings/:wav/speakers"'), true);
  });

  it("TC-4.2-006 renders ready meeting summary cards", () => {
    resetDashboardData();
    appendTranscript({
      wav: "record_summary_ready.wav",
      text: "会议内容",
      meetingSummary: {
        status: "ready",
        summary: "本次会议确认上线方案",
        decisions: ["按计划上线"],
        actionItems: [{ owner: "王工", task: "整理接口文档" }],
        risks: ["待确认发布时间"],
      },
    });

    const appJs = fs.readFileSync(appJsPath, "utf-8");
    const record = store.readTranscripts()[0];

    assert.equal(appJs.includes("会议总结"), true);
    assert.equal(appJs.includes("recording-meeting-summary"), true);
    assert.equal(appJs.includes("行动项"), true);
    assert.equal(record.meetingSummary.status, "ready");
  });

  it("TC-4.2-007 exposes failed meeting summary retry route and UI", () => {
    const appJs = fs.readFileSync(appJsPath, "utf-8");
    const indexServer = fs.readFileSync(indexServerPath, "utf-8");

    assert.equal(appJs.includes("会议总结生成失败"), true);
    assert.equal(appJs.includes("生成会议总结"), true);
    assert.equal(appJs.includes("meeting-summary-picker"), true);
    assert.equal(appJs.includes("全选"), true);
    assert.equal(appJs.includes("全不选"), true);
    assert.equal(appJs.includes("内容复制"), true);
    assert.equal(appJs.includes("selectAllMeetingSummaryOptions"), true);
    assert.equal(appJs.includes('api("/api/meeting-summary"'), true);
    assert.equal(appJs.includes("meeting-summary-retry"), true);
    assert.equal(indexServer.includes('app.post("/api/meeting-summary"'), true);
    assert.equal(appJs.includes("retryMeetingSummary"), true);
    assert.equal(indexServer.includes('app.post("/api/recordings/:wav/meeting-summary/retry"'), true);
    assert.equal(appJs.includes("recording-toggle-btn"), true);
    assert.equal(appJs.includes("API Base URL"), true);
  });

  it("TC-4.2-008 skips meeting summary when recording has no transcript text", () => {
    resetDashboardData();
    appendTranscript({
      wav: "record_summary_empty.wav",
      text: "",
      utterances: [],
      meetingSummary: { status: "skipped", message: "暂无可总结内容" },
    });

    const appJs = fs.readFileSync(appJsPath, "utf-8");
    const record = store.readTranscripts()[0];

    assert.equal(record.meetingSummary.status, "skipped");
    assert.equal(appJs.includes("暂无可总结内容"), true);
    assert.equal(appJs.includes("/meeting-summary/retry"), true);
    assert.equal(appJs.includes("audio"), true);
  });

  it("TC-4.3-001 exposes screenshot empty state and manual capture button", () => {
    const appJs = fs.readFileSync(appJsPath, "utf-8");
    const dashboardHtml = fs.readFileSync(dashboardHtmlPath, "utf-8");

    assert.equal(dashboardHtml.includes('id="screenshotGrid"'), true);
    assert.equal(dashboardHtml.includes('id="screenshotEmpty"'), true);
    assert.equal(dashboardHtml.includes("暂无截图"), true);
    assert.equal(dashboardHtml.includes('id="btnTakeScreenshot"'), true);
    assert.equal(appJs.includes('api("/api/screenshots")'), true);
    assert.equal(appJs.includes('api("/api/screenshot", { method: "POST" })'), true);
  });

  it("TC-4.3-004 removes screenshot metadata and selected image file", () => {
    resetDashboardData();

    const filename = "dashboard_delete.png";
    const screenshotPath = path.join(store.SCREENSHOTS_DIR, filename);
    fs.writeFileSync(screenshotPath, Buffer.from("png"));
    store.writeJSON("screenshots.json", [
      { id: "shot_delete", filename },
      { id: "shot_keep", filename: "keep.png" },
    ]);

    const list = store.readJSON("screenshots.json").filter((item) => item.id !== "shot_delete");
    store.writeJSON("screenshots.json", list);
    fs.rmSync(screenshotPath, { force: true });

    const indexServer = fs.readFileSync(indexServerPath, "utf-8");
    const remaining = store.readJSON("screenshots.json");

    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, "shot_keep");
    assert.equal(fs.existsSync(screenshotPath), false);
    assert.equal(indexServer.includes('app.delete("/api/screenshots/:id"'), true);
  });

  it("TC-4.4-001 renders notes empty state, untitled fallback, and API shell", () => {
    resetDashboardData();

    store.writeJSON("notes.json", [{ id: "note_untitled", title: "", content: "只有正文" }]);
    const appJs = fs.readFileSync(appJsPath, "utf-8");
    const dashboardHtml = fs.readFileSync(dashboardHtmlPath, "utf-8");

    assert.equal(store.readJSON("notes.json")[0].content, "只有正文");
    assert.equal(appJs.includes("无标题笔记"), true);
    assert.equal(dashboardHtml.includes("暂无笔记"), true);
    assert.equal(dashboardHtml.includes('id="btnNewNote"'), true);
    assert.equal(dashboardHtml.includes('id="noteList"'), true);
    assert.equal(appJs.includes('api("/api/notes")'), true);
  });

  it("TC-4.4-003 blocks empty note saves before writing local data", () => {
    resetDashboardData();

    const appJs = fs.readFileSync(appJsPath, "utf-8");

    assert.equal(appJs.includes('if (!content && !title) return toast("请输入笔记内容", "error")'), true);
    assert.equal(store.readJSON("notes.json").length, 0);
    assert.equal(appJs.includes('id="noteTitle"'), true);
    assert.equal(appJs.includes('id="noteContent"'), true);
  });

  it("TC-4.5-001 exposes task filters, empty states, and empty-title validation", () => {
    const appJs = fs.readFileSync(appJsPath, "utf-8");
    const dashboardHtml = fs.readFileSync(dashboardHtmlPath, "utf-8");

    assert.equal(dashboardHtml.includes('data-filter="all"'), true);
    assert.equal(dashboardHtml.includes('data-filter="pending"'), true);
    assert.equal(dashboardHtml.includes('data-filter="in_progress"'), true);
    assert.equal(dashboardHtml.includes('data-filter="done"'), true);
    assert.equal(dashboardHtml.includes("暂无任务"), true);
    assert.equal(appJs.includes("该分类下暂无任务"), true);
    assert.equal(appJs.includes('if (!title) return toast("请输入任务名称", "error")'), true);
  });

  it("TC-4.5-003 toggles task done status with completedAt only on first completion", () => {
    resetDashboardData();

    store.writeJSON("tasks.json", [{ id: "task_toggle", title: "整理会议纪要", status: "pending", completedAt: null }]);
    const tasks = store.readJSON("tasks.json");
    const previousStatus = tasks[0].status;
    Object.assign(tasks[0], { status: "done", completedAt: "2026-04-29T12:00:00.000Z" });
    store.writeJSON("tasks.json", tasks);

    const doneTask = store.readJSON("tasks.json")[0];
    const appJs = fs.readFileSync(appJsPath, "utf-8");

    assert.equal(previousStatus, "pending");
    assert.equal(doneTask.status, "done");
    assert.equal(Boolean(doneTask.completedAt), true);
    assert.equal(appJs.includes('toast(newStatus === "done" ? "任务已完成" : "任务已恢复", "success")'), true);
    assert.equal(appJs.includes('if (this.currentPage === "home") this.loadHome();'), true);
  });

  it("TC-4.6-001 exposes reminder empty state, status labels, and timer styles", () => {
    const appJs = fs.readFileSync(appJsPath, "utf-8");
    const dashboardHtml = fs.readFileSync(dashboardHtmlPath, "utf-8");

    assert.equal(dashboardHtml.includes('id="alarmList"'), true);
    assert.equal(dashboardHtml.includes('id="alarmEmpty"'), true);
    assert.equal(dashboardHtml.includes("暂无提醒"), true);
    assert.equal(appJs.includes("等待中"), true);
    assert.equal(appJs.includes("已触发"), true);
    assert.equal(appJs.includes("pomodoro"), true);
  });

  it("TC-4.6-003 deletes reminders and exposes active timer cleanup", () => {
    resetDashboardData();

    store.writeJSON("alarms.json", [
      { id: "alarm_delete", title: "待删除提醒", minutes: 5 },
      { id: "alarm_keep", title: "保留提醒", minutes: 10 },
    ]);
    const next = store.readJSON("alarms.json").filter((alarm) => alarm.id !== "alarm_delete");
    store.writeJSON("alarms.json", next);

    const indexServer = fs.readFileSync(indexServerPath, "utf-8");
    const appJs = fs.readFileSync(appJsPath, "utf-8");
    const remaining = store.readJSON("alarms.json");

    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, "alarm_keep");
    assert.equal(indexServer.includes('app.delete("/api/alarms/:id"'), true);
    assert.equal(indexServer.includes("clearTimeout(timer)"), true);
    assert.equal(appJs.includes('toast("闹钟已删除", "success")'), true);
  });

  it("TC-4.6-004 constrains reminder minutes and exposes type choices", () => {
    const appJs = fs.readFileSync(appJsPath, "utf-8");
    const dashboardHtml = fs.readFileSync(dashboardHtmlPath, "utf-8");

    assert.equal(appJs.includes('id="alarmMinutes"'), true);
    assert.equal(appJs.includes('min="1" max="1440"'), true);
    assert.equal(appJs.includes('value="alarm"'), true);
    assert.equal(appJs.includes('value="pomodoro"'), true);
    assert.equal(dashboardHtml.includes('id="btnNewAlarm"'), true);
  });

  it("TC-4.7-002 preserves calculator history shape and dashboard history shell", () => {
    resetDashboardData();

    store.writeJSON("calc-history.json", [
      { id: "calc_dashboard", expression: "7*8", result: "56", createdAt: "2026-04-29T13:00:00.000Z" },
    ]);
    const history = store.readJSON("calc-history.json");
    const appJs = fs.readFileSync(appJsPath, "utf-8");
    const dashboardHtml = fs.readFileSync(dashboardHtmlPath, "utf-8");

    assert.deepEqual(Object.keys(history[0]), ["id", "expression", "result", "createdAt"]);
    assert.equal(history[0].expression, "7*8");
    assert.equal(history[0].result, "56");
    assert.equal(dashboardHtml.includes('id="calcHistory"'), true);
    assert.equal(appJs.includes('api("/api/calculator/history")'), true);
  });

  it("TC-4.7-003 exposes calculation error handling in dashboard UI and API", () => {
    const appJs = fs.readFileSync(appJsPath, "utf-8");
    const indexServer = fs.readFileSync(indexServerPath, "utf-8");

    assert.equal(indexServer.includes('app.post("/api/calculate"'), true);
    assert.equal(indexServer.includes("res.status(400).json({ success: false, message: e.message })"), true);
    assert.equal(appJs.includes('document.getElementById("calcDisplay").textContent = "错误"'), true);
    assert.equal(appJs.includes('this.calcExpr = ""'), true);
  });

  it("TC-4.7-004 exposes calculator controls and empty history text", () => {
    const appJs = fs.readFileSync(appJsPath, "utf-8");
    const dashboardHtml = fs.readFileSync(dashboardHtmlPath, "utf-8");

    assert.equal(dashboardHtml.includes('id="calcDisplay"'), true);
    assert.equal(dashboardHtml.includes('data-val="C"'), true);
    assert.equal(dashboardHtml.includes('data-val="="'), true);
    assert.equal(dashboardHtml.includes('id="calcHistory"'), true);
    assert.equal(appJs.includes("暂无计算历史"), true);
  });

  it("TC-4.8-001 searches recordings, notes, and tasks with a fifty-result cap", () => {
    resetDashboardData();

    appendTranscript({ time: "2026/4/29 14:00:00", text: "Alpha 客户录音" });
    store.writeJSON("notes.json", [{ id: "note_alpha", title: "Alpha 笔记", content: "复盘内容", createdAt: "2026-04-29T14:01:00.000Z" }]);
    store.writeJSON("tasks.json", [{ id: "task_alpha", title: "Alpha 跟进任务", status: "pending", createdAt: "2026-04-29T14:02:00.000Z" }]);

    const q = "alpha";
    const results = [];
    store.readTranscripts().forEach((record) => {
      if ((record.text || "").toLowerCase().includes(q)) results.push({ type: "recording", title: record.text });
    });
    store.readJSON("notes.json").forEach((note) => {
      if ((note.title || "").toLowerCase().includes(q) || (note.content || "").toLowerCase().includes(q)) {
        results.push({ type: "note", title: note.title || note.content.slice(0, 40) });
      }
    });
    store.readJSON("tasks.json").forEach((task) => {
      if ((task.title || "").toLowerCase().includes(q)) results.push({ type: "task", title: task.title });
    });

    const indexServer = fs.readFileSync(indexServerPath, "utf-8");

    assert.deepEqual(results.map((result) => result.type), ["recording", "note", "task"]);
    assert.equal(results.length, 3);
    assert.equal(indexServer.includes('app.get("/api/search"'), true);
    assert.equal(indexServer.includes("results.slice(0, 50)"), true);
  });

  it("TC-4.8-002 exposes search input, result page, no-result text, and type badges", () => {
    const appJs = fs.readFileSync(appJsPath, "utf-8");
    const dashboardHtml = fs.readFileSync(dashboardHtmlPath, "utf-8");

    assert.equal(dashboardHtml.includes('id="globalSearch"'), true);
    assert.equal(dashboardHtml.includes("搜索笔记、任务、录音..."), true);
    assert.equal(dashboardHtml.includes('id="page-search"'), true);
    assert.equal(dashboardHtml.includes('id="searchResults"'), true);
    assert.equal(appJs.includes("未找到匹配的结果"), true);
    assert.equal(appJs.includes("search-type-badge"), true);
  });

  it("TC-4.8-004 clears search back to the previous page or home", () => {
    const appJs = fs.readFileSync(appJsPath, "utf-8");

    assert.equal(appJs.includes("if (!q) return this.navigate(this.currentPage === \"search\" ? \"home\" : this.currentPage)"), true);
    assert.equal(appJs.includes('timer = setTimeout(() => this.doSearch(q), 400)'), true);
    assert.equal(appJs.includes('this.navigate("search")'), true);
  });
});
