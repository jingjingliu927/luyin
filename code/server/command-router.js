const FILLER_WORDS = /^[嗯啊哦呢吧呀嘛哈是的对好行哦哦]+[。，！？、,.!?]*$/;

function stripPunctuation(text) {
  // 句首句尾的标点都要去掉：讯飞大模型等引擎常在句首带「，」，不去掉的话「记一下…」这类前缀指令全都匹配不上
  return text.replace(/^[。，！？、；：,.!?;:\s]+|[。，！？、,.!?\s]+$/g, "").trim();
}

const CN_NUM_MAP = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function cnToNum(s) {
  if (/^\d+$/.test(s)) return parseInt(s);
  const chars = [...s];
  if (chars.length === 1 && CN_NUM_MAP[chars[0]] !== undefined) return CN_NUM_MAP[chars[0]];
  if (chars.length === 1 && chars[0] === "十") return 10;
  if (chars.length === 2 && chars[0] === "十") return 10 + (CN_NUM_MAP[chars[1]] || 0);
  if (chars.length === 2 && chars[1] === "十") return (CN_NUM_MAP[chars[0]] || 1) * 10;
  if (chars.length === 3 && chars[1] === "十") return (CN_NUM_MAP[chars[0]] || 1) * 10 + (CN_NUM_MAP[chars[2]] || 0);
  return null;
}

const TIME_NUM = "(?:\\d+|[零一二两三四五六七八九十]+)";

function parseAlarm(t) {
  const isAlarmContext = /闹钟|提醒|定时|叫我|喊我/.test(t);
  if (!isAlarmContext) return null;

  let seconds = null;
  let title = "";

  const secRe = new RegExp("(" + TIME_NUM + ")\\s*秒钟?");
  const minRe = new RegExp("(" + TIME_NUM + ")\\s*分钟?");
  const hourRe = new RegExp("(" + TIME_NUM + ")\\s*(?:小时|个小时)");
  const halfHour = /半小时|半个小时/.test(t);

  const secMatch = t.match(secRe);
  const minMatch = t.match(minRe);
  const hourMatch = t.match(hourRe);

  if (secMatch || minMatch || hourMatch || halfHour) {
    seconds = 0;
    if (hourMatch) seconds += (cnToNum(hourMatch[1]) || 1) * 3600;
    if (minMatch) seconds += (cnToNum(minMatch[1]) || 1) * 60;
    if (halfHour && !minMatch && !hourMatch) seconds += 1800;
    if (secMatch) seconds += cnToNum(secMatch[1]) || 10;
  }

  if (seconds === null) seconds = 300;
  const minutes = seconds / 60;

  title = t
    .replace(new RegExp(TIME_NUM + "\\s*(?:秒钟?|分钟?|小时|个小时)", "g"), "")
    .replace(/半小时|半个小时/g, "")
    .replace(/提醒我|叫我|喊我/g, "")
    .replace(/(?:设置|设个|设定|定个)?(?:闹钟|提醒|定时)/g, "")
    .replace(/之?后/g, "")
    .replace(/^我/, "")
    .replace(/[，,\s]+/g, "")
    .trim();

  return {
    intent: "alarm",
    params: {
      minutes,
      title: title || "定时提醒",
    },
  };
}

const MATH_OPS = /[+\-*/×÷]|加|减|乘以?|除以?/;
const MATH_EXPR = /\d+\s*(?:[+\-*/×÷]|加|减|乘以?|除以?)\s*\d+/;

function parseCalculator(t) {
  const prefixMatch = t.match(/^(?:计算|算一下|算|帮我算)\s*(.+)/);
  if (prefixMatch) {
    return { intent: "calculator", params: { expression: prefixMatch[1] } };
  }

  const suffixMatch = t.match(/^(.+?)(?:等于多少|等于几|是多少|得多少)\s*[？?]?$/);
  if (suffixMatch) {
    const expr = suffixMatch[1].trim();
    if (MATH_OPS.test(expr) || /的\s*(?:平方根|平方|立方)/.test(expr)) {
      return { intent: "calculator", params: { expression: expr } };
    }
  }

  const POWER_EXPR = /\d+\s*的\s*(?:平方根|平方|立方)/;
  if (MATH_EXPR.test(t) && t.replace(/[\d\s+\-*/×÷().加减乘除以的平方根立方]/g, "").length === 0) {
    return { intent: "calculator", params: { expression: t } };
  }
  if (POWER_EXPR.test(t) && t.replace(/[\d\s的平方根立方]/g, "").length === 0) {
    return { intent: "calculator", params: { expression: t } };
  }

  return null;
}

function parseCommand(text) {
  if (!text || text.startsWith("（")) return { intent: "none" };

  let t = text.trim();

  if (FILLER_WORDS.test(t)) return { intent: "none" };

  const tClean = stripPunctuation(t);

  if (/截图|截屏|屏幕截图|截个图|截一下屏/.test(tClean)) {
    return { intent: "screenshot" };
  }

  const calcResult = parseCalculator(tClean);
  if (calcResult) return calcResult;

  const alarmResult = parseAlarm(tClean);
  if (alarmResult) return alarmResult;

  const pomoMatch = tClean.match(
    /(?:专注|番茄钟|番茄|开始专注)\s*(\d+)?\s*分钟?\s*(.*)/
  );
  if (pomoMatch) {
    return {
      intent: "pomodoro",
      params: {
        minutes: parseInt(pomoMatch[1]) || 25,
        title: stripPunctuation(pomoMatch[2]) || "专注时间结束",
      },
    };
  }

  const taskMatch = tClean.match(
    /^(?:帮我|我要|我想|请)?\s*(?:创建|添加|新建|建|加|记|新)\s*(?:一?个)?\s*任务\s*(.*)/
  );
  const taskMatch2 = tClean.match(
    /^(?:我)?有\s*(?:一?个)?\s*任务\s*(?:要建|要创建|要加|要添加|要记)?[：:，,\s]\s*(.*)/
  );
  const tm = taskMatch || taskMatch2;
  if (tm) {
    const rawTitle = (tm[1] || "").replace(/^[：:，,\s]+/, "").trim();
    return { intent: "agent_task", params: { text: tClean, title: rawTitle || "未命名任务", type: "task" } };
  }
  const bugMatch = tClean.match(
    /^(?:帮我|我要|我想|请)?\s*(?:创建|新建|添加|提交|提|报)\s*(?:一?个)?\s*bug\s*(.*)/i
  );
  if (bugMatch) {
    const rawTitle = (bugMatch[1] || "").replace(/^[，,\s]+/, "").trim();
    return { intent: "agent_task", params: { text: tClean, title: rawTitle || "未命名Bug", type: "bug" } };
  }
  const taskDone = tClean.match(/^(?:完成任务|任务完成|做完了)\s*(.*)/);
  if (taskDone) {
    return { intent: "task_done", params: { keyword: taskDone[1] } };
  }

  const noteMatch = tClean.match(
    /^(?:记一下|记录一下|记事|记下|笔记|备忘|记录|帮我记|记住)\s*(.*)/
  );
  if (noteMatch) {
    return { intent: "note", params: { content: noteMatch[1] || "" } };
  }

  if (/打开面板|打开仪表盘|显示面板|打开系统|打开主界面/.test(tClean)) {
    return { intent: "dashboard" };
  }

  return { intent: "unknown", params: { text: tClean } };
}

module.exports = { parseCommand };
