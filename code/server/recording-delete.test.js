/**
 * 录音删除相关的行为测试（node:test）。
 * 关注点：只删中目标的那一条、音频路径必须被限制在 recordings 目录内。
 */

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let store;
let userDataDir;
let transcriptPath;

before(() => {
  // store 在 require 时就按 LUYIN_USER_DATA 建目录，必须先设置再加载。
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "luyin-store-"));
  process.env.LUYIN_USER_DATA = userDataDir;
  store = require("./store");
  transcriptPath = path.join(store.RECORDINGS_DIR, "transcripts.jsonl");
});

after(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

/** 写入若干条转写记录，每行一条 JSON。 */
function seedTranscripts(records) {
  fs.writeFileSync(
    transcriptPath,
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
    "utf-8"
  );
}

/** 读回文件里现存的记录（按文件顺序，不反转）。 */
function readRawTranscripts() {
  if (!fs.existsSync(transcriptPath)) return [];
  return fs
    .readFileSync(transcriptPath, "utf-8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

describe("deleteTranscriptRecord()", () => {
  beforeEach(() => {
    seedTranscripts([
      { time: "2026/08/01 10:00:00", wav: "record_a.wav", text: "第一条" },
      { time: "2026/08/01 11:00:00", wav: "record_b.wav", text: "第二条" },
      { time: "2026/08/01 12:00:00", wav: null, text: "没有音频的一条" },
    ]);
  });

  it("按 wav + time 删除命中的那一条，其余保持不变", () => {
    const result = store.deleteTranscriptRecord({
      wav: "record_b.wav",
      time: "2026/08/01 11:00:00",
    });

    assert.equal(result.ok, true);
    assert.equal(result.data.text, "第二条");

    const rest = readRawTranscripts();
    assert.deepEqual(rest.map((r) => r.text), ["第一条", "没有音频的一条"]);
  });

  it("wav 为空时按 time 定位没有音频的记录", () => {
    const result = store.deleteTranscriptRecord({
      wav: null,
      time: "2026/08/01 12:00:00",
    });

    assert.equal(result.ok, true);
    assert.equal(result.data.text, "没有音频的一条");
    assert.deepEqual(readRawTranscripts().map((r) => r.text), ["第一条", "第二条"]);
  });

  it("同名 wav 只删第一条，不会连带删掉其它记录", () => {
    seedTranscripts([
      { time: "2026/08/01 10:00:00", wav: "dup.wav", text: "旧的" },
      { time: "2026/08/01 11:00:00", wav: "dup.wav", text: "新的" },
    ]);

    const result = store.deleteTranscriptRecord({ wav: "dup.wav" });
    assert.equal(result.ok, true);
    assert.equal(result.data.text, "旧的");
    assert.deepEqual(readRawTranscripts().map((r) => r.text), ["新的"]);
  });

  it("找不到记录时返回失败且不改动文件", () => {
    const before = fs.readFileSync(transcriptPath, "utf-8");
    const result = store.deleteTranscriptRecord({ wav: "not-exist.wav" });

    assert.equal(result.ok, false);
    assert.match(result.message, /未找到/);
    assert.equal(fs.readFileSync(transcriptPath, "utf-8"), before);
  });

  it("缺少标识时直接拒绝", () => {
    const result = store.deleteTranscriptRecord({});
    assert.equal(result.ok, false);
    assert.match(result.message, /缺少/);
  });
});

describe("clearTranscripts()", () => {
  beforeEach(() => {
    seedTranscripts([
      { time: "2026/08/01 10:00:00", wav: "record_a.wav", text: "第一条" },
      { time: "2026/08/01 11:00:00", wav: "record_b.wav", text: "第二条" },
      { time: "2026/08/01 12:00:00", wav: null, text: "没有音频的一条" },
    ]);
  });

  it("清空后索引为空，并返回被清掉的全部记录", () => {
    const result = store.clearTranscripts();

    assert.equal(result.ok, true);
    assert.equal(result.data.length, 3);
    assert.deepEqual(readRawTranscripts(), []);
    assert.deepEqual(store.readTranscripts(), []);
  });

  it("返回的记录里带着 wav 名，供调用方逐个删除音频", () => {
    const wavs = store.clearTranscripts().data.map((r) => r.wav);
    // 没采到音频的记录 wav 为 null，调用方需要跳过。
    assert.deepEqual(wavs.filter(Boolean).sort(), ["record_a.wav", "record_b.wav"]);
  });

  it("索引文件不存在时是安全的空操作", () => {
    fs.rmSync(transcriptPath, { force: true });
    const result = store.clearTranscripts();
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, []);
  });

  it("不触碰未被记录引用的 wav（例如正在录制中的文件）", () => {
    const inProgress = path.join(store.RECORDINGS_DIR, "record_in_progress.wav");
    fs.writeFileSync(inProgress, "PARTIAL");

    const removed = store.clearTranscripts().data;
    // clearTranscripts 只负责索引；它返回的 wav 列表里不应包含尚未归档的文件，
    // 调用方按这个列表删除，正在录制的文件才不会被误删。
    assert.equal(removed.some((r) => r.wav === "record_in_progress.wav"), false);
    assert.equal(fs.existsSync(inProgress), true);

    fs.rmSync(inProgress, { force: true });
  });
});

describe("resolveRecordingPath()", () => {
  it("普通文件名解析到 recordings 目录内", () => {
    const resolved = store.resolveRecordingPath("record_a.wav");
    assert.equal(resolved, path.join(path.resolve(store.RECORDINGS_DIR), "record_a.wav"));
  });

  it("拒绝带路径分隔符的输入，而不是 basename 成目录内的另一个文件", () => {
    // 只接受纯文件名：../../../etc/passwd 若被 basename 成 passwd，
    // 就会把删除目标悄悄换成 recordings/passwd。
    assert.equal(store.resolveRecordingPath("../../../etc/passwd"), null);
    assert.equal(store.resolveRecordingPath("/etc/passwd"), null);
    assert.equal(store.resolveRecordingPath("sub/record.wav"), null);
    assert.equal(store.resolveRecordingPath("..\\record.wav"), null);
    assert.equal(store.resolveRecordingPath(".."), null);
    assert.equal(store.resolveRecordingPath(""), null);
    assert.equal(store.resolveRecordingPath(null), null);
  });

  it("拒绝删除索引文件本身", () => {
    assert.equal(store.resolveRecordingPath("transcripts.jsonl"), null);
  });
});
