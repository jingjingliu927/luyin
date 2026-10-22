/**
 * WebSocket 路由的回归测试（node:test）。
 *
 * 背景：曾经把 /ws/asr 和 /ws/meeting-assistant 两个 WebSocket.Server 都用
 * { server, path } 挂在同一个 http server 上。两者都会收到 upgrade 事件，
 * 路径不匹配的那个会对已经握手成功的 socket 调用 abortHandshake()，
 * 把一段 HTTP 400 写进 WebSocket 流并销毁连接——客户端报 "RSV1 must be clear"，
 * 整条实时转写链路不可用。这里锁住"两条通道互不干扰"这个约定。
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const WebSocket = require("ws");

const { initWebSocket } = require("./ws-server");

let server;
let baseUrl;

/** 连上指定路径并等待第一条消息。 */
function firstMessage(pathname, onOpen) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${baseUrl}${pathname}`, { perMessageDeflate: false });
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`${pathname} 超时未收到消息`));
    }, 5000);

    ws.on("open", () => onOpen?.(ws));
    ws.on("message", (data) => {
      clearTimeout(timer);
      ws.close();
      resolve(JSON.parse(data.toString()));
    });
    ws.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

before(async () => {
  // 让 startAsr 走到"缺配置"分支：响应是异步发出的，正好覆盖旧 bug 的时序。
  process.env.ASR_PROVIDER = "xfyun";
  delete process.env.XFYUN_APP_ID;
  delete process.env.XFYUN_API_KEY;

  server = http.createServer();
  initWebSocket(server, async () => ({ action: "none", message: "" }), null);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `ws://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
});

describe("initWebSocket() 的 upgrade 路由", () => {
  it("/ws/asr 在另一条通道也挂载时仍能正常收发", async () => {
    const msg = await firstMessage("/ws/asr", (ws) => {
      ws.send(JSON.stringify({ type: "start" }));
    });
    // 关键是消息能完整到达；内容走的是缺配置分支。
    assert.equal(msg.type, "error");
    assert.match(msg.message, /XFYUN_APP_ID/);
  });

  it("/ws/meeting-assistant 连接后立刻收到快照", async () => {
    const msg = await firstMessage("/ws/meeting-assistant");
    assert.equal(msg.type, "meeting-assistant-snapshot");
    assert.ok(Array.isArray(msg.sessions));
  });

  it("未注册的路径直接断开，不会挂在半开状态", async () => {
    await assert.rejects(firstMessage("/ws/unknown"), (error) => {
      // socket 被 destroy，客户端表现为连接错误而不是超时。
      assert.ok(!/超时/.test(error.message), `不应超时，实际: ${error.message}`);
      return true;
    });
  });
});
