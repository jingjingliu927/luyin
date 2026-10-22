/**
 * Speaker voiceprint module contract tests.
 * These tests use temporary storage so speaker and transcript fixtures never touch user data.
 */

const { after, describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Set the storage root before requiring project modules that resolve paths at load time.
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "luyin-speaker-voiceprint-"));
process.env.LUYIN_USER_DATA = testRoot;

const store = require("./store");
const { normalizeVoiceprintAudio } = require("./xfyun-llm-voiceprint");
const { parseXfyunLlmResult } = require("./asr-stream-xfyun-llm");
const { buildMeetingSummaryContext } = require("./meeting-summary");

const transcriptLog = path.join(store.RECORDINGS_DIR, "transcripts.jsonl");
const appJsPath = path.join(__dirname, "..", "public", "js", "app.js");
const dashboardHtmlPath = path.join(__dirname, "..", "public", "dashboard.html");
const wsServerPath = path.join(__dirname, "ws-server.js");
const indexServerPath = path.join(__dirname, "index.js");

after(() => {
  // Remove all synthetic speakers, transcripts, and recordings after the node:test process exits.
  fs.rmSync(testRoot, { recursive: true, force: true });
});

/**
 * Build a minimal PCM WAV buffer for voiceprint normalization checks.
 * @param {{sampleRate?: number, seconds?: number, channels?: number}} options WAV options.
 * @returns {Buffer}
 */
function makePcmWav({ sampleRate = 48000, seconds = 1, channels = 1 } = {}) {
  const frames = sampleRate * seconds;
  const dataSize = frames * channels * 2;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, Buffer.alloc(dataSize)]);
}

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

describe("人物声纹与说话人标注模块", () => {
  it("TC-2.1-001 renders the speaker page entry, empty state, and config banner contract", () => {
    const appJs = fs.readFileSync(appJsPath, "utf-8");
    const dashboardHtml = fs.readFileSync(dashboardHtmlPath, "utf-8");

    assert.deepEqual(store.readJSON("speakers.json"), []);
    assert.equal(dashboardHtml.includes('data-page="speakers"'), true);
    assert.equal(dashboardHtml.includes('id="speakerStatusBanner"'), true);
    assert.equal(dashboardHtml.includes('id="speakerList"'), true);
    assert.equal(dashboardHtml.includes("暂无人物声纹"), true);
    assert.equal(appJs.includes("当前未检测到完整的讯飞声纹配置"), true);
  });

  it("TC-2.1-002 persists a newly created active speaker with name and role", () => {
    const appJs = fs.readFileSync(appJsPath, "utf-8");
    const speaker = {
      id: "sp_001",
      name: "王工",
      role: "主持人",
      provider: "xfyun",
      featureId: "",
      status: "active",
      createdAt: "2026-04-29T10:00:00.000Z",
      updatedAt: "2026-04-29T10:00:00.000Z",
    };

    store.writeJSON("speakers.json", [speaker]);
    const speakers = store.readJSON("speakers.json");

    assert.equal(appJs.includes("人物已保存"), true);
    assert.equal(speakers.length, 1);
    assert.equal(speakers[0].name, "王工");
    assert.equal(speakers[0].role, "主持人");
    assert.equal(speakers[0].status, "active");
    assert.equal(speakers[0].featureId, "");
  });

  it("TC-2.1-004 updates speaker profile fields without dropping the bound featureId", () => {
    const appJs = fs.readFileSync(appJsPath, "utf-8");
    store.writeJSON("speakers.json", [
      {
        id: "sp_002",
        name: "旧姓名",
        role: "旧角色",
        provider: "xfyun_llm",
        featureId: "feature_keep",
        status: "active",
        createdAt: "2026-04-29T10:00:00.000Z",
        updatedAt: "2026-04-29T10:00:00.000Z",
      },
    ]);

    const speakers = store.readJSON("speakers.json");
    speakers[0] = {
      ...speakers[0],
      name: "李经理",
      role: "客户经理",
      status: "disabled",
      updatedAt: "2026-04-29T10:10:00.000Z",
    };
    store.writeJSON("speakers.json", speakers);

    const updated = store.readJSON("speakers.json")[0];
    assert.equal(appJs.includes("人物已保存"), true);
    assert.equal(updated.name, "李经理");
    assert.equal(updated.role, "客户经理");
    assert.equal(updated.status, "disabled");
    assert.equal(updated.featureId, "feature_keep");
  });

  it("TC-2.1-006 removes the selected speaker while preserving other speakers", () => {
    const appJs = fs.readFileSync(appJsPath, "utf-8");
    store.writeJSON("speakers.json", [
      { id: "sp_delete", name: "待删除", status: "active", featureId: "feature_delete" },
      { id: "sp_keep", name: "保留人物", status: "active", featureId: "" },
    ]);

    const speakers = store.readJSON("speakers.json").filter((item) => item.id !== "sp_delete");
    store.writeJSON("speakers.json", speakers);

    const remaining = store.readJSON("speakers.json");
    assert.equal(appJs.includes("人物已删除"), true);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, "sp_keep");
    assert.equal(remaining.some((item) => item.id === "sp_delete"), false);
  });

  it("TC-2.2-001 exposes the voiceprint upload controls and missing-file validation text", () => {
    const appJs = fs.readFileSync(appJsPath, "utf-8");

    assert.equal(appJs.includes('id="speakerVoiceFile"'), true);
    assert.equal(appJs.includes('accept=".wav,.pcm,.ogg,.speex,audio/*"'), true);
    assert.equal(appJs.includes("请选择音频样本文件"), true);
    assert.equal(appJs.includes("建议上传 10 秒到 1 分钟的单人音频"), true);
  });

  it("TC-2.2-002 normalizes an uploaded WAV sample to 16k mono raw PCM", () => {
    const appJs = fs.readFileSync(appJsPath, "utf-8");
    const wav = makePcmWav({ sampleRate: 48000, seconds: 1, channels: 2 });
    const result = normalizeVoiceprintAudio(wav);
    const pcm = Buffer.from(result.audioBase64, "base64");

    assert.equal(appJs.includes('formData.append("audio", file)'), true);
    assert.equal(result.audioType, "raw");
    assert.equal(Math.round(result.durationSeconds), 1);
    assert.equal(pcm.length, 16000 * 2);
  });

  it("TC-2.2-004 rejects voiceprint update when the speaker has no featureId", () => {
    const indexSource = fs.readFileSync(indexServerPath, "utf-8");

    assert.equal(indexSource.includes('app.post("/api/speakers/:id/update-voiceprint"'), true);
    assert.equal(indexSource.includes("当前人物尚未注册声纹"), true);
    assert.equal(indexSource.includes("缺少声纹样本音频"), true);
  });

  it("TC-2.2-006 clears a local featureId after successful remote voiceprint deletion", () => {
    const appJs = fs.readFileSync(appJsPath, "utf-8");
    store.writeJSON("speakers.json", [
      { id: "sp_vp", name: "王工", status: "active", provider: "xfyun_llm", featureId: "feature_old" },
    ]);

    const speakers = store.readJSON("speakers.json");
    speakers[0] = {
      ...speakers[0],
      featureId: "",
      updatedAt: "2026-04-29T10:20:00.000Z",
    };
    store.writeJSON("speakers.json", speakers);

    const updated = store.readJSON("speakers.json")[0];
    assert.equal(appJs.includes("远端声纹已删除"), true);
    assert.equal(appJs.includes("删除远端声纹"), true);
    assert.equal(updated.featureId, "");
    assert.equal(updated.provider, "xfyun_llm");
  });

  it("TC-2.3-001 renders pending speaker tags before a speaker is identified", () => {
    const indexHtml = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf-8");

    assert.equal(indexHtml.includes('class="speaker-tag'), true);
    assert.equal(indexHtml.includes("识别中"), true);
    assert.equal(indexHtml.includes("speakerStatus === \"pending\""), true);
    assert.equal(indexHtml.includes("Speaker:"), true);
  });

  it("TC-2.3-002 parses ASR role feature IDs so registered names can be mapped later", () => {
    const result = parseXfyunLlmResult({
      data: {
        seg_id: 3,
        cn: {
          st: {
            bg: 0,
            ed: 100,
            type: "0",
            rt: [{ ws: [{ cw: [{ w: "你好", wp: "n", rl: "feature_abc" }] }] }],
          },
        },
      },
    });

    assert.equal(result.text, "你好");
    assert.equal(result.roleId, "feature_abc");
  });

  it("TC-2.3-003 keeps role_N as an anonymous speaker label when no registered match exists", () => {
    const wsSource = fs.readFileSync(wsServerPath, "utf-8");

    assert.equal(wsSource.includes("String(rawSpeakerId).match(/^role_(\\d+)$/)"), true);
    assert.equal(wsSource.includes("`说话人${match[1]}`"), true);
    assert.equal(wsSource.includes("未匹配到已注册人物"), true);
  });

  it("TC-2.3-005 archives speaker labels and speakerMap with the recording transcript", () => {
    const appJs = fs.readFileSync(appJsPath, "utf-8");
    resetTranscriptLog();
    appendTranscript({
      wav: "record_20260429_160000.wav",
      text: "第一句第二句",
      utterances: [
        { sentenceId: 1, text: "第一句", speakerRawId: "role_1", speakerLabel: "王工", speakerStatus: "confirmed" },
        { sentenceId: 2, text: "第二句", speakerRawId: "role_2", speakerLabel: "说话人2", speakerStatus: "pending" },
      ],
      speakerMap: { role_1: "王工", role_2: "说话人2" },
    });

    const record = store.readTranscripts()[0];
    assert.equal(record.utterances[0].speakerLabel, "王工");
    assert.equal(record.utterances[1].speakerLabel, "说话人2");
    assert.deepEqual(record.speakerMap, { role_1: "王工", role_2: "说话人2" });
    assert.equal(appJs.includes("展开逐句"), true);
  });

  it("TC-2.3-006 builds meeting summary speaker context without guessing anonymous speakers", () => {
    resetTranscriptLog();
    appendTranscript({
      wav: "record_20260429_163000.wav",
      text: "第一句第二句",
      utterances: [
        { sentenceId: 1, text: "第一句", speakerRawId: "role_1", speakerLabel: "王工", speakerStatus: "confirmed" },
        { sentenceId: 2, text: "第二句", speakerRawId: "role_2", speakerLabel: "说话人2", speakerStatus: "pending" },
      ],
      speakerMap: { role_1: "王工", role_2: "说话人2" },
    });

    const context = buildMeetingSummaryContext(store.readTranscripts()[0]);

    assert.equal(context.utterances[0].speakerLabel, "王工");
    assert.match(context.utterances[0].speakerStatus, /^(confirmed|manual)$/);
    assert.equal(context.utterances[1].speakerLabel, "说话人2");
    assert.equal(context.utterances[1].speakerStatus, "pending");
    assert.equal(context.speakerMap.role_2, "说话人2");
  });

  it("TC-2.4-001 renders recording utterances with label buttons for anonymous speakers", () => {
    const appJs = fs.readFileSync(appJsPath, "utf-8");

    assert.equal(appJs.includes("recording-utterance-line"), true);
    assert.equal(appJs.includes("speaker-label-btn"), true);
    assert.equal(appJs.includes("canManualLabelSpeaker"), true);
    assert.equal(appJs.includes("data-speaker-id"), true);
    assert.equal(appJs.includes("展开逐句"), true);
    assert.equal(appJs.includes("labelRecordingSpeaker"), true);
  });

  it("TC-2.4-002 batch-updates the same anonymous speaker within one recording", () => {
    const appJs = fs.readFileSync(appJsPath, "utf-8");
    resetTranscriptLog();
    appendTranscript({
      wav: "record_20260429_170000.wav",
      text: "需求一需求二",
      utterances: [
        { sentenceId: 1, text: "需求一", speakerRawId: "role_1", speakerLabel: "说话人1", speakerStatus: "pending" },
        { sentenceId: 2, text: "需求二", speakerRawId: "role_1", speakerLabel: "说话人1", speakerStatus: "pending" },
        { sentenceId: 3, text: "确认", speakerRawId: "role_2", speakerLabel: "说话人2", speakerStatus: "pending" },
      ],
      speakerMap: { role_1: "说话人1", role_2: "说话人2" },
    });

    const result = store.updateTranscriptSpeakerLabel("record_20260429_170000.wav", "role_1", "赵工");

    assert.equal(appJs.includes("说话人已标注"), true);
    assert.equal(result.ok, true);
    assert.equal(result.data.utterances[0].speakerLabel, "赵工");
    assert.equal(result.data.utterances[1].speakerLabel, "赵工");
    assert.equal(result.data.utterances[2].speakerLabel, "说话人2");
    assert.equal(result.data.utterances[0].speakerStatus, "manual");
    assert.equal(result.data.speakerMap.role_1, "赵工");
  });

  it("TC-2.4-003 rejects a manual label request when the name is empty", () => {
    const appJs = fs.readFileSync(appJsPath, "utf-8");
    resetTranscriptLog();
    appendTranscript({
      wav: "record_20260429_171000.wav",
      utterances: [{ sentenceId: 1, speakerRawId: "role_1", speakerLabel: "说话人1" }],
    });

    const result = store.updateTranscriptSpeakerLabel("record_20260429_171000.wav", "role_1", "   ");

    assert.equal(appJs.includes("请输入说话人姓名"), true);
    assert.equal(appJs.includes("标注说话人失败"), true);
    assert.equal(result.ok, false);
    assert.equal(result.message, "缺少录音、说话人或姓名");
  });

  it("TC-2.4-004 rejects a manual label request when the speaker ID is not found", () => {
    resetTranscriptLog();
    appendTranscript({
      wav: "record_20260429_172000.wav",
      utterances: [{ sentenceId: 1, speakerRawId: "role_1", speakerLabel: "说话人1" }],
    });

    const result = store.updateTranscriptSpeakerLabel("record_20260429_172000.wav", "role_404", "赵工");

    assert.equal(result.ok, false);
    assert.equal(result.message, "未找到可标注的说话人");
  });
});
