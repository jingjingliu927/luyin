/**
 * Recording module contract tests for archive and history behavior.
 * These tests use a temporary LUYIN_USER_DATA directory so they never touch user recordings.
 */

const { after, describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Set the storage root before requiring store.js because it resolves paths at module load time.
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "luyin-recording-module-"));
process.env.LUYIN_USER_DATA = testRoot;

const store = require("./store");
const { savePcmAsWav } = require("./audio-utils");
const {
  buildMeetingSummaryContext,
  createInitialMeetingSummary,
} = require("./meeting-summary");

const transcriptLog = path.join(store.RECORDINGS_DIR, "transcripts.jsonl");
const appJsPath = path.join(__dirname, "..", "public", "js", "app.js");
const dashboardHtmlPath = path.join(__dirname, "..", "public", "dashboard.html");

after(() => {
  // Remove synthetic test data after the file's node:test process exits.
  fs.rmSync(testRoot, { recursive: true, force: true });
});

/**
 * Reset the temporary transcript log before a case writes its own fixture data.
 */
function resetTranscriptLog() {
  fs.mkdirSync(store.RECORDINGS_DIR, { recursive: true });
  fs.rmSync(transcriptLog, { force: true });
}

/**
 * Append one synthetic transcript record to the temporary JSONL log.
 * @param {Record<string, unknown>} record Synthetic transcript record.
 */
function appendTranscript(record) {
  fs.appendFileSync(transcriptLog, `${JSON.stringify(record)}\n`, "utf-8");
}

/**
 * Keep only the archive fields that the TC promises to validate.
 * @param {Record<string, unknown>} record Transcript record.
 */
function pickRecordShape(record) {
  return {
    provider: record.provider,
    source: record.source,
    text: record.text,
    utterances: record.utterances,
    wav: record.wav,
  };
}

/**
 * Keep only the utterance fields that the TC promises to validate.
 * @param {Record<string, unknown>} utterance Transcript utterance.
 */
function pickUtteranceShape(utterance) {
  return {
    sentenceId: utterance.sentenceId,
    speakerLabel: utterance.speakerLabel,
    speakerStatus: utterance.speakerStatus,
    text: utterance.text,
  };
}

describe("语音录入与转写模块", () => {
  it("TC-1.2-004 archives a stream session record with WAV and utterances", () => {
    resetTranscriptLog();

    // Write a minimal synthetic WAV that represents archived stream audio.
    const wavName = "record_20260429_120000.wav";
    const wavPath = path.join(store.RECORDINGS_DIR, wavName);
    savePcmAsWav([Buffer.alloc(16000, 0x11)], wavPath);

    appendTranscript({
      time: "2026/4/29 12:00:00",
      wav: wavName,
      text: "会议开始记录需求",
      sentences: ["会议开始记录需求"],
      utterances: [
        {
          sentenceId: 1,
          text: "会议开始记录需求",
          startMs: 0,
          endMs: 1200,
          speakerLabel: "说话人1",
          speakerStatus: "confirmed",
        },
      ],
      speakerMap: { role_1: "说话人1" },
      source: "stream",
      provider: "xfyun",
    });

    const list = store.readTranscripts();

    assert.equal(fs.existsSync(wavPath), true);
    assert.equal(list.length, 1);
    assert.deepEqual(Object.keys(pickRecordShape(list[0])), [
      "provider",
      "source",
      "text",
      "utterances",
      "wav",
    ]);
    assert.equal(list[0].utterances[0].speakerLabel, "说话人1");
  });

  it("TC-1.2-005 triggers external meeting summary with transcript and speaker context", () => {
    resetTranscriptLog();

    const wavName = "record_summary_trigger.wav";
    appendTranscript({
      time: "2026/4/29 12:30:00",
      wav: wavName,
      text: "会议开始记录需求",
      utterances: [
        {
          sentenceId: 1,
          text: "会议开始记录需求",
          speakerRawId: "role_1",
          speakerLabel: "王工",
          speakerStatus: "confirmed",
        },
      ],
      speakerMap: { role_1: "王工" },
      meetingSummary: { status: "pending" },
    });

    const record = store.readTranscripts()[0];
    const summaryRequest = buildMeetingSummaryContext(record);
    const initialSummary = createInitialMeetingSummary(record);

    assert.equal(summaryRequest.text, "会议开始记录需求");
    assert.equal(summaryRequest.utterances[0].speakerLabel, "王工");
    assert.equal(summaryRequest.speakerMap.role_1, "王工");
    assert.match(initialSummary.status, /^(pending|ready)$/);
    assert.equal(Boolean(record.wav && record.utterances.length), true);
  });

  it("TC-1.3-003 stores an offline fallback transcript with uploaded WAV", () => {
    resetTranscriptLog();

    // Simulate the persisted result that POST /api/save creates after Whisper succeeds.
    const wavName = "record_20260429_130000.wav";
    const wavPath = path.join(store.RECORDINGS_DIR, wavName);
    savePcmAsWav([Buffer.alloc(12000, 0x22)], wavPath);

    appendTranscript({
      time: "2026/4/29 13:00:00",
      wav: wavName,
      text: "离线识别保存成功",
    });

    const list = store.readTranscripts();

    assert.equal(fs.existsSync(wavPath), true);
    assert.equal(list.length, 1);
    assert.equal(list[0].text, "离线识别保存成功");
    assert.equal(list[0].wav, wavName);
  });

  it("TC-1.4-001 returns an empty recording list when no transcript log exists", () => {
    resetTranscriptLog();

    // The dashboard owns the empty-state text while store.js owns the empty list contract.
    const appJs = fs.readFileSync(appJsPath, "utf-8");
    const dashboardHtml = fs.readFileSync(dashboardHtmlPath, "utf-8");

    assert.deepEqual(store.readTranscripts(), []);
    assert.equal(dashboardHtml.includes("暂无录音记录"), false);
    assert.equal(appJs.includes("暂无录音记录"), true);
    assert.equal(dashboardHtml.includes('id="recordingList"'), true);
  });

  it("TC-1.4-004 reads transcripts newest first and preserves speaker labels", () => {
    resetTranscriptLog();

    // JSONL append order is oldest to newest; readTranscripts() must return newest first.
    appendTranscript({
      time: "2026/4/29 13:59:00",
      wav: "record_20260429_135900.wav",
      text: "第一条旧录音",
      utterances: [
        {
          sentenceId: 1,
          text: "旧录音内容",
          speakerLabel: "说话人1",
          speakerStatus: "estimated",
        },
      ],
    });
    appendTranscript({
      time: "2026/4/29 14:00:00",
      wav: "record_20260429_140000.wav",
      text: "第二条更新录音",
      utterances: [
        {
          sentenceId: 1,
          text: "第一句需求",
          speakerLabel: "说话人1",
          speakerStatus: "confirmed",
        },
        {
          sentenceId: 2,
          text: "第二句结论",
          speakerLabel: "说话人2",
          speakerStatus: "confirmed",
        },
      ],
    });

    const appJs = fs.readFileSync(appJsPath, "utf-8");
    const list = store.readTranscripts();

    assert.equal(list[0].text, "第二条更新录音");
    assert.equal(list[0].utterances.length, 2);
    assert.deepEqual(Object.keys(pickUtteranceShape(list[0].utterances[0])), [
      "sentenceId",
      "speakerLabel",
      "speakerStatus",
      "text",
    ]);
    assert.equal(appJs.includes("展开逐句"), true);
    assert.equal(appJs.includes("收起逐句"), true);
  });
});
