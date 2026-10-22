const fs = require("fs");

const WAV_HEADER_SIZE = 44;

function buildWavHeader(dataSize, sampleRate = 16000, numChannels = 1, bitDepth = 16) {
  const byteRate = sampleRate * numChannels * (bitDepth / 8);
  const blockAlign = numChannels * (bitDepth / 8);
  const header = Buffer.alloc(WAV_HEADER_SIZE);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return header;
}

function pcmToWav(pcmBuffer, sampleRate = 16000, numChannels = 1, bitDepth = 16) {
  const header = buildWavHeader(pcmBuffer.length, sampleRate, numChannels, bitDepth);
  return Buffer.concat([header, pcmBuffer]);
}

function savePcmAsWav(pcmBuffers, filePath, sampleRate = 16000) {
  const pcm = Buffer.concat(pcmBuffers);
  if (pcm.length === 0) return null;
  const wav = pcmToWav(pcm, sampleRate);
  fs.writeFileSync(filePath, wav);
  return filePath;
}

function pcmDurationMs(pcmByteLength, sampleRate = 16000, bitDepth = 16) {
  const bytesPerSample = bitDepth / 8;
  const samples = pcmByteLength / bytesPerSample;
  return (samples / sampleRate) * 1000;
}

function slicePcmByTime(
  pcmBuffers,
  startMs,
  endMs,
  sampleRate = 16000,
  bitDepth = 16
) {
  // 将时间范围映射为字节范围；与 16kHz/16bit 单声道的 PCM 约定保持一致。
  const bytesPerSample = bitDepth / 8;
  const bytesPerMs = (sampleRate * bytesPerSample) / 1000;
  const safeStartMs = Math.max(0, Number.isFinite(startMs) ? startMs : 0);
  const safeEndMs = Math.max(safeStartMs, Number.isFinite(endMs) ? endMs : safeStartMs);

  const full = Buffer.concat(pcmBuffers || []);
  const rawStart = Math.floor(safeStartMs * bytesPerMs);
  const rawEnd = Math.floor(safeEndMs * bytesPerMs);
  const maxLen = full.length;
  const alignedStart = Math.max(0, Math.min(maxLen, rawStart - (rawStart % bytesPerSample)));
  const alignedEnd = Math.max(
    alignedStart,
    Math.min(maxLen, rawEnd - (rawEnd % bytesPerSample))
  );
  return full.subarray(alignedStart, alignedEnd);
}

/**
 * 边录边写的 WAV 写入器。
 *
 * 之前的做法是把整场录音的 PCM 全部堆在内存数组里，会话结束才落盘，并且每次取
 * 某一句的音频都要 Buffer.concat 整个数组——录得越久越慢（O(n²)），且进程崩溃
 * 会丢掉全部音频。这里改成：开始录音就打开文件、先写 44 字节占位头，音频到达即
 * 追加；取句子音频时按字节偏移直接从文件随机读，内存里不再驻留整段 PCM。
 *
 * @param {string} filePath 目标 WAV 路径
 * @param {{sampleRate?: number, numChannels?: number, bitDepth?: number}} [options]
 */
function createWavWriter(filePath, options = {}) {
  const sampleRate = options.sampleRate || 16000;
  const numChannels = options.numChannels || 1;
  const bitDepth = options.bitDepth || 16;
  const frameSize = (bitDepth / 8) * numChannels;
  const bytesPerMs = (sampleRate * frameSize) / 1000;

  // "w+" 让同一个 fd 既能追加写、又能随机读，省掉额外打开一次文件。
  // exclusive 时改用 "wx+"：文件已存在就直接抛 EEXIST，由调用方换个名字重试，
  // 避免两场并发录音打开同一路径后互相截断。
  const fd = fs.openSync(filePath, options.exclusive ? "wx+" : "w+");
  fs.writeSync(fd, buildWavHeader(0, sampleRate, numChannels, bitDepth), 0, WAV_HEADER_SIZE, 0);

  let dataSize = 0;
  let closed = false;

  function alignToFrame(byteOffset) {
    const clamped = Math.max(0, Math.min(dataSize, byteOffset));
    return clamped - (clamped % frameSize);
  }

  function write(chunk) {
    if (closed || !chunk || chunk.length === 0) return;
    fs.writeSync(fd, chunk, 0, chunk.length, WAV_HEADER_SIZE + dataSize);
    dataSize += chunk.length;
  }

  /**
   * 按时间窗口 [startMs, endMs) 读取 PCM 切片。
   * @returns {Buffer} 已写入部分之内的切片；超出范围会被截断
   */
  function slice(startMs, endMs) {
    if (closed) return Buffer.alloc(0);
    const safeStartMs = Math.max(0, Number.isFinite(startMs) ? startMs : 0);
    const safeEndMs = Math.max(safeStartMs, Number.isFinite(endMs) ? endMs : safeStartMs);
    const start = alignToFrame(Math.floor(safeStartMs * bytesPerMs));
    const end = alignToFrame(Math.floor(safeEndMs * bytesPerMs));
    const length = Math.max(0, end - start);
    if (length === 0) return Buffer.alloc(0);

    const out = Buffer.alloc(length);
    const read = fs.readSync(fd, out, 0, length, WAV_HEADER_SIZE + start);
    return read === length ? out : out.subarray(0, read);
  }

  /**
   * 回填真实长度并关闭文件。
   * @returns {{filePath: string, dataSize: number, durationMs: number}|null} 无音频时返回 null 并删除空文件
   */
  function close() {
    if (closed) return null;
    closed = true;

    if (dataSize === 0) {
      try { fs.closeSync(fd); } catch {}
      // 没有采到音频就不要留下一个只有头的空 WAV。
      try { fs.unlinkSync(filePath); } catch {}
      return null;
    }

    try {
      const header = buildWavHeader(dataSize, sampleRate, numChannels, bitDepth);
      fs.writeSync(fd, header, 0, WAV_HEADER_SIZE, 0);
    } catch {
      // 回填失败时文件头仍是 dataSize=0，音频虽在但播放器会读成 0 秒；
      // 至少要保证 fd 被释放（见下方 finally），避免长时间运行后耗尽句柄。
      return null;
    } finally {
      try { fs.closeSync(fd); } catch {}
    }

    return {
      filePath,
      dataSize,
      durationMs: pcmDurationMs(dataSize, sampleRate, bitDepth) / numChannels,
    };
  }

  return {
    write,
    slice,
    close,
    get byteLength() { return dataSize; },
    get durationMs() { return pcmDurationMs(dataSize, sampleRate, bitDepth) / numChannels; },
    get closed() { return closed; },
  };
}

module.exports = {
  pcmToWav,
  buildWavHeader,
  savePcmAsWav,
  pcmDurationMs,
  slicePcmByTime,
  createWavWriter,
  WAV_HEADER_SIZE,
};
