/* ═══════════════════════════════════════════════
   录音助手 - 仪表盘应用
   ═══════════════════════════════════════════════ */
const App = {
  currentPage: "home",
  taskFilter: "all",
  calcExpr: "",
  runtime: { mode: "web", screenshot: false },
  recordings: [],
  // 设置页：服务端返回的配置（密钥只有打码串）和尚未保存的修改（null 表示清除该项）
  settings: null,
  settingsDirty: {},
  pendingSettingsGroup: "",
  meetingAssistantWs: null,
  // 当前跟随的录音会话 id；服务端按 session 分桶广播，避免多客户端内容混在一起。
  meetingAssistantSessionId: null,
  // 会议助手接入配置，AppSecret 只拿到打码串。
  meetingAssistantConfig: {
    enabled: false,
    baseUrl: "",
    appCode: "",
    agentMatchFlowPath: "",
    hasAppSecret: false,
    appSecretMasked: "",
  },
  meetingAssistant: {
    status: "idle",
    asrStatus: "idle",
    asrProvider: "unknown",
    speakerSource: "unknown",
    speakerProfile: "multi",
    items: [],
    summary: "",
    error: "",
  },
  pendingRecordingSpeakerLabel: null,
  docReview: {
    sources: [],
    currentSourceId: "",
    currentPath: "",
    currentVersionId: "",
    currentVersion: null,
    currentContentHash: "",
    reviewStatus: null,
    anchors: [],
    comments: [],
    pendingTarget: null,
    diffMode: false,
    diffData: null,
    showOpenOnly: false,
  },
  commentCenter: {
    comments: [],
    summary: null,
    sourceId: "all",
    status: "all",
    location: "all",
    q: "",
  },
  docSources: [],
  reviewWorkflow: {
    docs: [],
    summary: null,
    statusOptions: {},
    sourceId: "all",
    status: "all",
    q: "",
  },

  /* ──── 初始化 ──── */
  async init() {
    await this.loadRuntime();
    this.applyRuntimeFeatures();
    this.bindNav();
    this.bindSearch();
    this.bindCalc();
    this.bindButtons();
    this.connectMeetingAssistant();
    this.loadSettingsStatus();
    this.navigate(this.pageFromHash() || "home");
    // Web 首页的入口卡片都在同一个命名窗口里打开 /dashboard#xxx，已打开时只改 hash 不刷新页面。
    window.addEventListener("hashchange", () => {
      const page = this.pageFromHash();
      if (!page) return;
      if (page !== this.currentPage) this.navigate(page);
      else if (page === "settings" && this.pendingSettingsGroup) {
        this.scrollToSettingsGroup(this.pendingSettingsGroup);
        this.pendingSettingsGroup = "";
      }
    });
  },

  /**
   * 从 /dashboard#tasks 这类地址取页面名，只认真实存在的页面。
   * 设置页支持 #settings/xfyun 直接定位到某个分组。
   */
  pageFromHash() {
    const [page, sub] = decodeURIComponent(location.hash.slice(1)).split("/");
    if (!page || !document.getElementById(`page-${page}`)) return "";
    if (page === "settings" && sub) this.pendingSettingsGroup = sub;
    return page;
  },

  async loadRuntime() {
    try {
      this.runtime = await api("/api/runtime");
    } catch {
      // 运行模式接口不可用时按 Web 版降级，避免展示桌面专属功能。
      this.runtime = { mode: "web", screenshot: false };
    }
  },

  applyRuntimeFeatures() {
    document.body.dataset.runtime = this.runtime.mode || "web";
    if (this.runtime.screenshot) return;

    document.querySelectorAll('[data-desktop-feature="screenshot"]').forEach((el) => {
      el.style.display = "none";
    });
  },

  /* ──── 路由导航 ──── */
  navigate(page) {
    if (this.currentPage === "settings" && page !== "settings" && Object.keys(this.settingsDirty).length) {
      if (!confirm("设置还没有保存，确定离开吗？")) return;
      this.settingsDirty = {};
    }
    if (page === "screenshots" && !this.runtime.screenshot) {
      toast("截图功能仅在桌面版可用", "info");
      page = "home";
    }

    this.currentPage = page;
    document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
    document.querySelectorAll(".nav-item").forEach((n) => n.classList.remove("active"));
    const target = document.getElementById(`page-${page}`);
    const nav = document.querySelector(`.nav-item[data-page="${page}"]`);
    if (target) target.classList.add("active");
    if (nav) nav.classList.add("active");

    const titles = {
      home: "首页",
      recordings: "语音录入",
      "meeting-assistant": "会议助手",
      speakers: "人物声纹",
      screenshots: "截图",
      notes: "记事本",
      tasks: "工作任务",
      alarms: "闹钟提醒",
      calculator: "计算器",
      docs: "文档评审",
      "comment-center": "评论中心",
      "doc-sources": "文档源",
      "review-workflow": "评审闭环",
      settings: "设置",
      search: "搜索结果",
    };
    document.getElementById("pageTitle").textContent = titles[page] || page;
    // 地址栏 hash 跟随当前页：刷新能停在原页，首页再点同一入口时 hash 有变化才能触发跳转。
    const hash = page === "home" || page === "search" ? "" : `#${page}`;
    if (location.hash !== hash) history.replaceState(null, "", location.pathname + location.search + hash);
    this.loadPageData(page);
  },

  bindNav() {
    document.querySelectorAll(".nav-item").forEach((item) => {
      item.addEventListener("click", () => this.navigate(item.dataset.page));
    });
    document.getElementById("toggleSidebar").addEventListener("click", () => {
      document.getElementById("sidebar").classList.toggle("collapsed");
    });
  },

  /* ──── 搜索 ──── */
  bindSearch() {
    let timer;
    document.getElementById("globalSearch").addEventListener("input", (e) => {
      clearTimeout(timer);
      const q = e.target.value.trim();
      if (!q) return this.navigate(this.currentPage === "search" ? "home" : this.currentPage);
      timer = setTimeout(() => this.doSearch(q), 400);
    });
  },

  async doSearch(q) {
    this.navigate("search");
    const results = await api(`/api/search?q=${encodeURIComponent(q)}`);
    const el = document.getElementById("searchResults");
    if (!results.length) {
      el.innerHTML = '<div class="empty-state"><p>未找到匹配的结果</p></div>';
      return;
    }
    const typeLabels = { recording: "录音", note: "笔记", task: "任务" };
    el.innerHTML = results
      .map(
        (r) => `
      <div class="search-result-item" onclick="App.navigate('${r.type === "recording" ? "recordings" : r.type + "s"}')">
        <span class="search-type-badge ${r.type}">${typeLabels[r.type] || r.type}</span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.title)}</span>
        <span style="font-size:12px;color:var(--text-secondary)">${formatTime(r.time)}</span>
      </div>`
      )
      .join("");
  },

  /* ──── 页面数据加载 ──── */
  async loadPageData(page) {
    switch (page) {
      case "home":
        return this.loadHome();
      case "recordings":
        return this.loadRecordings();
      case "meeting-assistant":
        return this.loadMeetingAssistantConfig().then(() => this.renderMeetingAssistant());
      case "speakers":
        return this.loadSpeakers();
      case "screenshots":
        return this.loadScreenshots();
      case "notes":
        return this.loadNotes();
      case "tasks":
        return this.loadTasks();
      case "alarms":
        return this.loadAlarms();
      case "calculator":
        return this.loadCalcHistory();
      case "docs":
        return this.loadDocs();
      case "comment-center":
        return this.loadCommentCenter();
      case "doc-sources":
        return this.loadDocSources();
      case "review-workflow":
        return this.loadReviewWorkflow();
      case "settings":
        return this.loadSettings();
    }
  },

  connectMeetingAssistant() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${location.host}/ws/meeting-assistant`;
    const ws = new WebSocket(wsUrl);
    this.meetingAssistantWs = ws;

    ws.onmessage = (event) => {
      try {
        this.applyMeetingAssistantEvent(JSON.parse(event.data));
      } catch {
        // 忽略格式异常的实时消息，避免影响控制面板其它功能。
      }
    };

    ws.onopen = () => {
      this.setMeetingAssistantStatus("connected");
    };

    ws.onclose = () => {
      if (this.meetingAssistantWs === ws) {
        this.setMeetingAssistantStatus("disconnected");
        this.meetingAssistantWs = null;
        setTimeout(() => this.connectMeetingAssistant(), 3000);
      }
    };

    ws.onerror = () => {
      this.setMeetingAssistantStatus("error");
    };
  },

  applyMeetingAssistantEvent(msg) {
    // 服务端按 sessionId 分桶广播（同一台机器可能有多个录音客户端）。
    // 仪表盘只跟随一场会议：以最近一次 reset 为准，其余 session 的事件直接忽略。
    if (msg.type === "meeting-assistant-reset") {
      this.meetingAssistantSessionId = msg.sessionId || null;
    } else if (
      msg.type !== "meeting-assistant-snapshot" &&
      msg.sessionId &&
      this.meetingAssistantSessionId &&
      msg.sessionId !== this.meetingAssistantSessionId
    ) {
      return;
    }

    switch (msg.type) {
      case "meeting-assistant-snapshot": {
        const sessions = Array.isArray(msg.sessions) ? msg.sessions : [];
        const active =
          sessions.find((item) => item.sessionId === msg.activeSessionId) ||
          sessions[sessions.length - 1] ||
          null;
        this.meetingAssistantSessionId = active?.sessionId || null;
        this.meetingAssistant = {
          status: active?.status || "idle",
          asrStatus: active?.asrStatus || "idle",
          asrProvider: active?.asrProvider || "unknown",
          speakerSource: active?.speakerSource || "unknown",
          speakerProfile: active?.speakerProfile || "multi",
          items: Array.isArray(active?.items) ? active.items : [],
          summary: active?.summary || "",
          error: active?.error || "",
        };
        break;
      }
      case "meeting-assistant-reset":
        this.meetingAssistant = {
          status: "connecting",
          asrStatus: "idle",
          asrProvider: "unknown",
          speakerSource: "unknown",
          speakerProfile: "multi",
          items: [],
          summary: "",
          error: "",
        };
        break;
      case "meeting-assistant-status":
        this.meetingAssistant.status = msg.status || this.meetingAssistant.status;
        break;
      case "meeting-assistant-asr-status":
        this.meetingAssistant.asrStatus = msg.asrStatus || this.meetingAssistant.asrStatus;
        this.meetingAssistant.asrProvider = msg.asrProvider || this.meetingAssistant.asrProvider;
        this.meetingAssistant.speakerSource = msg.speakerSource || this.meetingAssistant.speakerSource;
        this.meetingAssistant.speakerProfile = msg.speakerProfile || this.meetingAssistant.speakerProfile;
        break;
      case "meeting-assistant-delta":
      case "meeting-assistant-final":
        this.upsertMeetingAssistantItem(msg.sentenceId, msg.fullContent || msg.content || "");
        this.meetingAssistant.status = "thinking";
        break;
      case "meeting-assistant-summary-delta":
      case "meeting-assistant-summary":
        this.meetingAssistant.summary = msg.fullContent || msg.content || this.meetingAssistant.summary;
        if (msg.type === "meeting-assistant-summary") this.meetingAssistant.status = "done";
        break;
      case "meeting-assistant-error":
        this.meetingAssistant.status = "error";
        this.meetingAssistant.error = msg.message || "会议助手请求失败";
        break;
    }
    this.renderMeetingAssistant();
  },

  upsertMeetingAssistantItem(sentenceId, content) {
    const id = String(sentenceId ?? "");
    if (!id) return;
    const existing = this.meetingAssistant.items.find((item) => String(item.sentenceId) === id);
    if (existing) {
      existing.content = content || existing.content;
      return;
    }
    this.meetingAssistant.items.push({ sentenceId: id, content: content || "" });
  },

  setMeetingAssistantStatus(status) {
    this.meetingAssistant.status = status;
    this.renderMeetingAssistant();
  },

  /* ── 设置：界面编辑 .env 里的语音与接口配置 ── */

  /** 只拿状态（侧边栏红点、首页提示用），不渲染设置页。 */
  async loadSettingsStatus() {
    try {
      const data = await api("/api/settings");
      if (data?.groups) this.settings = data;
    } catch {
      // 读不到配置时不提示，避免误报。
    }
    this.renderSettingsNavDot();
  },

  renderSettingsNavDot() {
    const dot = document.getElementById("settingsNavDot");
    if (dot) dot.hidden = !this.settings || this.settings.providerReady;
  },

  async loadSettings() {
    const data = await api("/api/settings");
    this.settings = data;
    this.settingsDirty = {};
    this.renderSettings();
    this.renderSettingsNavDot();
    this.bindSettingsEvents();
    if (this.pendingSettingsGroup) {
      this.scrollToSettingsGroup(this.pendingSettingsGroup);
      this.pendingSettingsGroup = "";
    }
  },

  settingsField(key) {
    for (const group of this.settings?.groups || []) {
      const field = group.fields.find((f) => f.key === key);
      if (field) return field;
    }
    return null;
  },

  /** 界面上「原本」的值：未设置的下拉 / 开关按默认值算，这样选回默认不算修改。 */
  settingsOriginal(field) {
    if (field.type === "secret") return "";
    if (field.type === "select" || field.type === "toggle") return field.value || field.defaultValue || "";
    return field.value || "";
  },

  renderSettings() {
    const data = this.settings;
    if (!data?.groups) return;
    const providerGroups = new Set(data.providers.map((p) => p.group));
    const statusOf = (groupId) => data.providers.find((p) => p.group === groupId);

    document.getElementById("settingsIntro").innerHTML =
      `配置保存在 <code>${esc(data.envFile)}</code>。保存后下一次录音或请求就生效，不用重启。`;

    // 左侧目录：识别引擎相关的分组带状态点
    document.getElementById("settingsToc").innerHTML = data.groups.map((group) => {
      const status = statusOf(group.id);
      const dot = status
        ? `<i class="settings-dot ${status.ready ? "ok" : status.current ? "warn" : ""}" title="${status.ready ? "配置完整" : "缺少必填项"}"></i>`
        : "";
      return `<a class="settings-toc-item" href="#settings/${group.id}" data-group="${group.id}">${esc(group.title)}${dot}</a>`;
    }).join("");

    document.getElementById("settingsBody").innerHTML = data.groups.map((group) => {
      if (group.id === "asr") return this.renderSettingsEngine(group);
      const status = statusOf(group.id);
      let badge = "";
      if (status) {
        badge = status.ready
          ? `<span class="settings-badge ok">配置完整</span>`
          : `<span class="settings-badge ${status.current ? "warn" : ""}">缺少 ${esc(status.missing.join("、"))}</span>`;
        if (status.current) badge = `<span class="settings-badge current">当前引擎</span>${badge}`;
      }
      const basic = group.fields.filter((f) => !f.advanced);
      const advanced = group.fields.filter((f) => f.advanced);
      const extra = group.id === "meeting"
        ? `<button class="btn btn-sm" onclick="App.navigate('meeting-assistant')">去配置 AppCode 和开关</button>`
        : "";
      return `
        <section class="card settings-card${providerGroups.has(group.id) && status?.current ? " is-current" : ""}" id="settings-group-${group.id}" data-group="${group.id}">
          <div class="settings-card-head">
            <div>
              <h3>${esc(group.title)}</h3>
              <p>${esc(group.description)}</p>
            </div>
            <div class="settings-card-badges">${badge}${extra}</div>
          </div>
          <div class="settings-grid">${basic.map((f) => this.renderSettingsField(f)).join("")}</div>
          ${advanced.length ? `
          <details class="settings-advanced">
            <summary>高级参数（${advanced.length}）<span>不清楚含义时保持留空，使用默认值</span></summary>
            <div class="settings-grid">${advanced.map((f) => this.renderSettingsField(f)).join("")}</div>
          </details>` : ""}
        </section>`;
    }).join("");

    this.updateSettingsSavebar();
  },

  renderSettingsEngine(group) {
    const data = this.settings;
    const field = group.fields[0];
    const selected = this.settingsDirty.ASR_PROVIDER ?? this.settingsOriginal(field);
    const cards = data.providers.map((p) => {
      let state;
      if (p.value === "funasr") state = `<span class="settings-engine-state"><i class="settings-dot ok"></i>需要本机启动 FunASR 服务</span>`;
      else if (p.ready) state = `<span class="settings-engine-state"><i class="settings-dot ok"></i>配置完整</span>`;
      else state = `<span class="settings-engine-state"><i class="settings-dot warn"></i>缺少 ${esc(p.missing.join("、"))}</span>`;
      return `
        <button type="button" class="settings-engine${p.value === selected ? " selected" : ""}" role="radio"
          aria-checked="${p.value === selected}" data-provider="${p.value}">
          <span class="settings-engine-top">
            <span class="settings-engine-name">${esc(p.label)}</span>
            ${p.current ? `<span class="settings-badge current">正在使用</span>` : ""}
          </span>
          ${state}
          <span class="settings-engine-link" data-goto="${p.group}">填写配置 →</span>
        </button>`;
    }).join("");
    return `
      <section class="card settings-card" id="settings-group-asr" data-group="asr">
        <div class="settings-card-head">
          <div>
            <h3>${esc(group.title)}</h3>
            <p>${esc(group.description)}</p>
          </div>
        </div>
        <div class="settings-engines" role="radiogroup" aria-label="识别引擎">${cards}</div>
      </section>`;
  },

  renderSettingsField(field) {
    const id = `set-${field.key}`;
    const dirty = Object.prototype.hasOwnProperty.call(this.settingsDirty, field.key);
    const pending = this.settingsDirty[field.key];
    const value = dirty ? (pending ?? "") : this.settingsOriginal(field);
    const req = field.required ? `<span class="req" title="必填">*</span>` : "";
    const label = `<label for="${id}">${esc(field.label)}${req}<code>${esc(field.key)}</code></label>`;
    const help = field.help ? `<p class="settings-help">${esc(field.help)}</p>` : "";
    const cls = `form-group settings-field${dirty ? " dirty" : ""}${field.type === "textarea" ? " full" : ""}`;
    let control;

    if (field.type === "select") {
      control = `<select id="${id}" data-key="${field.key}">${field.options.map((o) =>
        `<option value="${attr(o.value)}"${o.value === value ? " selected" : ""}>${esc(o.label)}${o.value === field.defaultValue ? "（默认）" : ""}</option>`).join("")}</select>`;
    } else if (field.type === "toggle") {
      control = `<label class="settings-switch"><input type="checkbox" id="${id}" data-key="${field.key}"${value === "0" ? "" : " checked"} />
        <span class="settings-switch-track" aria-hidden="true"></span><span class="settings-switch-text">${value === "0" ? "已关闭" : "已开启"}</span></label>`;
    } else if (field.type === "textarea") {
      control = `<textarea id="${id}" data-key="${field.key}" rows="3" placeholder="${attr(field.placeholder)}">${esc(value)}</textarea>`;
    } else if (field.type === "secret") {
      const clearing = dirty && pending === null;
      const placeholder = clearing
        ? "保存后清除"
        : field.hasValue ? `已保存 ${field.masked}，留空则不修改` : (field.placeholder || "未填写");
      control = `
        <div class="settings-secret${clearing ? " clearing" : ""}">
          <input type="password" id="${id}" data-key="${field.key}" value="${clearing ? "" : attr(pending || "")}"
            placeholder="${attr(placeholder)}" autocomplete="new-password" spellcheck="false"${clearing ? " disabled" : ""} />
          <span class="settings-secret-actions">
            <button type="button" class="settings-link" data-reveal="${field.key}"${clearing ? " hidden" : ""}>显示</button>
            ${field.hasValue ? `<button type="button" class="settings-link danger" data-clear="${field.key}">${clearing ? "撤销" : "清除"}</button>` : ""}
          </span>
        </div>`;
    } else {
      const extra = field.type === "number"
        ? ` inputmode="decimal"${field.min !== undefined ? ` min="${field.min}"` : ""}${field.max !== undefined ? ` max="${field.max}"` : ""}${field.step ? ` step="${field.step}"` : ""}`
        : "";
      control = `<input type="${field.type === "number" ? "number" : "text"}" id="${id}" data-key="${field.key}" value="${attr(value)}"
        placeholder="${attr(field.placeholder || "未填写")}" spellcheck="false"${extra} />`;
    }
    return `<div class="${cls}" data-field="${field.key}">${label}${control}${help}</div>`;
  },

  bindSettingsEvents() {
    if (this.settingsEventsBound) return;
    this.settingsEventsBound = true;
    const page = document.getElementById("page-settings");

    const onEdit = (e) => {
      const el = e.target.closest("[data-key]");
      if (!el) return;
      const field = this.settingsField(el.dataset.key);
      if (!field) return;
      const value = el.type === "checkbox" ? (el.checked ? "1" : "0") : el.value;
      if (el.type === "checkbox") {
        el.closest(".settings-switch").querySelector(".settings-switch-text").textContent = el.checked ? "已开启" : "已关闭";
      }
      this.setSettingsDirty(field, value);
    };
    page.addEventListener("input", onEdit);
    page.addEventListener("change", onEdit);

    page.addEventListener("click", (e) => {
      const goto = e.target.closest("[data-goto]");
      if (goto) {
        e.preventDefault();
        e.stopPropagation();
        this.scrollToSettingsGroup(goto.dataset.goto);
        return;
      }
      const engine = e.target.closest(".settings-engine");
      if (engine) {
        const field = this.settingsField("ASR_PROVIDER");
        this.setSettingsDirty(field, engine.dataset.provider);
        page.querySelectorAll(".settings-engine").forEach((card) => {
          const on = card === engine;
          card.classList.toggle("selected", on);
          card.setAttribute("aria-checked", String(on));
        });
        return;
      }
      const reveal = e.target.closest("[data-reveal]");
      if (reveal) {
        const input = document.getElementById(`set-${reveal.dataset.reveal}`);
        input.type = input.type === "password" ? "text" : "password";
        reveal.textContent = input.type === "password" ? "显示" : "隐藏";
        return;
      }
      const clear = e.target.closest("[data-clear]");
      if (clear) {
        const field = this.settingsField(clear.dataset.clear);
        if (this.settingsDirty[field.key] === null) delete this.settingsDirty[field.key];
        else this.settingsDirty[field.key] = null;
        // 只重画这一个字段，其它没保存的输入不受影响
        const wrap = page.querySelector(`[data-field="${field.key}"]`);
        wrap.outerHTML = this.renderSettingsField(field);
        this.updateSettingsSavebar();
        return;
      }
      const toc = e.target.closest(".settings-toc-item");
      if (toc) {
        e.preventDefault();
        this.scrollToSettingsGroup(toc.dataset.group);
      }
    });

    // 有未保存的修改时，关页面前提醒一下
    window.addEventListener("beforeunload", (e) => {
      if (Object.keys(this.settingsDirty || {}).length) e.preventDefault();
    });
  },

  setSettingsDirty(field, value) {
    const original = this.settingsOriginal(field);
    const normalized = field.type === "secret" ? value.trim() : value;
    if (normalized === original || (field.type === "secret" && normalized === "")) {
      delete this.settingsDirty[field.key];
    } else {
      this.settingsDirty[field.key] = normalized;
    }
    document.querySelector(`#page-settings [data-field="${field.key}"]`)
      ?.classList.toggle("dirty", field.key in this.settingsDirty);
    this.updateSettingsSavebar();
  },

  updateSettingsSavebar() {
    const count = Object.keys(this.settingsDirty || {}).length;
    const bar = document.getElementById("settingsSavebar");
    if (!bar) return;
    bar.hidden = count === 0;
    document.getElementById("settingsSavebarText").textContent = `有 ${count} 项修改尚未保存`;
  },

  scrollToSettingsGroup(groupId) {
    const card = document.getElementById(`settings-group-${groupId}`);
    if (!card) return;
    // 只滚内容区，不用 scrollIntoView：最后几组滚不到顶部时，它会去滚 overflow:hidden 的 body/.main，
    // 把顶栏和侧边栏整体推出窗口。
    const content = card.closest(".content");
    const top = card.getBoundingClientRect().top - content.getBoundingClientRect().top + content.scrollTop - 16;
    content.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    card.classList.remove("flash");
    void card.offsetWidth;
    card.classList.add("flash");
    // 跳到分组时打开它的高级参数没有必要；只把第一个可编辑项设为焦点，方便直接填写
    const first = card.querySelector("input:not([disabled]), select, textarea");
    if (first && groupId !== "asr") setTimeout(() => first.focus({ preventScroll: true }), 400);
  },

  async saveSettings() {
    const values = { ...this.settingsDirty };
    if (!Object.keys(values).length) return;
    const btn = document.getElementById("btnSaveSettings");
    btn.disabled = true;
    try {
      const result = await api("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values }),
      });
      if (!result?.success) {
        toast(result?.message || "保存设置失败", "error");
        return;
      }
      this.settings = result.data;
      this.settingsDirty = {};
      this.renderSettings();
      this.renderSettingsNavDot();
      toast("设置已保存，下一次录音时生效", "success");
    } catch {
      toast("保存设置失败，请检查服务是否在运行", "error");
    } finally {
      btn.disabled = false;
    }
  },

  discardSettings() {
    this.settingsDirty = {};
    this.renderSettings();
  },

  /* ── 会议助手接入配置 ── */

  async loadMeetingAssistantConfig() {
    const config = await api("/api/meeting-assistant/config");
    if (config && typeof config === "object") {
      this.meetingAssistantConfig = config;
    }
    this.renderMeetingAssistantConfig();
  },

  /** 三项齐全才算配置完成，和服务端 isConfigured 的判定保持一致。 */
  isMeetingAssistantConfigured() {
    const config = this.meetingAssistantConfig || {};
    return Boolean(config.appCode && config.hasAppSecret && config.agentMatchFlowPath);
  },

  renderMeetingAssistantConfig() {
    const config = this.meetingAssistantConfig || {};
    const toggleBtn = document.getElementById("btnMeetingAssistantToggle");
    const switchEl = document.getElementById("meetingAssistantSwitch");
    const summaryEl = document.getElementById("meetingAssistantConfigSummary");
    if (!toggleBtn || !summaryEl) return;

    // 只保留一个按钮：关闭态点它去开启（顺带确认配置），开启态点它去关闭。
    toggleBtn.textContent = config.enabled ? "关闭" : "开启";
    toggleBtn.className = config.enabled ? "btn btn-sm btn-danger" : "btn btn-sm btn-primary";
    if (switchEl) {
      switchEl.textContent = config.enabled ? "已开启" : "已关闭";
      switchEl.className = `meeting-assistant-switch ${config.enabled ? "on" : "off"}`;
    }

    if (!this.isMeetingAssistantConfigured()) {
      summaryEl.innerHTML =
        "尚未配置。点「开启」填写 AppCode、AppSecret 与 AgentMatchFlowPath，确认后才会启用。API Base URL 可按需修改。";
      summaryEl.className = "meeting-assistant-config-summary unset";
      return;
    }

    const baseUrl = config.baseUrl || "默认地址";
    summaryEl.innerHTML =
      `API Base URL: ${esc(baseUrl)}　` +
      `AppCode: ${esc(config.appCode)}　` +
      `AppSecret: ${esc(config.appSecretMasked)}　` +
      `AgentMatchFlowPath: ${esc(config.agentMatchFlowPath)}　` +
      `<a href="#" class="meeting-assistant-config-edit" onclick="event.preventDefault();App.openMeetingAssistantConfig()">修改配置</a>`;
    summaryEl.className = `meeting-assistant-config-summary ${config.enabled ? "on" : "off"}`;
  },

  /** 开启前先弹出配置确认；关闭则直接确认后关掉。 */
  async toggleMeetingAssistant() {
    if (this.meetingAssistantConfig.enabled) {
      if (!confirm("确定关闭会议助手吗？关闭后录音不再把逐句内容发送给智能体。")) return;
      await this.saveMeetingAssistantConfig({ enabled: false });
      return;
    }
    this.openMeetingAssistantConfig(true);
  },

  /**
   * 打开配置弹窗。
   * @param {boolean} enableOnConfirm true 表示确认后同时开启（由「开启」按钮触发）
   */
  openMeetingAssistantConfig(enableOnConfirm = false) {
    const config = this.meetingAssistantConfig || {};
    // 已保存过 AppSecret 时用打码串占位，不回显明文；用户不改就沿用原值。
    const secretPlaceholder = config.hasAppSecret
      ? `已保存（${esc(config.appSecretMasked)}），留空则不修改`
      : "请输入 AppSecret";

    this.pendingMeetingAssistantEnable = enableOnConfirm === true;

    const configured = this.isMeetingAssistantConfigured();
    let hint;
    if (!configured) {
      // 开启前必须先配置：这里用警示样式说清楚，而不是等提交后才报错。
      hint = `<p class="modal-hint warn">会议助手尚未配置，需要先填写下列三项才能开启。<br>
        开启后，录音过程中的每句转写会发送给该智能体。</p>`;
    } else if (enableOnConfirm) {
      hint = `<p class="modal-hint">开启后，录音过程中的每句转写会发送给下列智能体，请确认配置无误。</p>`;
    } else {
      hint = `<p class="modal-hint">修改后立即生效，下一次录音开始时使用新配置。</p>`;
    }

    this.openModal(
      enableOnConfirm ? "开启会议助手" : "修改会议助手配置",
      `
      ${hint}
      <div class="form-group">
        <label>API Base URL</label>
        <input type="text" id="maBaseUrl" value="${attr(config.baseUrl || "")}" placeholder="默认：https://v6.kaleido.guru" />
      </div>
      <div class="form-group">
        <label>AppCode</label>
        <input type="text" id="maAppCode" value="${attr(config.appCode || "")}" placeholder="请输入 AppCode" />
      </div>
      <div class="form-group">
        <label>AppSecret</label>
        <input type="password" id="maAppSecret" value="" placeholder="${attr(secretPlaceholder)}" autocomplete="new-password" />
      </div>
      <div class="form-group">
        <label>AgentMatchFlowPath</label>
        <input type="text" id="maFlowPath" value="${attr(config.agentMatchFlowPath || "")}" placeholder="请输入 AgentMatchFlowPath" />
      </div>
      `,
      `
      <button class="btn" onclick="App.closeModal()">取消</button>
      <button class="btn btn-primary" onclick="App.submitMeetingAssistantConfig()">
        ${enableOnConfirm ? "确认并开启" : "保存"}
      </button>
      `
    );
    setTimeout(() => document.getElementById("maAppCode")?.focus(), 0);
  },

  async submitMeetingAssistantConfig() {
    const baseUrl = (document.getElementById("maBaseUrl")?.value || "").trim();
    const appCode = (document.getElementById("maAppCode")?.value || "").trim();
    const appSecret = (document.getElementById("maAppSecret")?.value || "").trim();
    const agentMatchFlowPath = (document.getElementById("maFlowPath")?.value || "").trim();
    const enable = this.pendingMeetingAssistantEnable === true;

    if (!appCode) return toast("请输入 AppCode", "error");
    if (!agentMatchFlowPath) return toast("请输入 AgentMatchFlowPath", "error");
    // Base URL 可以为空走默认值；填写时提前拦截非 http(s) 地址。
    if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
      return toast("API Base URL 必须是 http 或 https 地址", "error");
    }
    // 首次配置必须填 AppSecret；已保存过则允许留空表示沿用。
    if (!appSecret && !this.meetingAssistantConfig.hasAppSecret) {
      return toast("请输入 AppSecret", "error");
    }

    const payload = { baseUrl, appCode, agentMatchFlowPath };
    if (appSecret) payload.appSecret = appSecret;
    if (enable) payload.enabled = true;

    await this.saveMeetingAssistantConfig(payload, { closeModal: true });
  },

  async saveMeetingAssistantConfig(payload, { closeModal = false } = {}) {
    const result = await api("/api/meeting-assistant/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!result?.success) {
      // 配置不全时服务端会回滚开关，同时带回最新状态用于刷新界面。
      if (result?.data) {
        this.meetingAssistantConfig = result.data;
        this.renderMeetingAssistantConfig();
      }
      return toast(result?.message || "保存会议助手配置失败", "error");
    }

    this.meetingAssistantConfig = result.data;
    this.pendingMeetingAssistantEnable = false;
    if (closeModal) this.closeModal();
    this.renderMeetingAssistantConfig();
    toast(result.data.enabled ? "会议助手已开启" : "会议助手已关闭", "success");
  },

  prettyMeetingAssistantStatus(status) {
    const s = String(status || "").toLowerCase();
    // Dashboard 展示的是旁路实时状态，不改变录音识别主流程。
    if (s === "connected") return "已连接";
    if (s === "connecting") return "连接中";
    if (s === "ready") return "会话已就绪";
    if (s === "thinking") return "处理中";
    if (s === "finalizing") return "生成结束输出";
    if (s === "done") return "已完成";
    if (s === "disabled") return "未配置";
    if (s === "error") return "异常";
    if (s === "disconnected") return "连接断开";
    return "等待录音";
  },

  prettyMeetingAssistantAsrStatus(status) {
    const s = String(status || "").toLowerCase();
    // 这里沿用悬浮窗的“在线识别”语义，只展示当前实时识别链路状态。
    if (s === "online") return "在线识别";
    if (s === "stopping") return "停止中";
    if (s === "stopped") return "已停止";
    if (s === "error") return "异常";
    return "未开始";
  },

  prettyAsrProvider(provider) {
    const p = String(provider || "unknown").toLowerCase();
    if (p === "xfyun") return "XFYun";
    if (p === "xfyun_llm") return "XFYun-LLM";
    if (p === "funasr" || p === "sensevoice") return "FunASR";
    if (p === "aliyun" || p === "isi") return "Aliyun";
    return "Unknown";
  },

  prettySpeakerSource(source) {
    const s = String(source || "unknown").toLowerCase();
    if (s === "xfyun") return "XFYun";
    if (s === "xfyun_llm") return "XFYun-LLM";
    if (s === "funasr" || s === "sensevoice") return "FunASR";
    if (s === "aliyun" || s === "isi") return "Aliyun";
    if (s === "local") return "LocalFallback";
    return "Unknown";
  },

  renderMeetingAssistant() {
    const statusEl = document.getElementById("meetingAssistantDashStatus");
    const asrStatusEl = document.getElementById("meetingAssistantAsrStatus");
    const listEl = document.getElementById("meetingAssistantDashList");
    const summaryEl = document.getElementById("meetingAssistantDashSummary");
    if (!statusEl || !listEl || !summaryEl) return;

    statusEl.textContent = this.prettyMeetingAssistantStatus(this.meetingAssistant.status);
    if (this.meetingAssistant.error) {
      statusEl.textContent += `：${this.meetingAssistant.error}`;
    }

    if (asrStatusEl) {
      asrStatusEl.textContent =
        `${this.prettyMeetingAssistantAsrStatus(this.meetingAssistant.asrStatus)} | ` +
        `ASR: ${this.prettyAsrProvider(this.meetingAssistant.asrProvider)} | ` +
        `Speaker: ${this.prettySpeakerSource(this.meetingAssistant.speakerSource)} | ` +
        `Profile: ${this.meetingAssistant.speakerProfile || "multi"}`;
    }

    listEl.innerHTML = this.meetingAssistant.items.length
      ? this.meetingAssistant.items
          .map((item) => `
            <div class="meeting-assistant-dash-item">
              <strong>第 ${Number(item.sentenceId) + 1 || item.sentenceId} 句</strong>
              <div>${esc(item.content || "")}</div>
            </div>
          `)
          .join("")
      : '<div class="empty-state"><p>录音开始后，这里会显示每句对应的助手反馈</p></div>';

    summaryEl.textContent = this.meetingAssistant.summary ||
      '停止录音后会自动发送“会议最后总结”，结果会显示在这里。';
  },

  /* ──── 首页 ──── */
  async loadHome() {
    const [stats, activities, tasks] = await Promise.all([
      api("/api/stats"),
      api("/api/activities?limit=20"),
      api("/api/tasks"),
    ]);

    const screenshotStat = this.runtime.screenshot
      ? `
      <div class="stat-card" onclick="App.navigate('screenshots')" data-desktop-feature="screenshot">
        <div class="stat-icon screenshot"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg></div>
        <div class="stat-info"><h4>${stats.screenshots || 0}</h4><p>截图</p></div>
      </div>`
      : "";

    document.getElementById("statsGrid").innerHTML = `
      <div class="stat-card" onclick="App.navigate('recordings')">
        <div class="stat-icon recording"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm-1-9a1 1 0 1 1 2 0v6a1 1 0 1 1-2 0V5zm-4 6a5 5 0 0 0 10 0h2a7 7 0 0 1-6 6.93V21h-2v-3.07A7 7 0 0 1 5 11h2z"/></svg></div>
        <div class="stat-info"><h4>${stats.recordings || 0}</h4><p>语音录入</p></div>
      </div>
      ${screenshotStat}
      <div class="stat-card" onclick="App.navigate('notes')">
        <div class="stat-icon note"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></div>
        <div class="stat-info"><h4>${stats.notes || 0}</h4><p>笔记</p></div>
      </div>
      <div class="stat-card" onclick="App.navigate('tasks')">
        <div class="stat-icon task"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg></div>
        <div class="stat-info"><h4>${stats.tasksDone || 0} / ${stats.tasks || 0}</h4><p>任务完成</p></div>
      </div>
      <div class="stat-card" onclick="App.navigate('alarms')">
        <div class="stat-icon alarm"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg></div>
        <div class="stat-info"><h4>${stats.alarms || 0}</h4><p>闹钟提醒</p></div>
      </div>
    `;

    document.getElementById("activityList").innerHTML = activities.length
      ? activities
          .map(
            (a) => `
        <div class="activity-item">
          <div class="activity-dot ${a.type}"></div>
          <div class="activity-content">
            <div class="title">${esc(a.title)}</div>
            ${a.detail ? `<div class="detail">${esc(a.detail)}</div>` : ""}
          </div>
          <div class="activity-time">${formatTime(a.time)}</div>
        </div>`
          )
          .join("")
      : '<div class="empty-state"><p>暂无动态</p></div>';

    const pending = tasks.filter((t) => t.status !== "done").slice(0, 5);
    document.getElementById("pendingTasks").innerHTML = pending.length
      ? pending
          .map(
            (t) => `
        <div class="task-item">
          <button class="task-check" onclick="App.toggleTask('${t.id}')"></button>
          <div class="task-info">
            <div class="task-title">${esc(t.title)}</div>
            <div class="task-meta">${formatTime(t.createdAt)}</div>
          </div>
          <div class="priority-dot ${t.priority}"></div>
        </div>`
          )
          .join("")
      : '<div style="padding:20px;text-align:center;color:var(--text-secondary);font-size:14px">全部完成</div>';
  },

  /* ──── 录音列表 ──── */
  async loadRecordings() {
    const list = await api("/api/recordings");
    this.recordings = Array.isArray(list) ? list : [];
    const el = document.getElementById("recordingList");
    if (!list.length) {
      el.innerHTML = '<div class="empty-state"><p>暂无录音记录</p></div>';
      return;
    }
    el.innerHTML = list
      .map(
        (r, idx) => `
      <div class="recording-item">
        <div class="recording-time">${esc(r.time || "")}</div>
        <div class="recording-text">
          ${this.renderRecordingSummary(r)}
          ${this.renderRecordingDetail(r, idx)}
          ${r.command ? `<div><span class="recording-badge command">${esc(r.command.action)}：${esc(r.command.message)}</span></div>` : ""}
          ${r.agent && r.agent.agentReply ? `<div><span class="recording-badge agent">AI: ${esc(typeof r.agent.agentReply === "string" ? r.agent.agentReply.slice(0, 80) : "已回复")}</span></div>` : ""}
        </div>
        ${r.wav ? `<div class="recording-audio"><audio controls preload="none" src="/recordings/${r.wav}"></audio></div>` : ""}
        <div class="recording-actions">
          <button class="btn btn-sm btn-danger" onclick="App.deleteRecording(${idx})">删除</button>
        </div>
      </div>`
      )
      .join("");
  },

  /**
   * 删除一条录音记录。
   * 传索引而不是 wav：没采到音频的记录 wav 为 null，索引取自刚渲染的同一份列表。
   * @param {number} index
   */
  async deleteRecording(index) {
    const record = this.recordings[index];
    if (!record) return;

    const label = record.time || record.wav || "这条录音";
    const audioHint = record.wav ? "，音频文件也会一并删除" : "";
    if (!confirm(`确定删除「${label}」吗？转写文本、逐句内容和会议总结将无法恢复${audioHint}。`)) {
      return;
    }

    const result = await api("/api/recordings", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wav: record.wav || null, time: record.time || "" }),
    });
    if (!result || result.success === false) {
      toast(result?.message || "删除失败", "error");
      return;
    }

    toast(result.audioRemoved ? "录音与音频文件已删除" : "录音记录已删除", "success");
    await this.loadRecordings();
  },

  /** 清空全部录音记录及音频文件。 */
  async clearRecordings() {
    const total = this.recordings.length;
    if (!total) {
      toast("当前没有录音记录", "info");
      return;
    }

    const withAudio = this.recordings.filter((r) => r.wav).length;
    // 这是不可恢复的整体清空，确认文案要把范围和后果说清楚。
    if (
      !confirm(
        `确定清空全部 ${total} 条录音记录吗？\n` +
        `转写文本、逐句内容和会议总结将全部删除，其中 ${withAudio} 条的音频文件也会一并删除。\n` +
        `此操作无法恢复。`
      )
    ) {
      return;
    }

    const result = await api("/api/recordings/all", { method: "DELETE" });
    if (!result || result.success === false) {
      toast(result?.message || "清空失败", "error");
      return;
    }

    toast(`已清空 ${result.removed} 条录音，删除 ${result.audioRemoved} 个音频文件`, "success");
    await this.loadRecordings();
  },

  renderRecordingSummary(record) {
    // 列表默认只展示摘要，避免逐句内容占满页面。
    return `<div class="recording-summary">${esc(record.text || "")}</div>`;
  },

  openMeetingSummaryPicker() {
    const candidates = this.recordings.filter((record) => String(record.text || "").trim());
    if (!candidates.length) return toast("没有可复制的录音内容", "info");

    const options = candidates
      .map((record, index) => {
        const wav = attr(record.wav || "");
        const title = esc(record.time || record.wav || `录音${index + 1}`);
        const text = esc(String(record.text || "").slice(0, 80));
        return `
          <label class="meeting-summary-option">
            <input type="checkbox" value="${wav}" />
            <span>
              <strong>${title}</strong>
              <small>${text}</small>
            </span>
          </label>
        `;
      })
      .join("");

    this.openModal(
      "会议内容复制",
      `
      <p class="modal-hint">选择一条或多条录音后，可复制会议内容，也可合并转写文本和说话人信息一起生成会议总结。</p>
      <div class="meeting-summary-actions">
        <button type="button" class="btn btn-sm" onclick="App.selectAllMeetingSummaryOptions(true)">全选</button>
        <button type="button" class="btn btn-sm" onclick="App.selectAllMeetingSummaryOptions(false)">全不选</button>
      </div>
      <div class="meeting-summary-picker">${options}</div>
      <div id="meetingSummaryBatchResult"></div>
      `,
      `
      <button class="btn" onclick="App.closeModal()">取消</button>
      <button class="btn" onclick="App.copySelectedMeetingContent()">内容复制</button>
      <button class="btn btn-primary" onclick="App.submitBatchMeetingSummary()">开始总结</button>
      `
    );
  },

  selectAllMeetingSummaryOptions(checked) {
    document.querySelectorAll(".meeting-summary-picker input[type='checkbox']").forEach((input) => {
      input.checked = Boolean(checked);
    });
  },

  getSelectedMeetingSummaryRecords() {
    const checked = Array.from(document.querySelectorAll(".meeting-summary-picker input:checked"));
    const selected = new Set(checked.map((input) => input.value).filter(Boolean));
    return this.recordings.filter((record) => selected.has(record.wav || ""));
  },

  formatMeetingContentForCopy(records) {
    return records
      .map((record, index) => {
        const lines = [`会议内容 ${index + 1}`, `时间：${record.time || record.wav || "未记录"}`];
        const utterances = Array.isArray(record.utterances) ? record.utterances : [];
        if (utterances.length) {
          lines.push("逐句内容：");
          utterances.forEach((utterance) => {
            // 复制时保留说话人，方便后续粘贴给外部会议纪要工具。
            const speaker = utterance.speakerLabel || "说话人";
            const text = String(utterance.text || "").trim();
            if (text) lines.push(`${speaker}：${text}`);
          });
        } else {
          lines.push("转写内容：");
          lines.push(String(record.text || "").trim());
        }
        return lines.filter(Boolean).join("\n");
      })
      .join("\n\n");
  },

  async copySelectedMeetingContent() {
    const records = this.getSelectedMeetingSummaryRecords();
    if (!records.length) return toast("请选择需要复制的录音", "error");

    const content = this.formatMeetingContentForCopy(records);
    try {
      await copyTextToClipboard(content);
      toast("会议内容已复制", "success");
    } catch (error) {
      toast(`会议内容复制失败：${error.message}`, "error");
    }
  },

  async submitBatchMeetingSummary() {
    const wavs = this.getSelectedMeetingSummaryRecords().map((record) => record.wav).filter(Boolean);
    const resultEl = document.getElementById("meetingSummaryBatchResult");
    if (!wavs.length) return toast("请选择需要总结的录音", "error");
    if (resultEl) resultEl.innerHTML = '<div class="recording-meeting-summary pending"><strong>会议总结</strong><p>会议总结生成中</p></div>';

    try {
      const result = await api("/api/meeting-summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wavs }),
      });
      if (!result?.success) {
        if (resultEl) {
          resultEl.innerHTML = `<div class="recording-meeting-summary failed"><strong>会议总结生成失败</strong><p>${esc(result?.message || "外部总结接口不可用")}</p></div>`;
        }
        return toast(result?.message || "会议总结生成失败", "error");
      }
      if (resultEl) {
        resultEl.innerHTML = this.renderMeetingSummary({ meetingSummary: result.data });
      }
      toast("会议总结已生成", "success");
    } catch (error) {
      if (resultEl) {
        resultEl.innerHTML = `<div class="recording-meeting-summary failed"><strong>会议总结生成失败</strong><p>${esc(error.message)}</p></div>`;
      }
      toast(`会议总结生成失败：${error.message}`, "error");
    }
  },

  renderMeetingSummary(record) {
    const summary = record.meetingSummary || {};
    const status = summary.status || "";
    const hasTranscript = Boolean(String(record.text || "").trim());
    if (!status) {
      if (!hasTranscript) {
        return `<div class="recording-meeting-summary skipped"><strong>会议总结</strong><p>暂无可总结内容</p></div>`;
      }
      const wav = encodeURIComponent(record.wav || "");
      return `
        <div class="recording-meeting-summary pending">
          <strong>会议总结</strong>
          <p>尚未生成</p>
          ${record.wav ? `<button type="button" class="meeting-summary-retry" onclick="App.retryMeetingSummary('${wav}')">生成会议总结</button>` : ""}
        </div>
      `;
    }

    const renderItems = (title, items) => {
      const list = Array.isArray(items) ? items : [];
      if (!list.length) return "";
      const rows = list
        .map((item) => {
          if (typeof item === "string") return `<li>${esc(item)}</li>`;
          const text = item.title || item.content || item.text || item.task || JSON.stringify(item);
          const owner = item.owner || item.assignee || item.speaker || "";
          const due = item.dueDate || item.deadline || "";
          const meta = [owner, due].filter(Boolean).join(" · ");
          return `<li>${esc(String(text))}${meta ? `<span>${esc(meta)}</span>` : ""}</li>`;
        })
        .join("");
      return `<div class="meeting-summary-section"><strong>${esc(title)}</strong><ul>${rows}</ul></div>`;
    };

    if (status === "pending") {
      return `<div class="recording-meeting-summary pending"><strong>会议总结</strong><p>会议总结生成中</p></div>`;
    }
    if (status === "skipped") {
      return `<div class="recording-meeting-summary skipped"><strong>会议总结</strong><p>暂无可总结内容</p></div>`;
    }
    if (status === "failed") {
      const wav = encodeURIComponent(record.wav || "");
      return `
        <div class="recording-meeting-summary failed">
          <strong>会议总结生成失败</strong>
          <p>${esc(summary.message || "外部总结接口不可用")}</p>
          ${record.wav ? `<button type="button" class="meeting-summary-retry" onclick="App.retryMeetingSummary('${wav}')">重新生成总结</button>` : ""}
        </div>
      `;
    }

    return `
      <div class="recording-meeting-summary ready">
        <strong>会议总结</strong>
        ${summary.summary ? `<p>${esc(String(summary.summary))}</p>` : ""}
        ${renderItems("关键结论", summary.decisions)}
        ${renderItems("行动项", summary.actionItems)}
        ${renderItems("风险与待确认", summary.risks)}
      </div>
    `;
  },

  renderRecordingDetail(record, index) {
    // 新格式提供可展开逐句视图；旧格式不显示展开入口。
    const utterances = Array.isArray(record.utterances) ? record.utterances : [];
    if (!utterances.length || utterances.length <= 1) {
      return "";
    }
    const detailId = `recording-detail-${index}`;
    const detailItems = utterances
      .map((u) => {
        const rawSpeakerLabel = u.speakerLabel || "说话人";
        const speakerLabel = esc(rawSpeakerLabel);
        const speakerId = u.speakerRawId || u.speakerClusterId || "";
        const wav = record.wav || "";
        const sentenceText = esc(u.text || "");
        const encodedWav = encodeURIComponent(wav);
        const encodedSpeakerId = encodeURIComponent(speakerId);
        const encodedLabel = encodeURIComponent(rawSpeakerLabel);
        const labelButton = wav && this.canManualLabelSpeaker(u)
          ? `<button type="button" class="speaker-label-btn" data-wav="${encodedWav}" data-speaker-id="${encodedSpeakerId}" data-current-label="${encodedLabel}" onclick="event.preventDefault();event.stopPropagation();window.App.labelRecordingSpeaker('${encodedWav}', '${encodedSpeakerId}', '${encodedLabel}')">标注</button>`
          : "";
        return `<div class="recording-utterance-line"><strong>${speakerLabel}：</strong>${labelButton}${sentenceText}</div>`;
      })
      .join("");
    return `
      <button class="recording-toggle-btn" onclick="App.toggleRecordingDetail('${detailId}', this)">展开逐句</button>
      <div class="recording-utterances collapsed" id="${detailId}">${detailItems}</div>
    `;
  },

  canManualLabelSpeaker(utterance) {
    const label = String(utterance?.speakerLabel || "");
    const speakerId = utterance?.speakerRawId || utterance?.speakerClusterId || "";
    // 只有匿名说话人需要人工标注；已识别出真实姓名或已人工标注的句子不再显示按钮。
    return Boolean(speakerId) && /^说话人\d+$/.test(label);
  },

  async labelRecordingSpeaker(encodedWav, encodedSpeakerId, encodedCurrentLabel) {
    const wav = decodeURIComponent(encodedWav || "");
    const speakerId = decodeURIComponent(encodedSpeakerId || "");
    const currentLabel = decodeURIComponent(encodedCurrentLabel || "");
    this.pendingRecordingSpeakerLabel = { wav, speakerId, currentLabel };
    this.openModal(
      "标注说话人",
      `
      <div class="form-group">
        <label>当前说话人</label>
        <input type="text" value="${esc(currentLabel || speakerId)}" disabled />
      </div>
      <div class="form-group">
        <label>标注姓名</label>
        <input type="text" id="recordingSpeakerLabelName" placeholder="请输入姓名，例如：张三" autofocus />
      </div>
      `,
      `
      <button class="btn" onclick="App.closeModal()">取消</button>
      <button class="btn btn-primary" onclick="App.submitRecordingSpeakerLabel()">保存标注</button>
      `
    );
    setTimeout(() => document.getElementById("recordingSpeakerLabelName")?.focus(), 0);
  },

  async submitRecordingSpeakerLabel() {
    const pending = this.pendingRecordingSpeakerLabel;
    if (!pending) return toast("未找到待标注的说话人", "error");
    const name = document.getElementById("recordingSpeakerLabelName")?.value || "";
    const trimmed = name.trim();
    if (!trimmed) return toast("请输入说话人姓名", "error");

    const result = await api(`/api/recordings/${encodeURIComponent(pending.wav)}/speakers`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ speakerId: pending.speakerId, name: trimmed }),
    });
    if (!result?.success) {
      return toast(result?.message || "标注说话人失败", "error");
    }
    this.pendingRecordingSpeakerLabel = null;
    this.closeModal();
    toast("说话人已标注", "success");
    this.loadRecordings();
  },

  async retryMeetingSummary(encodedWav) {
    const wav = decodeURIComponent(encodedWav || "");
    if (!wav) return toast("未找到录音文件", "error");
    try {
      const result = await api(`/api/recordings/${encodeURIComponent(wav)}/meeting-summary/retry`, {
        method: "POST",
      });
      if (!result?.success) {
        toast(result?.message || "会议总结生成失败", "error");
      } else {
        toast("会议总结已生成", "success");
      }
    } catch (error) {
      toast(`会议总结生成失败：${error.message}`, "error");
    } finally {
      this.loadRecordings();
    }
  },

  toggleRecordingDetail(detailId, button) {
    const detail = document.getElementById(detailId);
    if (!detail || !button) return;
    const willExpand = detail.classList.contains("collapsed");
    detail.classList.toggle("collapsed", !willExpand);
    button.textContent = willExpand ? "收起逐句" : "展开逐句";
  },

  /* ──── 人物声纹 ──── */
  async loadSpeakers() {
    const response = await api("/api/speakers");
    const list = Array.isArray(response?.data) ? response.data : [];
    const meta = response?.meta || {};
    const el = document.getElementById("speakerList");
    const empty = document.getElementById("speakerEmpty");
    const banner = document.getElementById("speakerStatusBanner");

    // 先展示配置状态，便于区分“本地未配”与“远端服务未就绪”。
    banner.className = "speaker-status-banner show";
    if (meta.voiceprintConfigReady) {
      banner.textContent =
        "声纹接口配置已读取。本地 UI 已可管理人物和 feature_id；若实时认人仍失败，请继续检查讯飞大模型服务开通状态与 accessKeyId 是否有效。";
    } else {
      banner.className = "speaker-status-banner show warning";
      banner.textContent =
        "当前未检测到完整的讯飞声纹配置，人物可以先创建，但注册/更新/删除远端声纹会失败。";
    }

    if (!list.length) {
      el.innerHTML = "";
      empty.style.display = "block";
      return;
    }

    empty.style.display = "none";
    el.innerHTML = list
      .map((speaker) => {
        const name = esc(speaker.name || "未命名人物");
        const role = esc(speaker.role || "未设置角色");
        const featureId = esc(speaker.featureId || "");
        const createdAt = formatTime(speaker.createdAt);
        const updatedAt = formatTime(speaker.updatedAt);
        const initials = esc((speaker.name || "人").slice(0, 1).toUpperCase());
        return `
        <div class="speaker-card">
          <div class="speaker-card-header">
            <div class="speaker-card-title">
              <div class="speaker-avatar">${initials}</div>
              <div class="speaker-name-wrap">
                <div class="speaker-name">${name}</div>
                <div class="speaker-role">${role}</div>
              </div>
            </div>
            <div class="speaker-actions">
              <button class="btn btn-sm" onclick="App.editSpeaker('${speaker.id}')">编辑</button>
              <button class="btn btn-sm btn-danger" onclick="App.deleteSpeaker('${speaker.id}')">删除人物</button>
            </div>
          </div>
          <div class="speaker-badges">
            <span class="speaker-badge ${speaker.featureId ? "active" : "missing"}">
              ${speaker.featureId ? "已注册声纹" : "未注册声纹"}
            </span>
            <span class="speaker-badge feature">${featureId ? `feature_id: ${featureId}` : "等待注册 feature_id"}</span>
          </div>
          <div class="speaker-meta">
            <div>状态：<code>${esc(speaker.status || "active")}</code></div>
            <div>创建时间：${esc(createdAt)}</div>
            <div>最近更新：${esc(updatedAt)}</div>
          </div>
          <div class="speaker-actions">
            <button class="btn btn-primary" onclick="App.showVoiceprintUpload('${speaker.id}', '${speaker.featureId ? "update-voiceprint" : "enroll"}')">
              ${speaker.featureId ? "更新声纹样本" : "注册声纹样本"}
            </button>
            ${speaker.featureId ? `<button class="btn btn-danger" onclick="App.deleteVoiceprint('${speaker.id}')">删除远端声纹</button>` : ""}
          </div>
        </div>`;
      })
      .join("");
  },

  async editSpeaker(id) {
    let speaker = null;
    if (id) {
      const response = await api("/api/speakers");
      const list = Array.isArray(response?.data) ? response.data : [];
      speaker = list.find((item) => item.id === id) || null;
    }

    this.openModal(
      id ? "编辑人物" : "新增人物",
      `
      <div class="form-group">
        <label>人物名称</label>
        <input type="text" id="speakerName" value="${esc(speaker?.name || "")}" placeholder="例如：张三" />
      </div>
      <div class="form-group">
        <label>角色</label>
        <input type="text" id="speakerRole" value="${esc(speaker?.role || "")}" placeholder="例如：客户经理 / 主持人 / 访谈嘉宾" />
      </div>
      <div class="form-group">
        <label>状态</label>
        <select id="speakerStatus">
          <option value="active" ${(speaker?.status || "active") === "active" ? "selected" : ""}>active</option>
          <option value="disabled" ${speaker?.status === "disabled" ? "selected" : ""}>disabled</option>
        </select>
      </div>
      `,
      `
      <button class="btn" onclick="App.closeModal()">取消</button>
      <button class="btn btn-primary" onclick="App.saveSpeaker('${id || ""}')">保存</button>
      `
    );
  },

  async saveSpeaker(id) {
    const name = document.getElementById("speakerName").value.trim();
    const role = document.getElementById("speakerRole").value.trim();
    const status = document.getElementById("speakerStatus").value;
    if (!name) return toast("请输入人物名称", "error");

    const payload = { name, role, status };
    if (id) {
      await api(`/api/speakers/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } else {
      await api("/api/speakers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }

    this.closeModal();
    toast("人物已保存", "success");
    this.loadSpeakers();
  },

  showVoiceprintUpload(speakerId, action) {
    const isUpdate = action === "update-voiceprint";
    this.openModal(
      isUpdate ? "更新声纹样本" : "注册声纹样本",
      `
      <div class="form-group">
        <label>上传音频样本</label>
        <input type="file" id="speakerVoiceFile" accept=".wav,.pcm,.ogg,.speex,audio/*" />
      </div>
      <div class="form-group">
        <label>说明</label>
        <div style="font-size:13px;color:var(--text-secondary);line-height:1.7">
          建议上传 10 秒到 1 分钟的单人音频，尽量避免背景音和多人重叠说话。
        </div>
      </div>
      `,
      `
      <button class="btn" onclick="App.closeModal()">取消</button>
      <button class="btn btn-primary" onclick="App.submitVoiceprintUpload('${speakerId}', '${action}')">${isUpdate ? "更新样本" : "开始注册"}</button>
      `
    );
  },

  async submitVoiceprintUpload(speakerId, action) {
    const input = document.getElementById("speakerVoiceFile");
    const file = input?.files?.[0];
    if (!file) return toast("请选择音频样本文件", "error");

    const formData = new FormData();
    formData.append("audio", file);
    const endpoint = action === "update-voiceprint"
      ? `/api/speakers/${speakerId}/update-voiceprint`
      : `/api/speakers/${speakerId}/enroll`;
    const result = await fetch(endpoint, {
      method: "POST",
      body: formData,
    }).then((res) => res.json());

    if (!result?.success) {
      return toast(result?.message || "声纹操作失败", "error");
    }

    this.closeModal();
    toast(action === "update-voiceprint" ? "声纹样本已更新" : "声纹注册成功", "success");
    this.loadSpeakers();
  },

  async deleteVoiceprint(id) {
    if (!confirm("确定删除该人物绑定的远端声纹吗？")) return;
    const result = await api(`/api/speakers/${id}/voiceprint`, { method: "DELETE" });
    if (!result?.success) {
      return toast(result?.message || "删除声纹失败", "error");
    }
    toast("远端声纹已删除", "success");
    this.loadSpeakers();
  },

  async deleteSpeaker(id) {
    if (!confirm("确定删除该人物吗？如果已注册远端声纹，也会尝试一并删除。")) return;
    const result = await api(`/api/speakers/${id}`, { method: "DELETE" });
    if (!result?.success) {
      return toast(result?.message || "删除人物失败", "error");
    }
    toast("人物已删除", "success");
    this.loadSpeakers();
  },

  /* ──── 截图 ──── */
  async loadScreenshots() {
    const list = await api("/api/screenshots");
    const grid = document.getElementById("screenshotGrid");
    const empty = document.getElementById("screenshotEmpty");
    if (!list.length) {
      grid.innerHTML = "";
      empty.style.display = "block";
      return;
    }
    empty.style.display = "none";
    grid.innerHTML = list
      .map(
        (s) => `
      <div class="screenshot-card">
        <img src="/data/screenshots/${s.filename}" loading="lazy" onclick="App.openLightbox('/data/screenshots/${s.filename}')" />
        <div class="info">
          <span>${formatTime(s.createdAt)}</span>
          <button class="btn btn-sm btn-danger" onclick="event.stopPropagation();App.deleteScreenshot('${s.id}')">删除</button>
        </div>
      </div>`
      )
      .join("");
  },

  async deleteScreenshot(id) {
    if (!confirm("确定删除此截图？")) return;
    await api(`/api/screenshots/${id}`, { method: "DELETE" });
    toast("截图已删除", "success");
    this.loadScreenshots();
  },

  openLightbox(src) {
    document.getElementById("lightboxImg").src = src;
    document.getElementById("lightbox").classList.add("show");
  },

  closeLightbox() {
    document.getElementById("lightbox").classList.remove("show");
  },

  /* ──── 笔记 ──── */
  async loadNotes() {
    const list = await api("/api/notes");
    const el = document.getElementById("noteList");
    const empty = document.getElementById("noteEmpty");
    if (!list.length) {
      el.innerHTML = "";
      empty.style.display = "block";
      return;
    }
    empty.style.display = "none";
    el.innerHTML = list
      .map(
        (n) => `
      <div class="note-card" onclick="App.editNote('${n.id}')">
        <div class="note-title">${esc(n.title || "无标题笔记")}</div>
        <div class="note-preview">${esc(n.content || "").slice(0, 100)}</div>
        <div class="note-time">${formatTime(n.createdAt)}</div>
      </div>`
      )
      .join("");
  },

  async editNote(id) {
    let note;
    if (id) {
      const notes = await api("/api/notes");
      note = notes.find((n) => n.id === id);
    }
    this.openModal(id ? "编辑笔记" : "新建笔记", `
      <div class="form-group">
        <label>标题</label>
        <input type="text" id="noteTitle" value="${esc(note?.title || "")}" placeholder="笔记标题（可选）" />
      </div>
      <div class="form-group">
        <label>内容</label>
        <textarea id="noteContent" rows="6" placeholder="输入笔记内容...">${esc(note?.content || "")}</textarea>
      </div>
    `, `
      ${id ? `<button class="btn btn-danger" onclick="App.deleteNote('${id}')">删除</button>` : ""}
      <button class="btn" onclick="App.closeModal()">取消</button>
      <button class="btn btn-primary" onclick="App.saveNote('${id || ""}')">保存</button>
    `);
  },

  async saveNote(id) {
    const title = document.getElementById("noteTitle").value.trim();
    const content = document.getElementById("noteContent").value.trim();
    if (!content && !title) return toast("请输入笔记内容", "error");
    if (id) {
      await api(`/api/notes/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, content }),
      });
    } else {
      await api("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, content }),
      });
    }
    this.closeModal();
    toast("笔记已保存", "success");
    this.loadNotes();
  },

  async deleteNote(id) {
    if (!confirm("确定删除此笔记？")) return;
    await api(`/api/notes/${id}`, { method: "DELETE" });
    this.closeModal();
    toast("笔记已删除", "success");
    this.loadNotes();
  },

  /* ──── 任务 ──── */
  async loadTasks() {
    const list = await api("/api/tasks");
    const el = document.getElementById("taskList");
    const empty = document.getElementById("taskEmpty");
    const filtered =
      this.taskFilter === "all"
        ? list
        : list.filter((t) => t.status === this.taskFilter);
    if (!filtered.length) {
      el.innerHTML = "";
      empty.style.display = list.length ? "none" : "block";
      if (list.length && !filtered.length)
        el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-secondary)">该分类下暂无任务</div>';
      return;
    }
    empty.style.display = "none";
    el.innerHTML = filtered
      .map(
        (t) => `
      <div class="task-item ${t.status}">
        <button class="task-check ${t.status === "done" ? "done" : ""}" onclick="App.toggleTask('${t.id}')"></button>
        <div class="task-info">
          <div class="task-title">${esc(t.title)}</div>
          <div class="task-meta">
            ${t.status === "done" ? "已完成 " + formatTime(t.completedAt) : formatTime(t.createdAt)}
          </div>
        </div>
        <div class="priority-dot ${t.priority}"></div>
        <div class="task-actions">
          <button class="btn btn-sm" onclick="App.editTask('${t.id}')">编辑</button>
          <button class="btn btn-sm btn-danger" onclick="App.deleteTask('${t.id}')">删除</button>
        </div>
      </div>`
      )
      .join("");
  },

  async toggleTask(id) {
    const tasks = await api("/api/tasks");
    const t = tasks.find((t) => t.id === id);
    if (!t) return;
    const newStatus = t.status === "done" ? "pending" : "done";
    await api(`/api/tasks/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: newStatus }),
    });
    toast(newStatus === "done" ? "任务已完成" : "任务已恢复", "success");
    if (this.currentPage === "home") this.loadHome();
    else this.loadTasks();
  },

  async editTask(id) {
    let task;
    if (id) {
      const tasks = await api("/api/tasks");
      task = tasks.find((t) => t.id === id);
    }
    this.openModal(id ? "编辑任务" : "新建任务", `
      <div class="form-group">
        <label>任务名称</label>
        <input type="text" id="taskTitle" value="${esc(task?.title || "")}" placeholder="输入任务名称" />
      </div>
      <div class="form-group">
        <label>描述</label>
        <textarea id="taskDesc" rows="3" placeholder="任务描述（可选）">${esc(task?.description || "")}</textarea>
      </div>
      <div class="form-group">
        <label>优先级</label>
        <select id="taskPriority">
          <option value="low" ${task?.priority === "low" ? "selected" : ""}>低</option>
          <option value="medium" ${!task || task?.priority === "medium" ? "selected" : ""}>中</option>
          <option value="high" ${task?.priority === "high" ? "selected" : ""}>高</option>
        </select>
      </div>
    `, `
      <button class="btn" onclick="App.closeModal()">取消</button>
      <button class="btn btn-primary" onclick="App.saveTask('${id || ""}')">保存</button>
    `);
  },

  async saveTask(id) {
    const title = document.getElementById("taskTitle").value.trim();
    if (!title) return toast("请输入任务名称", "error");
    const data = {
      title,
      description: document.getElementById("taskDesc").value.trim(),
      priority: document.getElementById("taskPriority").value,
    };
    if (id) {
      await api(`/api/tasks/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
    } else {
      await api("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
    }
    this.closeModal();
    toast("任务已保存", "success");
    this.loadTasks();
  },

  async deleteTask(id) {
    if (!confirm("确定删除此任务？")) return;
    await api(`/api/tasks/${id}`, { method: "DELETE" });
    toast("任务已删除", "success");
    this.loadTasks();
  },

  /* ──── 闹钟 ──── */
  async loadAlarms() {
    const list = await api("/api/alarms");
    const el = document.getElementById("alarmList");
    const empty = document.getElementById("alarmEmpty");
    if (!list.length) {
      el.innerHTML = "";
      empty.style.display = "block";
      return;
    }
    empty.style.display = "none";
    el.innerHTML = list
      .map((a) => {
        const iconClass = a.triggered
          ? "triggered"
          : a.type === "pomodoro"
          ? "pomodoro"
          : "pending";
        const bellSvg =
          a.type === "pomodoro"
            ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>'
            : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>';
        return `
        <div class="alarm-item">
          <div class="alarm-icon ${iconClass}">${bellSvg}</div>
          <div class="alarm-info">
            <div class="alarm-title">${esc(a.title)}</div>
            <div class="alarm-meta">${a.minutes}分钟 | ${formatTime(a.time)}</div>
          </div>
          <span class="alarm-status ${a.triggered ? "triggered" : "pending"}">${a.triggered ? "已触发" : "等待中"}</span>
          <button class="btn btn-sm btn-danger" onclick="App.deleteAlarm('${a.id}')">删除</button>
        </div>`;
      })
      .join("");
  },

  showNewAlarm() {
    this.openModal("新建提醒", `
      <div class="form-group">
        <label>提醒内容</label>
        <input type="text" id="alarmTitle" placeholder="提醒做什么..." />
      </div>
      <div class="form-group">
        <label>倒计时（分钟）</label>
        <input type="number" id="alarmMinutes" value="5" min="1" max="1440" />
      </div>
      <div class="form-group">
        <label>类型</label>
        <select id="alarmType">
          <option value="alarm">普通闹钟</option>
          <option value="pomodoro">番茄钟</option>
        </select>
      </div>
    `, `
      <button class="btn" onclick="App.closeModal()">取消</button>
      <button class="btn btn-primary" onclick="App.saveAlarm()">创建</button>
    `);
  },

  async saveAlarm() {
    const title = document.getElementById("alarmTitle").value.trim() || "定时提醒";
    const minutes = parseInt(document.getElementById("alarmMinutes").value) || 5;
    const type = document.getElementById("alarmType").value;
    await api("/api/alarms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, minutes, type }),
    });
    this.closeModal();
    toast(`${type === "pomodoro" ? "番茄钟" : "闹钟"}已设置（${minutes}分钟）`, "success");
    this.loadAlarms();
  },

  async deleteAlarm(id) {
    await api(`/api/alarms/${id}`, { method: "DELETE" });
    toast("闹钟已删除", "success");
    this.loadAlarms();
  },

  /* ──── 计算器 ──── */
  bindCalc() {
    document.querySelectorAll(".calc-btn").forEach((btn) => {
      btn.addEventListener("click", () => this.calcInput(btn.dataset.val));
    });
  },

  calcInput(val) {
    if (val === "C") {
      this.calcExpr = "";
      document.getElementById("calcDisplay").textContent = "0";
      return;
    }
    if (val === "=") {
      this.calcSubmit();
      return;
    }
    this.calcExpr += val;
    document.getElementById("calcDisplay").textContent = this.calcExpr;
  },

  async calcSubmit() {
    if (!this.calcExpr) return;
    try {
      const res = await api("/api/calculate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expression: this.calcExpr }),
      });
      if (res.success) {
        document.getElementById("calcDisplay").textContent = res.data.result;
        this.calcExpr = res.data.result;
        this.loadCalcHistory();
      } else {
        document.getElementById("calcDisplay").textContent = "错误";
        this.calcExpr = "";
      }
    } catch {
      document.getElementById("calcDisplay").textContent = "错误";
      this.calcExpr = "";
    }
  },

  async loadCalcHistory() {
    const list = await api("/api/calculator/history");
    const el = document.getElementById("calcHistory");
    if (!list.length) {
      el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-secondary);font-size:14px">暂无计算历史</div>';
      return;
    }
    el.innerHTML = list
      .slice(0, 20)
      .map(
        (h) => `
      <div class="calc-history-item">
        <div class="expr">${esc(h.expression)}</div>
        <div class="result">= ${esc(h.result)}</div>
      </div>`
      )
      .join("");
  },

  /* ──── 文档评审 ──── */
  async loadDocs(forceReload = false) {
    const result = await api("/api/docs/tree");
    if (!result?.success) {
      toast(result?.message || "读取文档目录失败", "error");
      return;
    }

    this.docReview.sources = result.data?.sources || [];
    if (!this.docReview.currentSourceId && this.docReview.sources.length) {
      this.docReview.currentSourceId = this.docReview.sources[0].id;
    }

    this.renderDocSourceSelect();
    this.renderDocTree();

    // 刷新目录后保留当前文档，方便 Trio 重新生成后快速查看新版本。
    if (forceReload && this.docReview.currentPath) {
      await this.openDoc(this.docReview.currentSourceId, this.docReview.currentPath);
    }
  },

  renderDocSourceSelect() {
    const select = document.getElementById("docSourceSelect");
    if (!select) return;
    select.innerHTML = this.docReview.sources
      .map((source) => `<option value="${attr(source.id)}">${esc(source.name)}</option>`)
      .join("");
    select.value = this.docReview.currentSourceId;
  },

  renderDocTree() {
    const tree = document.getElementById("docTree");
    const revisionEl = document.getElementById("docSourceRevision");
    const source = this.docReview.sources.find((item) => item.id === this.docReview.currentSourceId);
    if (!tree || !source) {
      if (tree) tree.innerHTML = '<div class="empty-state"><p>未找到文档源</p></div>';
      if (revisionEl) revisionEl.textContent = "未找到目录版本";
      return;
    }
    if (revisionEl) {
      const revision = source.revision;
      const changed = revision?.changed || {};
      const changedCount =
        (changed.added || []).length + (changed.modified || []).length + (changed.removed || []).length;
      revisionEl.textContent = revision
        ? `目录版本 v${revision.revisionNumber} · ${source.docs.length} 篇 · 本次变化 ${changedCount} 项`
        : "尚未生成目录版本";
    }

    // 目录树按真实路径分组，避免一百多个 Trio 文档挤成单层列表。
    const root = { dirs: {}, files: [] };
    source.docs.forEach((doc) => {
      const parts = doc.path.split("/");
      let node = root;
      parts.forEach((part, index) => {
        if (index === parts.length - 1) {
          node.files.push(doc);
          return;
        }
        node.dirs[part] = node.dirs[part] || { dirs: {}, files: [] };
        node = node.dirs[part];
      });
    });

    const renderNode = (node, depth = 0) => {
      const dirs = Object.keys(node.dirs)
        .sort((a, b) => a.localeCompare(b, "zh-CN"))
        .map(
          (name) => `
          <details class="doc-tree-dir" ${depth < 2 ? "open" : ""}>
            <summary>${esc(name)}</summary>
            ${renderNode(node.dirs[name], depth + 1)}
          </details>`
        )
        .join("");
      const files = node.files
        .sort((a, b) => a.path.localeCompare(b.path, "zh-CN"))
        .map((doc) => {
          const active =
            source.id === this.docReview.currentSourceId && doc.path === this.docReview.currentPath
              ? "active"
              : "";
          const badge = doc.openComments
            ? `<span class="doc-tree-badge">${doc.openComments}</span>`
            : "";
          return `
            <button class="doc-tree-file ${active}" data-source-id="${attr(source.id)}" data-path="${attr(doc.path)}">
              <span>${esc(doc.title || doc.path)}</span>
              ${badge}
            </button>`;
        })
        .join("");
      return dirs + files;
    };

    tree.innerHTML = renderNode(root) || '<div class="empty-state"><p>暂无 Markdown 文档</p></div>';
  },

  async openDoc(sourceId, docPath, versionId = "") {
    const params = new URLSearchParams({ sourceId, path: docPath });
    if (versionId) params.set("versionId", versionId);
    const result = await api(`/api/docs/file?${params.toString()}`);
    if (!result?.success) {
      toast(result?.message || "读取文档失败", "error");
      return;
    }

    const doc = result.data;
    this.docReview.currentSourceId = doc.source.id;
    this.docReview.currentPath = doc.path;
    this.docReview.currentVersionId = doc.version.id;
    this.docReview.currentVersion = doc.version;
    this.docReview.currentContentHash = doc.version.contentHash;
    this.docReview.reviewStatus = doc.reviewStatus || null;
    this.docReview.anchors = doc.anchors || [];
    this.docReview.comments = doc.comments || [];
    this.docReview.diffMode = false;
    this.docReview.diffData = null;

    document.getElementById("docTitle").textContent = doc.title;
    document.getElementById("docPathHint").textContent = `${doc.source.name} / ${doc.path}`;
    this.renderDocSourceSelect();
    this.renderDocTree();
    this.renderDocVersionTools(doc.versions || []);
    this.renderDocVersionBanner(doc.versions || []);
    this.renderDocReviewStatusBar();
    this.renderDocDiffPanel();
    this.renderDocMarkdown();
    this.renderDocComments();
  },

  renderDocVersionTools(versions) {
    const select = document.getElementById("docVersionSelect");
    if (!select) return;
    if (!versions.length) {
      select.innerHTML = '<option value="">暂无版本</option>';
      return;
    }

    select.innerHTML = versions
      .map((version) => {
        const label = `v${version.versionNumber} · ${formatTime(version.lastSeenAt)} · ${version.contentHash.slice(0, 8)}`;
        return `<option value="${attr(version.id)}">${esc(label)}</option>`;
      })
      .join("");
    select.value = this.docReview.currentVersionId;
  },

  renderDocVersionBanner(versions) {
    const banner = document.getElementById("docVersionBanner");
    const current = this.docReview.currentVersion;
    if (!banner || !current) return;

    const latest = versions[0];
    const isLatest = latest?.id === current.id;
    banner.className = `doc-version-banner ${isLatest ? "current" : "history"}`;
    banner.textContent = isLatest
      ? `当前文档快照 v${current.versionNumber}，内容 hash ${current.contentHash.slice(0, 12)}。后续重新生成文档时会自动形成新版本。`
      : `正在查看历史快照 v${current.versionNumber}，评论仍保留原始锚点，可用于和当前版本追溯对比。`;
  },

  getReviewStatusOptions() {
    return {
      not_started: "未开始",
      in_review: "评审中",
      has_issues: "有问题",
      approved: "已通过",
      waiting_regeneration: "等待重新生成",
      needs_recheck: "重新生成后待复核",
    };
  },

  renderDocReviewStatusBar() {
    const bar = document.getElementById("docReviewStatusBar");
    if (!bar) return;
    const status = this.docReview.reviewStatus || { status: "not_started", note: "" };
    const options = this.getReviewStatusOptions();
    const optionHtml = Object.entries(options)
      .map(([value, label]) => `<option value="${value}" ${status.status === value ? "selected" : ""}>${label}</option>`)
      .join("");
    bar.innerHTML = `
      <div class="doc-review-status-main">
        <span class="review-status-badge ${status.status || "not_started"}">${esc(options[status.status] || "未开始")}</span>
        <select id="docReviewStatusSelect">${optionHtml}</select>
        <input type="text" id="docReviewStatusNote" value="${esc(status.note || "")}" placeholder="评审备注，可填写阻塞点或复核说明" />
        <button class="btn btn-sm btn-primary" onclick="App.saveCurrentDocReviewStatus()">更新状态</button>
      </div>
    `;
  },

  async saveCurrentDocReviewStatus() {
    if (!this.docReview.currentPath) return toast("请先选择文档", "info");
    const status = document.getElementById("docReviewStatusSelect")?.value || "not_started";
    const note = document.getElementById("docReviewStatusNote")?.value || "";
    const result = await api("/api/docs/review-status", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceId: this.docReview.currentSourceId,
        path: this.docReview.currentPath,
        status,
        note,
        versionId: this.docReview.currentVersionId,
        contentHash: this.docReview.currentContentHash,
      }),
    });
    if (!result?.success) return toast(result?.message || "更新评审状态失败", "error");
    this.docReview.reviewStatus = result.data;
    this.renderDocReviewStatusBar();
    toast("评审状态已更新", "success");
  },

  async compareDocVersion() {
    if (!this.docReview.currentPath) return toast("请先选择文档", "info");
    const params = new URLSearchParams({
      sourceId: this.docReview.currentSourceId,
      path: this.docReview.currentPath,
      currentVersionId: this.docReview.currentVersionId,
    });
    const result = await api(`/api/docs/compare?${params.toString()}`);
    if (!result?.success) return toast(result?.message || "版本对比失败", "error");

    this.docReview.diffMode = true;
    this.docReview.diffData = result.data;
    this.renderDocDiffPanel();
    this.renderDocMarkdown();
    toast("已进入版本对比视图", "success");
  },

  closeDocDiff() {
    this.docReview.diffMode = false;
    this.docReview.diffData = null;
    this.renderDocDiffPanel();
    this.renderDocMarkdown();
  },

  renderDocDiffPanel() {
    const panel = document.getElementById("docDiffPanel");
    if (!panel) return;
    if (!this.docReview.diffMode || !this.docReview.diffData) {
      panel.innerHTML = "";
      panel.classList.remove("show");
      return;
    }

    const diff = this.docReview.diffData;
    const summary = diff.summary || {};
    const baseLabel = diff.baseVersion
      ? `v${diff.baseVersion.versionNumber} ${diff.baseVersion.contentHash.slice(0, 8)}`
      : "无基准版本";
    const currentLabel = diff.currentVersion
      ? `v${diff.currentVersion.versionNumber} ${diff.currentVersion.contentHash.slice(0, 8)}`
      : "当前版本";
    panel.classList.add("show");
    panel.innerHTML = `
      <div class="doc-diff-title">
        <strong>版本对比</strong>
        <span>${esc(baseLabel)} → ${esc(currentLabel)}</span>
        <button class="btn btn-sm" onclick="App.closeDocDiff()">退出对比</button>
      </div>
      <div class="doc-diff-stats">
        <span class="added">新增 ${summary.added || 0}</span>
        <span class="modified">修改 ${summary.modified || 0}</span>
        <span class="removed">删除 ${summary.removed || 0}</span>
        <span>未变 ${summary.unchanged || 0}</span>
      </div>
    `;
  },

  renderDocMarkdown() {
    const viewer = document.getElementById("docViewer");
    if (!viewer) return;

    if (this.docReview.diffMode && this.docReview.diffData) {
      viewer.innerHTML = this.renderDocDiffItems(this.docReview.diffData.items || []);
      return;
    }

    // 服务端已按 Markdown 结构提取锚点，前端只负责渲染和挂评论按钮。
    viewer.innerHTML = this.docReview.anchors
      .map((anchorItem) => this.renderDocBlock(anchorItem))
      .join("");
  },

  renderDocDiffItems(items) {
    if (!items.length) {
      return '<div class="empty-state"><p>暂无可对比内容</p></div>';
    }

    return items
      .filter((item) => item.type !== "unchanged")
      .map((item) => {
        if (item.type === "added") {
          return `
            <section class="doc-diff-item added">
              <div class="doc-diff-label">新增</div>
              ${this.renderDocAnchorBody(item.current)}
            </section>`;
        }
        if (item.type === "removed") {
          return `
            <section class="doc-diff-item removed">
              <div class="doc-diff-label">删除</div>
              ${this.renderDocAnchorBody(item.before)}
            </section>`;
        }
        return `
          <section class="doc-diff-item modified">
            <div class="doc-diff-label">修改前</div>
            <div class="doc-diff-before">${this.renderDocAnchorBody(item.before)}</div>
            <div class="doc-diff-label">修改后</div>
            <div class="doc-diff-after">${this.renderDocAnchorBody(item.after)}</div>
          </section>`;
      })
      .join("") || '<div class="empty-state"><p>本次对比没有新增、删除或修改的块</p></div>';
  },

  renderDocBlock(anchorItem) {
    const matchingComments = this.docReview.comments.filter((comment) => {
      const state = this.getCommentAnchorState(comment);
      return state.blockHash === anchorItem.blockHash && comment.status !== "resolved";
    });
    const count = matchingComments.length
      ? `<span class="doc-anchor-count">${matchingComments.length}</span>`
      : "";
    const commentButton = `
      <button class="doc-anchor-action" onclick="App.beginDocComment('${anchorItem.id}')">
        评论${count}
      </button>`;
    const wrapperStart = `
      <section class="doc-block ${matchingComments.length ? "has-comments" : ""}" id="doc-${anchorItem.blockHash}" data-block-hash="${attr(anchorItem.blockHash)}">
        ${commentButton}
    `;
    const wrapperEnd = "</section>";

    return `${wrapperStart}${this.renderDocAnchorBody(anchorItem)}${wrapperEnd}`;
  },

  renderDocAnchorBody(anchorItem) {
    if (anchorItem.type === "heading") {
      const level = Math.min(6, Math.max(1, (anchorItem.raw.match(/^#{1,6}/)?.[0] || "#").length));
      return `<h${level}>${this.renderInlineMarkdown(anchorItem.raw.replace(/^#{1,6}\s+/, ""))}</h${level}>`;
    }
    if (anchorItem.type === "code") {
      const code = anchorItem.raw.replace(/^```[^\n]*\n?/, "").replace(/\n?```$/, "");
      return `<pre><code>${esc(code)}</code></pre>`;
    }
    if (anchorItem.type === "table") {
      const rows = anchorItem.raw
        .split("\n")
        .filter((line) => !/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line))
        .map((line) =>
          line
            .replace(/^\||\|$/g, "")
            .split("|")
            .map((cell) => `<td>${this.renderInlineMarkdown(cell.trim())}</td>`)
            .join("")
        )
        .map((cells) => `<tr>${cells}</tr>`)
        .join("");
      return `<table>${rows}</table>`;
    }
    if (anchorItem.type === "list") {
      const items = anchorItem.raw
        .split("\n")
        .map((line) => line.replace(/^\s*([-*+]|\d+\.)\s+/, ""))
        .map((line) => `<li>${this.renderInlineMarkdown(line)}</li>`)
        .join("");
      return `<ul>${items}</ul>`;
    }
    return `<p>${this.renderInlineMarkdown(anchorItem.raw)}</p>`;
  },

  renderInlineMarkdown(markdown) {
    // 只实现评审阅读需要的基础 Markdown，避免引入额外依赖影响桌面包。
    return esc(markdown)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  },

  getCommentAnchorState(comment) {
    const target = comment.target || {};
    const exact = this.docReview.anchors.find((anchorItem) => anchorItem.blockHash === target.blockHash);
    if (exact) return { type: "current", blockHash: exact.blockHash, label: "当前定位" };

    const quote = String(target.selectedText || target.quote || "").trim();
    if (quote) {
      const remapped = this.docReview.anchors.find((anchorItem) => anchorItem.text.includes(quote));
      if (remapped) return { type: "remapped", blockHash: remapped.blockHash, label: "已重挂载" };
    }

    const isSameVersion = comment.versionId === this.docReview.currentVersionId;
    return {
      type: isSameVersion ? "lost" : "history",
      blockHash: target.blockHash || "",
      label: isSameVersion ? "位置失效" : "历史版本",
    };
  },

  renderDocComments() {
    const summary = document.getElementById("docCommentSummary");
    const list = document.getElementById("docCommentList");
    if (!summary || !list) return;

    const comments = this.docReview.showOpenOnly
      ? this.docReview.comments.filter((comment) => comment.status !== "resolved")
      : this.docReview.comments;
    const openCount = this.docReview.comments.filter((comment) => comment.status !== "resolved").length;
    const stateCounts = this.docReview.comments.reduce(
      (acc, comment) => {
        const state = this.getCommentAnchorState(comment);
        acc[state.type] = (acc[state.type] || 0) + 1;
        return acc;
      },
      { current: 0, remapped: 0, history: 0, lost: 0 }
    );
    summary.textContent = this.docReview.currentPath
      ? `共 ${this.docReview.comments.length} 条评论，${openCount} 条未解决。当前定位 ${stateCounts.current || 0}，已重挂载 ${stateCounts.remapped || 0}，历史/失效 ${(stateCounts.history || 0) + (stateCounts.lost || 0)}。`
      : "尚未选择文档";

    if (!comments.length) {
      list.innerHTML = '<div class="empty-state"><p>暂无评论</p><p class="sub">点击正文右侧的“评论”按钮添加评审意见。</p></div>';
      return;
    }

    list.innerHTML = comments
      .map((comment) => {
        const state = this.getCommentAnchorState(comment);
        const replies = (comment.replies || [])
          .map((reply) => `<div class="doc-comment-reply">${esc(reply.body)}<span>${formatTime(reply.createdAt)}</span></div>`)
          .join("");
        const statusText = comment.status === "resolved" ? "已解决" : "未解决";
        const nextStatus = comment.status === "resolved" ? "open" : "resolved";
        const nextText = comment.status === "resolved" ? "重新打开" : "解决";
        const rebindButton = state.type === "lost" || state.type === "history" || state.type === "remapped"
          ? `<button class="btn btn-sm" onclick="App.rebindDocComment('${comment.id}')">绑定到选区</button>`
          : "";
        return `
          <article class="doc-comment-card ${comment.status === "resolved" ? "resolved" : ""}">
            <div class="doc-comment-meta">
              <span class="doc-comment-state ${state.type}">${state.label}</span>
              <span>${statusText}</span>
              <span>${formatTime(comment.updatedAt || comment.createdAt)}</span>
            </div>
            <blockquote>${esc(comment.target?.selectedText || comment.target?.quote || "整段评论")}</blockquote>
            <p>${esc(comment.body)}</p>
            ${replies}
            <div class="doc-comment-actions">
              <button class="btn btn-sm" onclick="App.scrollToDocAnchor('${attr(state.blockHash)}')">定位</button>
              ${rebindButton}
              <button class="btn btn-sm" onclick="App.replyDocComment('${comment.id}')">回复</button>
              <button class="btn btn-sm" onclick="App.toggleDocCommentStatus('${comment.id}', '${nextStatus}')">${nextText}</button>
            </div>
          </article>`;
      })
      .join("");
  },

  beginDocComment(blockId) {
    const anchorItem = this.docReview.anchors.find((item) => item.id === blockId);
    if (!anchorItem) return toast("未找到评论位置", "error");

    const blockEl = document.getElementById(`doc-${anchorItem.blockHash}`);
    const selection = window.getSelection();
    const selectedText =
      selection &&
      selection.toString().trim() &&
      blockEl?.contains(selection.anchorNode) &&
      blockEl?.contains(selection.focusNode)
        ? selection.toString().trim()
        : "";
    const quote = selectedText || anchorItem.text.slice(0, 160);
    this.docReview.pendingTarget = {
      type: selectedText ? "selection" : anchorItem.type,
      blockId: anchorItem.id,
      blockHash: anchorItem.blockHash,
      headingPath: anchorItem.headingPath,
      quote,
      selectedText,
      blockText: anchorItem.text,
    };

    this.openModal(
      "添加文档评论",
      `
      <div class="form-group">
        <label>评论位置</label>
        <div class="doc-comment-quote">${esc(quote)}</div>
      </div>
      <div class="form-group">
        <label>评论内容</label>
        <textarea id="docCommentBody" rows="5" placeholder="请输入评审意见，例如：这里是否需要补充边界条件？"></textarea>
      </div>
      `,
      `
      <button class="btn" onclick="App.closeModal()">取消</button>
      <button class="btn btn-primary" onclick="App.saveDocComment()">保存评论</button>
      `
    );
    setTimeout(() => document.getElementById("docCommentBody")?.focus(), 0);
  },

  async saveDocComment() {
    const body = document.getElementById("docCommentBody")?.value.trim();
    if (!body) return toast("请输入评论内容", "error");

    const payload = {
      sourceId: this.docReview.currentSourceId,
      path: this.docReview.currentPath,
      versionId: this.docReview.currentVersionId,
      contentHash: this.docReview.currentContentHash,
      target: this.docReview.pendingTarget,
      body,
    };
    const result = await api("/api/docs/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!result?.success) return toast(result?.message || "保存评论失败", "error");

    this.closeModal();
    toast("评论已保存", "success");
    await this.openDoc(this.docReview.currentSourceId, this.docReview.currentPath, this.docReview.currentVersionId);
  },

  getSelectedDocTarget() {
    const selection = window.getSelection();
    const selectedText = selection?.toString().trim() || "";
    if (!selectedText) return null;

    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;
    const anchorEl = anchorNode?.nodeType === Node.TEXT_NODE ? anchorNode.parentElement : anchorNode;
    const focusEl = focusNode?.nodeType === Node.TEXT_NODE ? focusNode.parentElement : focusNode;
    const blockEl = anchorEl?.closest?.(".doc-block");
    if (!blockEl || !blockEl.contains(focusEl)) return null;

    const blockHash = blockEl.dataset.blockHash || "";
    const anchorItem = this.docReview.anchors.find((item) => item.blockHash === blockHash);
    if (!anchorItem) return null;

    return {
      type: "selection",
      blockId: anchorItem.id,
      blockHash: anchorItem.blockHash,
      headingPath: anchorItem.headingPath,
      quote: selectedText,
      selectedText,
      blockText: anchorItem.text,
    };
  },

  async rebindDocComment(id) {
    if (this.docReview.diffMode) {
      return toast("请先退出版本对比，再选择正文中的新位置", "info");
    }

    const target = this.getSelectedDocTarget();
    if (!target) {
      return toast("请先在当前正文中选中要绑定的文字", "info");
    }

    const result = await api(`/api/docs/comments/${id}/rebind`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        versionId: this.docReview.currentVersionId,
        contentHash: this.docReview.currentContentHash,
        target,
      }),
    });
    if (!result?.success) return toast(result?.message || "重新绑定评论失败", "error");

    toast("评论已绑定到当前选区", "success");
    await this.openDoc(this.docReview.currentSourceId, this.docReview.currentPath, this.docReview.currentVersionId);
  },

  replyDocComment(id, origin = "docs") {
    this.openModal(
      "回复评论",
      `
      <div class="form-group">
        <label>回复内容</label>
        <textarea id="docReplyBody" rows="4" placeholder="请输入回复"></textarea>
      </div>
      `,
      `
      <button class="btn" onclick="App.closeModal()">取消</button>
      <button class="btn btn-primary" onclick="App.saveDocReply('${id}', '${origin}')">保存回复</button>
      `
    );
    setTimeout(() => document.getElementById("docReplyBody")?.focus(), 0);
  },

  async saveDocReply(id, origin = "docs") {
    const body = document.getElementById("docReplyBody")?.value.trim();
    if (!body) return toast("请输入回复内容", "error");
    const result = await api(`/api/docs/comments/${id}/replies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
    if (!result?.success) return toast(result?.message || "保存回复失败", "error");
    this.closeModal();
    toast("回复已保存", "success");
    if (origin === "comment-center") {
      await this.loadCommentCenter();
      return;
    }
    await this.openDoc(this.docReview.currentSourceId, this.docReview.currentPath, this.docReview.currentVersionId);
  },

  async toggleDocCommentStatus(id, status, origin = "docs") {
    const result = await api(`/api/docs/comments/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!result?.success) return toast(result?.message || "更新评论状态失败", "error");
    toast(status === "resolved" ? "评论已解决" : "评论已重新打开", "success");
    if (origin === "comment-center") {
      await this.loadCommentCenter();
      return;
    }
    await this.openDoc(this.docReview.currentSourceId, this.docReview.currentPath, this.docReview.currentVersionId);
  },

  scrollToDocAnchor(blockHash) {
    const el = document.getElementById(`doc-${blockHash}`);
    if (!el) return toast("当前版本未找到该评论位置", "info");
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("doc-block-flash");
    setTimeout(() => el.classList.remove("doc-block-flash"), 1200);
  },

  /* ──── 评论中心 ──── */
  async loadCommentCenter() {
    const params = new URLSearchParams({
      sourceId: this.commentCenter.sourceId,
      status: this.commentCenter.status,
      location: this.commentCenter.location,
      q: this.commentCenter.q,
    });
    const result = await api(`/api/docs/comment-center?${params.toString()}`);
    if (!result?.success) {
      toast(result?.message || "读取评论中心失败", "error");
      return;
    }

    this.commentCenter.comments = result.data?.comments || [];
    this.commentCenter.summary = result.data?.summary || null;
    this.renderCommentCenterFilters();
    this.renderCommentCenter();
  },

  renderCommentCenterFilters() {
    const sourceSelect = document.getElementById("commentCenterSource");
    const statusSelect = document.getElementById("commentCenterStatus");
    const locationSelect = document.getElementById("commentCenterLocation");
    const queryInput = document.getElementById("commentCenterQuery");
    const summary = this.commentCenter.summary;
    if (!sourceSelect || !summary) return;

    const sourceOptions = Object.entries(summary.sources || {})
      .map(([sourceId, sourceName]) => `<option value="${attr(sourceId)}">${esc(sourceName)}</option>`)
      .join("");
    sourceSelect.innerHTML = `<option value="all">全部文档源</option>${sourceOptions}`;
    sourceSelect.value = this.commentCenter.sourceId;
    if (statusSelect) statusSelect.value = this.commentCenter.status;
    if (locationSelect) locationSelect.value = this.commentCenter.location;
    if (queryInput && queryInput.value !== this.commentCenter.q) {
      queryInput.value = this.commentCenter.q;
    }
  },

  renderCommentCenter() {
    const summaryEl = document.getElementById("commentCenterSummary");
    const listEl = document.getElementById("commentCenterList");
    const summary = this.commentCenter.summary;
    if (!summaryEl || !listEl || !summary) return;

    const location = summary.location || {};
    const status = summary.status || {};
    summaryEl.innerHTML = `
      <span>全部 ${summary.total || 0}</span>
      <span>未解决 ${status.open || 0}</span>
      <span>已解决 ${status.resolved || 0}</span>
      <span>当前定位 ${location.current || 0}</span>
      <span>已重挂载 ${location.remapped || 0}</span>
      <span>历史/失效 ${(location.history || 0) + (location.lost || 0)}</span>
    `;

    const comments = this.commentCenter.comments;
    if (!comments.length) {
      listEl.innerHTML = '<div class="empty-state"><p>暂无匹配评论</p><p class="sub">可调整筛选条件，或先在文档评审中添加评论。</p></div>';
      return;
    }

    listEl.innerHTML = comments
      .map((comment) => this.renderCommentCenterCard(comment))
      .join("");
  },

  renderCommentCenterCard(comment) {
    const location = comment.location || { type: "lost", label: "位置失效", blockHash: "" };
    const quote = comment.target?.selectedText || comment.target?.quote || "整段评论";
    const statusText = comment.status === "resolved" ? "已解决" : "未解决";
    const nextStatus = comment.status === "resolved" ? "open" : "resolved";
    const nextText = comment.status === "resolved" ? "重新打开" : "解决";
    return `
      <article class="comment-center-item ${comment.status === "resolved" ? "resolved" : ""}">
        <div class="comment-center-item-head">
          <div>
            <h4>${esc(comment.docTitle || comment.path)}</h4>
            <p>${esc(comment.sourceName || comment.sourceId)} / ${esc(comment.path || "")}</p>
          </div>
          <span class="doc-comment-state ${location.type}">${esc(location.label || "位置失效")}</span>
        </div>
        <blockquote>${esc(quote)}</blockquote>
        <p class="comment-center-body">${esc(comment.body)}</p>
        <div class="comment-center-meta">
          <span>${statusText}</span>
          <span>回复 ${comment.replyCount || 0}</span>
          <span>${formatTime(comment.updatedAt || comment.createdAt)}</span>
          ${comment.documentExists ? "" : "<span>当前文档不存在，使用历史快照定位</span>"}
        </div>
        <div class="doc-comment-actions">
          <button class="btn btn-sm" onclick="App.openCommentFromCenter('${attr(comment.sourceId)}', '${attr(comment.path)}', '${attr(location.blockHash || "")}')">打开定位</button>
          <button class="btn btn-sm" onclick="App.replyDocCommentFromCenter('${comment.id}')">回复</button>
          <button class="btn btn-sm" onclick="App.toggleDocCommentStatusFromCenter('${comment.id}', '${nextStatus}')">${nextText}</button>
        </div>
      </article>
    `;
  },

  async openCommentFromCenter(sourceId, docPath, blockHash) {
    this.navigate("docs");
    await this.loadDocs();
    await this.openDoc(sourceId, docPath);
    if (blockHash) {
      setTimeout(() => this.scrollToDocAnchor(blockHash), 120);
    }
  },

  replyDocCommentFromCenter(id) {
    this.replyDocComment(id, "comment-center");
  },

  async toggleDocCommentStatusFromCenter(id, status) {
    await this.toggleDocCommentStatus(id, status, "comment-center");
  },

  /* ──── 文档源管理 ──── */
  async loadDocSources() {
    const result = await api("/api/docs/sources");
    if (!result?.success) {
      toast(result?.message || "读取文档源失败", "error");
      return;
    }

    this.docSources = result.data || [];
    this.renderDocSources();
  },

  renderDocSources() {
    const list = document.getElementById("docSourceManagerList");
    if (!list) return;
    if (!this.docSources.length) {
      list.innerHTML = '<div class="empty-state"><p>暂无文档源</p><p class="sub">点击右上角新增文档源，选择包含 Markdown 的 docs 目录。</p></div>';
      return;
    }

    list.innerHTML = this.docSources
      .map((source) => {
        const status = source.status || {};
        const statusClass = status.readable ? "ok" : "bad";
        const statusText = status.readable
          ? `可读取，${status.docCount || 0} 篇 Markdown`
          : status.message || "不可读取";
        return `
          <article class="doc-source-manager-item">
            <div class="doc-source-manager-main">
              <div class="doc-source-manager-title">
                <strong>${esc(source.name)}</strong>
                <code>${esc(source.id)}</code>
                <span class="doc-source-status ${statusClass}">${esc(statusText)}</span>
              </div>
              <div class="doc-source-path">${esc(source.root)}</div>
            </div>
            <div class="doc-source-manager-actions">
              <button class="btn btn-sm" onclick="App.editDocSource('${attr(source.id)}')">编辑</button>
              <button class="btn btn-sm" onclick="App.openDocSourceReview('${attr(source.id)}')">查看文档</button>
              <button class="btn btn-sm btn-danger" onclick="App.deleteDocSource('${attr(source.id)}')">删除</button>
            </div>
          </article>
        `;
      })
      .join("");
  },

  editDocSource(sourceId = "") {
    const source = this.docSources.find((item) => item.id === sourceId);
    const isEdit = Boolean(source);
    this.openModal(
      isEdit ? "编辑文档源" : "新增文档源",
      `
      <div class="form-group">
        <label>文档源 ID</label>
        <input type="text" id="docSourceId" value="${esc(source?.id || "")}" ${isEdit ? "disabled" : ""} placeholder="例如：my-project" />
      </div>
      <div class="form-group">
        <label>展示名称</label>
        <input type="text" id="docSourceName" value="${esc(source?.name || "")}" placeholder="例如：我的项目文档" />
      </div>
      <div class="form-group">
        <label>docs 目录绝对路径</label>
        <input type="text" id="docSourceRoot" value="${esc(source?.root || "")}" placeholder="/Users/xxx/work/project/docs" />
      </div>
      <div class="doc-source-modal-tip">
        ID 是评论和版本追溯的关联键，创建后不可编辑。删除文档源不会删除历史评论和快照。
      </div>
      `,
      `
      <button class="btn" onclick="App.closeModal()">取消</button>
      <button class="btn btn-primary" onclick="App.saveDocSource('${attr(source?.id || "")}')">保存</button>
      `
    );
  },

  async saveDocSource(sourceId = "") {
    const id = document.getElementById("docSourceId")?.value.trim();
    const name = document.getElementById("docSourceName")?.value.trim();
    const root = document.getElementById("docSourceRoot")?.value.trim();
    if (!sourceId && !id) return toast("请输入文档源 ID", "error");
    if (!name) return toast("请输入展示名称", "error");
    if (!root) return toast("请输入 docs 目录绝对路径", "error");

    const result = await api(sourceId ? `/api/docs/sources/${sourceId}` : "/api/docs/sources", {
      method: sourceId ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, name, root }),
    });
    if (!result?.success) return toast(result?.message || "保存文档源失败", "error");

    this.closeModal();
    toast("文档源已保存", "success");
    await this.loadDocSources();
    this.docReview.sources = [];
  },

  async deleteDocSource(sourceId) {
    if (!confirm("确定删除该文档源配置吗？历史评论和快照会保留，重新添加同 ID 后仍可追溯。")) return;
    const result = await api(`/api/docs/sources/${sourceId}`, { method: "DELETE" });
    if (!result?.success) return toast(result?.message || "删除文档源失败", "error");

    toast("文档源已删除", "success");
    await this.loadDocSources();
    if (this.docReview.currentSourceId === sourceId) {
      this.docReview.currentSourceId = "";
      this.docReview.currentPath = "";
    }
  },

  async openDocSourceReview(sourceId) {
    this.docReview.currentSourceId = sourceId;
    this.docReview.currentPath = "";
    this.navigate("docs");
    await this.loadDocs();
  },

  /* ──── 评审闭环 ──── */
  async loadReviewWorkflow() {
    const params = new URLSearchParams({
      sourceId: this.reviewWorkflow.sourceId,
      status: this.reviewWorkflow.status,
      q: this.reviewWorkflow.q,
    });
    const result = await api(`/api/docs/review-workflow?${params.toString()}`);
    if (!result?.success) {
      toast(result?.message || "读取评审闭环失败", "error");
      return;
    }

    this.reviewWorkflow.docs = result.data?.docs || [];
    this.reviewWorkflow.summary = result.data?.summary || null;
    this.reviewWorkflow.statusOptions = result.data?.statusOptions || this.getReviewStatusOptions();
    this.renderReviewWorkflowFilters();
    this.renderReviewWorkflow();
  },

  renderReviewWorkflowFilters() {
    const sourceSelect = document.getElementById("reviewWorkflowSource");
    const statusSelect = document.getElementById("reviewWorkflowStatus");
    const queryInput = document.getElementById("reviewWorkflowQuery");
    const summary = this.reviewWorkflow.summary;
    if (!sourceSelect || !statusSelect || !summary) return;

    const sourceOptions = Object.entries(summary.sources || {})
      .map(([sourceId, sourceName]) => `<option value="${attr(sourceId)}">${esc(sourceName)}</option>`)
      .join("");
    const statusOptions = Object.entries(this.reviewWorkflow.statusOptions || {})
      .map(([value, label]) => `<option value="${value}">${esc(label)}</option>`)
      .join("");
    sourceSelect.innerHTML = `<option value="all">全部文档源</option>${sourceOptions}`;
    statusSelect.innerHTML = `<option value="all">全部状态</option>${statusOptions}`;
    sourceSelect.value = this.reviewWorkflow.sourceId;
    statusSelect.value = this.reviewWorkflow.status;
    if (queryInput && queryInput.value !== this.reviewWorkflow.q) queryInput.value = this.reviewWorkflow.q;
  },

  renderReviewWorkflow() {
    const summaryEl = document.getElementById("reviewWorkflowSummary");
    const listEl = document.getElementById("reviewWorkflowList");
    const summary = this.reviewWorkflow.summary;
    if (!summaryEl || !listEl || !summary) return;

    const options = this.reviewWorkflow.statusOptions || {};
    const statusBadges = Object.entries(options)
      .map(([value, label]) => `<span>${esc(label)} ${summary.status?.[value] || 0}</span>`)
      .join("");
    summaryEl.innerHTML = `
      <span>全部 ${summary.total || 0}</span>
      <span>需关注 ${summary.attention || 0}</span>
      <span>未解决评论 ${summary.openComments || 0}</span>
      ${statusBadges}
    `;

    if (!this.reviewWorkflow.docs.length) {
      listEl.innerHTML = '<div class="empty-state"><p>暂无匹配文档</p><p class="sub">可调整筛选条件，或先刷新文档目录。</p></div>';
      return;
    }

    listEl.innerHTML = this.reviewWorkflow.docs
      .map((doc) => this.renderReviewWorkflowItem(doc))
      .join("");
  },

  renderReviewWorkflowItem(doc) {
    const status = doc.reviewStatus || { status: "not_started", statusLabel: "未开始" };
    const options = this.reviewWorkflow.statusOptions || this.getReviewStatusOptions();
    const optionHtml = Object.entries(options)
      .map(([value, label]) => `<option value="${value}" ${status.status === value ? "selected" : ""}>${esc(label)}</option>`)
      .join("");
    return `
      <article class="review-workflow-item ${doc.attention ? "needs-attention" : ""}">
        <div class="review-workflow-head">
          <div>
            <h4>${esc(doc.title || doc.path)}</h4>
            <p>${esc(doc.sourceName)} / ${esc(doc.path)}</p>
          </div>
          <span class="review-status-badge ${status.status}">${esc(status.statusLabel || options[status.status] || "未开始")}</span>
        </div>
        <div class="review-workflow-meta">
          <span>模块：${esc(doc.moduleName || "未分组")}</span>
          <span>评论：${doc.openComments || 0} / ${doc.totalComments || 0} 未解决/全部</span>
          <span>版本：${esc((doc.contentHash || "").slice(0, 8))}</span>
          ${doc.attention ? `<span class="attention">${esc(doc.attention)}</span>` : ""}
        </div>
        <div class="review-workflow-actions">
          <select data-review-status="${attr(doc.sourceId)}|${attr(doc.path)}">${optionHtml}</select>
          <input type="text" value="${esc(status.note || "")}" data-review-note="${attr(doc.sourceId)}|${attr(doc.path)}" placeholder="评审备注" />
          <button class="btn btn-sm btn-primary" onclick="App.saveWorkflowDocStatus('${attr(doc.sourceId)}', '${attr(doc.path)}', '${attr(doc.versionId)}', '${attr(doc.contentHash)}')">保存状态</button>
          <button class="btn btn-sm" onclick="App.openCommentFromCenter('${attr(doc.sourceId)}', '${attr(doc.path)}', '')">打开文档</button>
        </div>
      </article>
    `;
  },

  async saveWorkflowDocStatus(sourceId, docPath, versionId, contentHash) {
    const key = `${sourceId}|${docPath}`;
    const status = document.querySelector(`[data-review-status="${CSS.escape(key)}"]`)?.value || "not_started";
    const note = document.querySelector(`[data-review-note="${CSS.escape(key)}"]`)?.value || "";
    const result = await api("/api/docs/review-status", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId, path: docPath, status, note, versionId, contentHash }),
    });
    if (!result?.success) return toast(result?.message || "保存评审状态失败", "error");
    toast("评审状态已保存", "success");
    await this.loadReviewWorkflow();
  },

  /* ──── 按钮绑定 ──── */
  bindButtons() {
    document.addEventListener("click", (event) => {
      const button = event.target.closest(".speaker-label-btn");
      if (!button) return;

      event.preventDefault();
      event.stopPropagation();
      this.labelRecordingSpeaker(
        button.dataset.wav || "",
        button.dataset.speakerId || "",
        button.dataset.currentLabel || ""
      );
    });

    const screenshotButton = document.getElementById("btnTakeScreenshot");
    screenshotButton?.addEventListener("click", async () => {
      if (!this.runtime.screenshot) {
        toast("截图功能仅在桌面版可用", "info");
        return;
      }

      try {
        await api("/api/screenshot", { method: "POST" });
        toast("截图已保存", "success");
        this.loadScreenshots();
      } catch {
        toast("截图失败", "error");
      }
    });
    document.getElementById("btnNewSpeaker").addEventListener("click", () => this.editSpeaker(null));
    document.getElementById("btnMeetingSummary")?.addEventListener("click", () => this.openMeetingSummaryPicker());
    document.getElementById("btnNewNote").addEventListener("click", () => this.editNote(null));
    document.getElementById("btnNewTask").addEventListener("click", () => this.editTask(null));
    document.getElementById("btnNewAlarm").addEventListener("click", () => this.showNewAlarm());

    const docTree = document.getElementById("docTree");
    docTree?.addEventListener("click", (event) => {
      const item = event.target.closest(".doc-tree-file");
      if (!item) return;
      this.openDoc(item.dataset.sourceId, item.dataset.path);
    });

    const docSourceSelect = document.getElementById("docSourceSelect");
    docSourceSelect?.addEventListener("change", () => {
      this.docReview.currentSourceId = docSourceSelect.value;
      this.docReview.currentPath = "";
      this.docReview.currentVersionId = "";
      this.renderDocTree();
    });

    const docVersionSelect = document.getElementById("docVersionSelect");
    docVersionSelect?.addEventListener("change", () => {
      if (!this.docReview.currentPath) return;
      this.openDoc(this.docReview.currentSourceId, this.docReview.currentPath, docVersionSelect.value);
    });

    document.getElementById("btnReloadDocs")?.addEventListener("click", () => {
      this.loadDocs(true);
      toast("文档目录已刷新", "success");
    });

    document.getElementById("btnOpenCurrentDoc")?.addEventListener("click", () => {
      if (!this.docReview.currentPath) return;
      this.openDoc(this.docReview.currentSourceId, this.docReview.currentPath);
    });

    document.getElementById("btnCompareDocVersion")?.addEventListener("click", () => {
      this.compareDocVersion();
    });

    document.getElementById("btnShowOpenComments")?.addEventListener("click", (event) => {
      this.docReview.showOpenOnly = !this.docReview.showOpenOnly;
      event.currentTarget.textContent = this.docReview.showOpenOnly ? "查看全部" : "只看未解决";
      this.renderDocComments();
    });

    const commentCenterReload = document.getElementById("btnReloadCommentCenter");
    commentCenterReload?.addEventListener("click", () => {
      this.loadCommentCenter();
      toast("评论中心已刷新", "success");
    });

    const commentCenterSource = document.getElementById("commentCenterSource");
    commentCenterSource?.addEventListener("change", () => {
      this.commentCenter.sourceId = commentCenterSource.value;
      this.loadCommentCenter();
    });

    const commentCenterStatus = document.getElementById("commentCenterStatus");
    commentCenterStatus?.addEventListener("change", () => {
      this.commentCenter.status = commentCenterStatus.value;
      this.loadCommentCenter();
    });

    const commentCenterLocation = document.getElementById("commentCenterLocation");
    commentCenterLocation?.addEventListener("change", () => {
      this.commentCenter.location = commentCenterLocation.value;
      this.loadCommentCenter();
    });

    let commentCenterSearchTimer;
    const commentCenterQuery = document.getElementById("commentCenterQuery");
    commentCenterQuery?.addEventListener("input", () => {
      clearTimeout(commentCenterSearchTimer);
      commentCenterSearchTimer = setTimeout(() => {
        this.commentCenter.q = commentCenterQuery.value.trim();
        this.loadCommentCenter();
      }, 300);
    });

    document.getElementById("btnNewDocSource")?.addEventListener("click", () => {
      this.editDocSource("");
    });

    document.getElementById("btnReloadReviewWorkflow")?.addEventListener("click", () => {
      this.loadReviewWorkflow();
      toast("评审闭环已刷新", "success");
    });

    document.getElementById("reviewWorkflowSource")?.addEventListener("change", (event) => {
      this.reviewWorkflow.sourceId = event.target.value;
      this.loadReviewWorkflow();
    });

    document.getElementById("reviewWorkflowStatus")?.addEventListener("change", (event) => {
      this.reviewWorkflow.status = event.target.value;
      this.loadReviewWorkflow();
    });

    let reviewWorkflowSearchTimer;
    document.getElementById("reviewWorkflowQuery")?.addEventListener("input", (event) => {
      clearTimeout(reviewWorkflowSearchTimer);
      reviewWorkflowSearchTimer = setTimeout(() => {
        this.reviewWorkflow.q = event.target.value.trim();
        this.loadReviewWorkflow();
      }, 300);
    });

    document.querySelectorAll(".filter-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".filter-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        this.taskFilter = btn.dataset.filter;
        this.loadTasks();
      });
    });

    const refreshBtn = document.getElementById("btnRefresh");
    refreshBtn.addEventListener("click", () => {
      refreshBtn.classList.add("spin");
      this.loadPageData(this.currentPage).finally(() => {
        setTimeout(() => refreshBtn.classList.remove("spin"), 500);
      });
      toast("已刷新", "success");
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        this.closeModal();
        this.closeLightbox();
      }
    });
  },

  /* ──── 模态框 ──── */
  openModal(title, bodyHtml, footerHtml) {
    document.getElementById("modalTitle").textContent = title;
    document.getElementById("modalBody").innerHTML = bodyHtml;
    document.getElementById("modalFooter").innerHTML = footerHtml;
    document.getElementById("modalOverlay").classList.add("show");
  },

  closeModal() {
    document.getElementById("modalOverlay").classList.remove("show");
  },
};

// 行内按钮和动态渲染片段都需要稳定访问 App，避免点击标注时找不到入口。
window.App = App;

/* ──── 工具函数 ──── */
async function api(url, opts) {
  const res = await fetch(url, opts);
  return res.json();
}

function esc(str) {
  if (!str) return "";
  const el = document.createElement("span");
  el.textContent = str;
  return el.innerHTML;
}

function attr(str) {
  // 属性值复用 HTML 转义，并补足单引号以兼容行内事件参数。
  return esc(str).replace(/'/g, "&#39;");
}

async function copyTextToClipboard(text) {
  // Electron/localhost 优先走 Clipboard API；不可用时用隐藏 textarea 兼容旧环境。
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("当前环境不支持剪贴板写入");
}

function formatTime(t) {
  if (!t) return "";
  try {
    const d = new Date(t);
    if (isNaN(d.getTime())) return t;
    const now = new Date();
    const diff = now - d;
    if (diff < 60000) return "刚刚";
    if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
    if (diff < 172800000) return "昨天";
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return t;
  }
}

function toast(msg, type = "info") {
  const container = document.getElementById("toastContainer");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateX(20px)";
    el.style.transition = "all 0.3s ease";
    setTimeout(() => el.remove(), 300);
  }, 3000);
}

/* ──── 启动 ──── */
document.addEventListener("DOMContentLoaded", () => App.init());
