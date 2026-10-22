/**
 * 会议助手客户端的行为测试（node:test）。
 * 关注点：SSE 跨 chunk 行边界不能丢事件，会议结束时总结不能排在积压后面。
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  BachAgentSession,
  createSseParser,
  parseSseLine,
} = require("./bach-agent-client");

/** 构造一份"配置齐备"的 config，避免测试依赖真实环境变量。 */
function enabledConfig(overrides = {}) {
  return {
    baseUrl: "https://example.invalid",
    appCode: "code",
    appSecret: "secret",
    agentMatchFlowPath: "flow-1",
    finalPrompt: "会议最后总结",
    enabled: true,
    tlsRejectUnauthorized: true,
    ...overrides,
  };
}

describe("parseSseLine()", () => {
  it("识别 data: 前缀，并忽略注释行、空行和 [DONE]", () => {
    assert.deepEqual(parseSseLine('data: {"a":1}'), { a: 1 });
    assert.deepEqual(parseSseLine('{"a":2}'), { a: 2 });
    assert.equal(parseSseLine(": heartbeat"), null);
    assert.equal(parseSseLine(""), null);
    assert.equal(parseSseLine("data: [DONE]"), null);
    assert.equal(parseSseLine("data: 非JSON心跳"), null);
  });
});

describe("createSseParser()", () => {
  it("同一 chunk 里的多行会被逐条解析", () => {
    const parser = createSseParser();
    const out = parser.push('data: {"i":1}\ndata: {"i":2}\n');
    assert.deepEqual(out, [{ i: 1 }, { i: 2 }]);
  });

  it("被切成两半的 data 行不会丢失", () => {
    const parser = createSseParser();
    // 上半截还不是完整 JSON，此时不应产出任何事件，更不能静默丢弃。
    assert.deepEqual(parser.push('data: {"full_content":"你好'), []);
    assert.deepEqual(parser.push('世界"}\n'), [{ full_content: "你好世界" }]);
  });

  it("逐字节喂入也能正确还原整条事件", () => {
    const parser = createSseParser();
    const raw = 'data: {"full_content":"abc"}\n';
    const events = [];
    for (const ch of raw) events.push(...parser.push(ch));
    assert.deepEqual(events, [{ full_content: "abc" }]);
  });

  it("流结束时没有换行结尾的最后一行由 flush 取出", () => {
    const parser = createSseParser();
    assert.deepEqual(parser.push('data: {"i":9}'), []);
    assert.deepEqual(parser.flush(), [{ i: 9 }]);
    // flush 之后缓冲区应当被清空。
    assert.deepEqual(parser.flush(), []);
  });
});

describe("BachAgentSession 队列", () => {
  it("会议结束的总结不排队，且丢弃仍在排队的逐句请求", async () => {
    const session = new BachAgentSession({ config: enabledConfig() });

    let releaseFirst;
    const firstInFlight = new Promise((resolve) => {
      releaseFirst = resolve;
    });

    // 用假的 send 模拟"逐句请求很慢、总结很快"的真实情形。
    session.send = async (job) => {
      if (job.final) return { content: "会议总结", final: true };
      await firstInFlight;
      return { content: `ok-${job.sentenceId}`, sentenceId: job.sentenceId };
    };

    session.enqueue({ sentenceId: 1, content: "第一句" });
    session.enqueue({ sentenceId: 2, content: "第二句" });
    session.enqueue({ sentenceId: 3, content: "第三句" });

    // 第 1 条已经在跑，2、3 还在排队。
    await Promise.resolve();
    assert.equal(session.backlog, 2);

    // 关键断言：不释放第一条，总结依然能立刻返回。
    const result = await session.finalize({ content: "会议最后总结" });
    assert.equal(result.content, "会议总结");
    assert.equal(result.dropped, 2);
    assert.equal(session.backlog, 0);

    releaseFirst();
  });

  it("finalize 之后到达的尾句不再入队，避免与总结请求并发", async () => {
    const session = new BachAgentSession({ config: enabledConfig() });
    const sent = [];
    session.send = async (job) => {
      sent.push(job.final ? "final" : job.sentenceId);
      return { content: "ok" };
    };

    await session.finalize({ content: "会议最后总结" });
    // stopAsr 是在 asr.stop() 之前发起总结的，之后还会 flush 出尾句。
    assert.equal(await session.enqueue({ sentenceId: 99, content: "尾句" }), null);
    assert.deepEqual(sent, ["final"]);
  });

  it("单条失败不会卡住后续句子", async () => {
    const session = new BachAgentSession({ config: enabledConfig() });
    const seen = [];
    const errors = [];

    session.send = async (job) => {
      seen.push(job.sentenceId);
      if (job.sentenceId === 1) throw new Error("上游 500");
      return { content: `ok-${job.sentenceId}` };
    };

    const first = session.enqueue({
      sentenceId: 1,
      content: "会失败的一句",
      onError: (error) => errors.push(error.message),
    });
    const second = session.enqueue({ sentenceId: 2, content: "正常的一句" });

    assert.equal(await first, null);
    assert.deepEqual(await second, { content: "ok-2" });
    assert.deepEqual(seen, [1, 2]);
    assert.deepEqual(errors, ["上游 500"]);
  });

  it("close() 之后不再接受新任务", async () => {
    const session = new BachAgentSession({ config: enabledConfig() });
    session.send = async () => ({ content: "不该被调用" });

    session.close();
    assert.equal(await session.enqueue({ sentenceId: 1, content: "x" }), null);
    assert.equal(session.backlog, 0);
  });

  it("未配置 appCode/appSecret 时整体禁用", async () => {
    const session = new BachAgentSession({
      config: enabledConfig({ appCode: "", appSecret: "" }),
    });
    assert.equal(session.enabled, false);
    assert.equal(await session.enqueue({ sentenceId: 1, content: "x" }), null);
    assert.deepEqual(await session.finalize({ content: "总结" }), {
      content: "",
      dropped: 0,
    });
  });
});
