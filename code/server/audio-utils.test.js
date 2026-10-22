/**
 * 流式 WAV 写入器的行为测试（node:test）。
 * 关注点：边录边写不再把整段 PCM 留在内存，按时间切片走文件随机读，
 * 以及会话结束时 WAV 头长度必须被正确回填。
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createWavWriter, WAV_HEADER_SIZE } = require("./audio-utils");

const SAMPLE_RATE = 16000;
const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000;

/** 建一个独立临时目录，避免测试之间互相干扰。 */
function tempWavPath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "luyin-wav-"));
  return path.join(dir, `${name}.wav`);
}

/** 生成指定毫秒长度、以固定字节填充的 PCM。 */
function pcmMs(ms, fillByte) {
  return Buffer.alloc(Math.round(ms * BYTES_PER_MS), fillByte & 0xff);
}

describe("createWavWriter()", () => {
  it("边写边回填长度，关闭后是一个头部正确的 WAV", () => {
    const wavPath = tempWavPath("basic");
    const writer = createWavWriter(wavPath, { sampleRate: SAMPLE_RATE });

    writer.write(pcmMs(100, 0x11));
    writer.write(pcmMs(150, 0x22));

    const expectedBytes = Math.round(250 * BYTES_PER_MS);
    assert.equal(writer.byteLength, expectedBytes);

    const closed = writer.close();
    assert.ok(closed);
    assert.equal(closed.dataSize, expectedBytes);
    assert.equal(Math.round(closed.durationMs), 250);

    const file = fs.readFileSync(wavPath);
    assert.equal(file.length, WAV_HEADER_SIZE + expectedBytes);
    assert.equal(file.toString("ascii", 0, 4), "RIFF");
    assert.equal(file.toString("ascii", 8, 12), "WAVE");
    // 头里的两个长度字段必须是真实值，而不是占位的 0。
    assert.equal(file.readUInt32LE(4), 36 + expectedBytes);
    assert.equal(file.readUInt32LE(40), expectedBytes);
    assert.equal(file.readUInt32LE(24), SAMPLE_RATE);
  });

  it("按时间切片直接从文件读，边界与写入内容一致", () => {
    const wavPath = tempWavPath("slice");
    const writer = createWavWriter(wavPath, { sampleRate: SAMPLE_RATE });

    writer.write(pcmMs(100, 0xaa));
    writer.write(pcmMs(100, 0xbb));
    writer.write(pcmMs(100, 0xcc));

    const first = writer.slice(0, 100);
    assert.equal(first.length, Math.round(100 * BYTES_PER_MS));
    assert.ok(first.every((b) => b === 0xaa));

    const middle = writer.slice(100, 200);
    assert.ok(middle.every((b) => b === 0xbb));

    // 跨段切片应当同时包含两段内容。
    const across = writer.slice(150, 250);
    assert.equal(across.length, Math.round(100 * BYTES_PER_MS));
    assert.equal(across[0], 0xbb);
    assert.equal(across[across.length - 1], 0xcc);

    writer.close();
  });

  it("切片超出已写入范围时被截断，不会读到垃圾数据", () => {
    const wavPath = tempWavPath("clamp");
    const writer = createWavWriter(wavPath, { sampleRate: SAMPLE_RATE });
    writer.write(pcmMs(50, 0x7f));

    const beyond = writer.slice(0, 5000);
    assert.equal(beyond.length, Math.round(50 * BYTES_PER_MS));
    assert.ok(beyond.every((b) => b === 0x7f));

    // 起点已经越界时返回空切片。
    assert.equal(writer.slice(1000, 2000).length, 0);
    // 终点早于起点时同样是空切片，而不是负长度。
    assert.equal(writer.slice(40, 10).length, 0);

    writer.close();
  });

  it("没有采到音频时删除空文件并返回 null", () => {
    const wavPath = tempWavPath("empty");
    const writer = createWavWriter(wavPath, { sampleRate: SAMPLE_RATE });

    assert.equal(fs.existsSync(wavPath), true);
    assert.equal(writer.close(), null);
    assert.equal(fs.existsSync(wavPath), false);
  });

  it("exclusive 模式下不会打开已存在的文件，避免并发录音互相截断", () => {
    const wavPath = tempWavPath("exclusive");

    const first = createWavWriter(wavPath, { sampleRate: SAMPLE_RATE, exclusive: true });
    first.write(pcmMs(100, 0xaa));

    // 第二场录音撞上同名文件时必须失败，而不是把第一场的音频截断为 0。
    assert.throws(
      () => createWavWriter(wavPath, { sampleRate: SAMPLE_RATE, exclusive: true }),
      (error) => error.code === "EEXIST"
    );

    const closed = first.close();
    assert.equal(closed.dataSize, Math.round(100 * BYTES_PER_MS));
    const file = fs.readFileSync(wavPath);
    assert.equal(file.readUInt32LE(40), Math.round(100 * BYTES_PER_MS));
    assert.ok(file.subarray(WAV_HEADER_SIZE).every((b) => b === 0xaa));
  });

  it("重复关闭是安全的", () => {
    const wavPath = tempWavPath("double-close");
    const writer = createWavWriter(wavPath, { sampleRate: SAMPLE_RATE });
    writer.write(pcmMs(10, 0x01));

    assert.ok(writer.close());
    assert.equal(writer.close(), null);
    assert.equal(writer.closed, true);
    // 关闭后再切片不应抛异常（会话归档后仍可能有回调进来）。
    assert.equal(writer.slice(0, 10).length, 0);
  });
});
