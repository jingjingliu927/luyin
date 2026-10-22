/**
 * 轻量级实时说话人聚类器（匿名说话人）。
 * 目标是“实时可用 + 可降级”，不依赖重型本地模型。
 */

function toInt16Array(pcm) {
  if (!pcm || pcm.length < 2) return new Int16Array(0);
  const len = Math.floor(pcm.length / 2);
  const out = new Int16Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = pcm.readInt16LE(i * 2);
  }
  return out;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function extractVoiceFeatures(samples, sampleRate) {
  if (!samples.length) return null;

  let sumSq = 0;
  let zc = 0;
  let prevSign = samples[0] >= 0 ? 1 : -1;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i] / 32768;
    sumSq += x * x;
    const sign = samples[i] >= 0 ? 1 : -1;
    if (i > 0 && sign !== prevSign) zc++;
    prevSign = sign;
  }

  const rms = Math.sqrt(sumSq / samples.length);
  const zcr = zc / Math.max(1, samples.length - 1);

  // 使用简单自相关估计主频，作为“声线粗特征”。
  const minLag = Math.floor(sampleRate / 320);
  const maxLag = Math.floor(sampleRate / 70);
  let bestLag = -1;
  let bestCorr = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    const n = samples.length - lag;
    if (n <= 0) continue;
    for (let i = 0; i < n; i++) {
      corr += samples[i] * samples[i + lag];
    }
    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
  }

  const pitchHz = bestLag > 0 ? sampleRate / bestLag : 0;
  const normPitch = clamp(pitchHz / 400, 0, 1);
  const normRms = clamp(rms * 8, 0, 1);
  const normZcr = clamp(zcr * 4, 0, 1);

  return {
    vector: [normPitch, normRms, normZcr],
    rms,
    zcr,
  };
}

function vectorDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

function createRealtimeSpeakerDiarizer(options = {}) {
  const sampleRate = options.sampleRate || 16000;
  const minDurationMs = options.minDurationMs || 120;
  // 多人优先：降低“归为同一人”的阈值，让不同说话人更容易被拆分出来。
  const matchThreshold = options.matchThreshold || 0.15;
  const minVoiceRms = options.minVoiceRms || 0.028;
  // 多人优先：新说话人候选连续命中 2 次即可确认，减少“全程同一人”问题。
  const minNewClusterHits = options.minNewClusterHits || 2;
  // 多人优先：放宽候选聚类内部差异，避免候选频繁重置导致切换困难。
  const pendingFeatureThreshold = options.pendingFeatureThreshold || 0.18;

  const clusters = [];
  let nextClusterId = 1;
  let lastSpeakerLabel = "说话人1";
  let pendingNewCluster = null;

  function createCluster(feature) {
    const clusterId = `cluster_${nextClusterId++}`;
    const label = `说话人${clusters.length + 1}`;
    clusters.push({
      clusterId,
      label,
      center: feature.slice(),
      count: 1,
    });
    lastSpeakerLabel = label;
    return { clusterId, speakerLabel: label, speakerStatus: "confirmed" };
  }

  function resolveSpeaker({ pcm, durationMs, featureUnstable = false }) {
    // 短句或显式标记不稳定时，回退最近说话人，保证实时体验连续。
    if (featureUnstable || durationMs < minDurationMs) {
      return {
        clusterId: null,
        speakerLabel: lastSpeakerLabel,
        speakerStatus: "estimated",
      };
    }

    const samples = toInt16Array(pcm);
    const featureInfo = extractVoiceFeatures(samples, sampleRate);
    if (!featureInfo) {
      return {
        clusterId: null,
        speakerLabel: lastSpeakerLabel,
        speakerStatus: "estimated",
      };
    }
    const feature = featureInfo.vector;

    // 低能量片段通常是噪声或吞音，直接回退最近说话人，避免误增“新说话人”。
    if (featureInfo.rms < minVoiceRms) {
      return {
        clusterId: null,
        speakerLabel: lastSpeakerLabel,
        speakerStatus: "estimated",
      };
    }

    if (clusters.length === 0) {
      return createCluster(feature);
    }

    let best = null;
    for (const c of clusters) {
      const distance = vectorDistance(feature, c.center);
      if (!best || distance < best.distance) {
        best = { cluster: c, distance };
      }
    }

    if (best && best.distance <= matchThreshold) {
      // 运行均值更新簇中心，降低瞬时抖动。
      const c = best.cluster;
      const nextCount = c.count + 1;
      c.center = c.center.map((v, i) => (v * c.count + feature[i]) / nextCount);
      c.count = nextCount;
      lastSpeakerLabel = c.label;
      pendingNewCluster = null;
      return {
        clusterId: c.clusterId,
        speakerLabel: c.label,
        speakerStatus: "confirmed",
      };
    }

    // 新簇必须连续命中候选若干次，避免同一人语气波动被拆分成多人。
    if (!pendingNewCluster) {
      pendingNewCluster = { center: feature.slice(), hits: 1 };
      return {
        clusterId: null,
        speakerLabel: lastSpeakerLabel,
        speakerStatus: "estimated",
      };
    }

    const pendingDistance = vectorDistance(feature, pendingNewCluster.center);
    if (pendingDistance > pendingFeatureThreshold) {
      pendingNewCluster = { center: feature.slice(), hits: 1 };
      return {
        clusterId: null,
        speakerLabel: lastSpeakerLabel,
        speakerStatus: "estimated",
      };
    }

    const nextHits = pendingNewCluster.hits + 1;
    pendingNewCluster.center = pendingNewCluster.center.map(
      (v, i) => (v * pendingNewCluster.hits + feature[i]) / nextHits
    );
    pendingNewCluster.hits = nextHits;
    if (pendingNewCluster.hits < minNewClusterHits) {
      return {
        clusterId: null,
        speakerLabel: lastSpeakerLabel,
        speakerStatus: "estimated",
      };
    }

    const created = createCluster(pendingNewCluster.center);
    pendingNewCluster = null;
    return created;
  }

  function exportSpeakerMap() {
    // 仅导出当前会话的匿名映射，不做跨会话复用。
    return clusters.reduce((acc, c) => {
      acc[c.clusterId] = c.label;
      return acc;
    }, {});
  }

  return { resolveSpeaker, exportSpeakerMap };
}

module.exports = { createRealtimeSpeakerDiarizer };
