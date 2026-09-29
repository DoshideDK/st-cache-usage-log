/*
 * 缓存用量记录 (Cache Usage Log)
 * SillyTavern 第三方 UI 扩展
 *
 * 只做一件事：记录每次生成返回的 usage（缓存写入 / 缓存读取 / 未缓存输入 / 输出 / 推理 / 费用）。
 * 结果写进该条 AI 消息的 extra.cache_usage（随聊天存档持久化），显示在消息编辑按钮旁。
 *
 * 原理：包装 window.fetch，拦截 /api/backends/chat-completions/generate 的响应，
 *       clone 一份在后台解析，不影响酒馆原本的处理。
 *   - 流式（推荐）：ST 后端把上游 SSE 原样转发，可以拿到 Claude 的
 *     message_start / message_delta 里的 usage。
 *   - 非流式：ST 后端对 Claude 会把响应重新包装、丢掉 usage，因此通常拿不到
 *     （拿不到时会记录一条“无 usage”）。
 *
 * 默认支持 Claude(Anthropic Messages) 格式；顺带兼容 OpenAI 格式的
 * prompt_tokens / completion_tokens / prompt_tokens_details.cached_tokens。
 */

const MODULE_NAME = 'cache_usage_log';
const LOG = '[缓存用量记录]';
const TARGET_PATH = '/api/backends/chat-completions/generate';

const DEFAULTS = {
    enabled: true,
    showBadge: true,
    // 缓存口径（同 CPA-Manager-Plus 的 cache_input_mode）：
    //   auto | separate_from_input | included_in_input | read_included_creation_separate
    cacheInputMode: 'auto',
    maxRecords: 200,
    records: [],
};

// ------------------------------------------------------------
//  设置
// ------------------------------------------------------------
function ctx() {
    return SillyTavern.getContext();
}

function getSettings() {
    const es = ctx().extensionSettings;
    if (!es[MODULE_NAME]) es[MODULE_NAME] = structuredClone(DEFAULTS);
    const s = es[MODULE_NAME];
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (s[k] === undefined) s[k] = structuredClone(v);
    }
    return s;
}

function save() {
    ctx().saveSettingsDebounced();
}

// ------------------------------------------------------------
//  usage 解析
// ------------------------------------------------------------
function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
}

/**
 * 把一个 usage 对象（Claude 或 OpenAI 格式）合并进 acc。
 * 后到的非空字段覆盖先到的（Claude 流式里 message_delta 的 output_tokens 是累计值）。
 */
function mergeUsage(acc, u) {
    if (!u || typeof u !== 'object') return acc;
    const set = (key, val) => {
        const n = num(val);
        if (n === undefined) return;
        // 流式里 message_delta 可能把 input 类字段报 0，不用 0 覆盖已有的非 0 值
        if (n === 0 && acc[key]) return;
        acc[key] = n;
    };

    // Claude
    set('input', u.input_tokens);
    set('cacheWrite', u.cache_creation_input_tokens ?? u.cache_creation_tokens ?? u.cache_write_tokens);
    set('cacheRead', u.cache_read_input_tokens ?? u.cache_read_tokens);
    set('output', u.output_tokens);
    set('reasoning', u.output_tokens_details?.thinking_tokens);
    if (u.cache_creation) {
        set('cacheWrite5m', u.cache_creation.ephemeral_5m_input_tokens);
        set('cacheWrite1h', u.cache_creation.ephemeral_1h_input_tokens);
    }

    // OpenAI 兼容
    if (u.prompt_tokens !== undefined) {
        acc.format = acc.format || 'openai';
        // OpenAI 口径：prompt_tokens 是总输入（included_in_input），在 finalize 里统一减
        const d = u.prompt_tokens_details || {};
        set('cacheRead', d.cached_tokens ?? d.cache_read_tokens);
        set('cacheWrite', d.cache_write_tokens ?? d.cache_creation_tokens);
        set('input', u.prompt_tokens);
    }
    set('output', u.completion_tokens);
    set('reasoning', u.completion_tokens_details?.reasoning_tokens);

    set('cost', u.cost);
    acc.found = true;
    return acc;
}

function handlePayload(acc, obj) {
    if (!obj || typeof obj !== 'object') return;
    // Claude 流式
    if (obj.type === 'message_start' && obj.message) {
        acc.format = 'claude';
        if (obj.message.model) acc.model = obj.message.model;
        mergeUsage(acc, obj.message.usage);
    }
    if (obj.type === 'message_delta') {
        acc.format = 'claude';
        mergeUsage(acc, obj.usage);
    }
    // Claude 非流式 / OpenAI 最后一块 / 其他带 usage 的
    if (obj.type !== 'message_start' && obj.type !== 'message_delta' && obj.usage) {
        if (obj.type === 'message') acc.format = 'claude';
        mergeUsage(acc, obj.usage);
    }
    if (obj.model && !acc.model) acc.model = obj.model;
    if (obj.provider) acc.provider = obj.provider;
}

async function parseStream(response, acc) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const flushLine = (line) => {
        line = line.trim();
        if (!line.startsWith('data:')) return;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') return;
        try { handlePayload(acc, JSON.parse(data)); } catch { /* 忽略非 JSON 行 */ }
    };
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
            flushLine(buf.slice(0, idx));
            buf = buf.slice(idx + 1);
        }
    }
    if (buf) flushLine(buf);
}

async function parseJson(response, acc) {
    const text = await response.text();
    try { handlePayload(acc, JSON.parse(text)); } catch { /* ignore */ }
}

// ------------------------------------------------------------
//  记录
// ------------------------------------------------------------
const MODE_SEPARATE = 'separate_from_input';
const MODE_INCLUDED = 'included_in_input';
const MODE_READ_INCLUDED = 'read_included_creation_separate';

/**
 * 判定缓存口径（参考 CPA-Manager-Plus InferCacheInputMode）。
 * 前端拿不到 executor_type，所以 auto 模式：
 *   - OpenAI 格式：prompt_tokens 必含缓存 → included
 *   - Claude 格式：原生是 separate，但部分中转/上游会把缓存算进 input_tokens。
 *     有缓存且 input_tokens ≥ R+W 时视为 included，否则 separate。
 */
function inferMode(acc, rawInput, cacheRead, cacheWrite) {
    const setting = getSettings().cacheInputMode;
    if (setting && setting !== 'auto') return setting;
    if (acc.format === 'openai') return MODE_INCLUDED;
    const cached = cacheRead + cacheWrite;
    if (cached > 0 && rawInput >= cached) return MODE_INCLUDED;
    return MODE_SEPARATE;
}

/** 同 CPA-Manager-Plus NormalizeCacheAccounting */
function normalizeCache(mode, rawInput, cacheRead, cacheWrite) {
    switch (mode) {
        case MODE_INCLUDED:
            return { input: Math.max(0, rawInput - cacheRead - cacheWrite), totalInput: rawInput };
        case MODE_READ_INCLUDED:
            return { input: Math.max(0, rawInput - cacheRead), totalInput: rawInput + cacheWrite };
        default:
            return { input: rawInput, totalInput: rawInput + cacheRead + cacheWrite };
    }
}

function finalize(acc, reqInfo) {
    const cacheWrite = acc.cacheWrite ?? 0;
    const cacheRead = acc.cacheRead ?? 0;
    const rawInput = acc.input ?? 0;
    const cacheInputMode = inferMode(acc, rawInput, cacheRead, cacheWrite);
    const { input, totalInput } = normalizeCache(cacheInputMode, rawInput, cacheRead, cacheWrite);
    return {
        time: Date.now(),
        model: acc.model || reqInfo.model || '',
        source: reqInfo.source || '',
        provider: acc.provider || '',
        format: acc.format || '',
        stream: reqInfo.stream,
        found: !!acc.found,
        cacheInputMode,
        rawInput,
        totalInput,
        cacheWrite,
        cacheWrite5m: acc.cacheWrite5m,
        cacheWrite1h: acc.cacheWrite1h,
        input,
        cacheRead,
        hitRate: totalInput > 0 ? cacheRead / totalInput : 0,
        reasoning: acc.reasoning,
        output: acc.output ?? 0,
        cost: acc.cost,
    };
}

function addRecord(rec) {
    const s = getSettings();
    s.records.unshift(rec);
    if (s.records.length > s.maxRecords) s.records.length = s.maxRecords;
    save();
    console.log(LOG, rec);
    if (rec.found) {
        pending.usage = rec;
        tryAttach();
    }
}

// ------------------------------------------------------------
//  挂到消息上（写进 message.extra，随聊天文件持久化）
// ------------------------------------------------------------
// usage 解析完成 和 MESSAGE_RECEIVED 谁先到不确定，两边都到齐再挂
const pending = { usage: null, messageId: null };

function tryAttach() {
    if (!pending.usage || pending.messageId === null) return;
    const { chat, saveChat } = ctx();
    const id = pending.messageId;
    const msg = chat[id];
    const usage = pending.usage;
    pending.usage = null;
    pending.messageId = null;
    if (!msg || msg.is_user) return;

    msg.extra = msg.extra || {};
    msg.extra.cache_usage = usage;
    // 同步到当前 swipe，切换 swipe 时各自保留
    const sw = msg.swipe_info?.[msg.swipe_id];
    if (sw) {
        sw.extra = sw.extra || {};
        sw.extra.cache_usage = usage;
    }
    saveChat();
    renderBadge(id);
}

function onGenerationStarted(type, _opts, dryRun) {
    if (dryRun) return;
    pending.usage = null;
    pending.messageId = null;
}

function onMessageReceived(id) {
    pending.messageId = Number(id);
    tryAttach();
}

// ------------------------------------------------------------
//  fetch 钩子
// ------------------------------------------------------------
function installFetchHook() {
    if (window.__cacheUsageLogHooked) return;
    window.__cacheUsageLogHooked = true;
    const origFetch = window.fetch.bind(window);

    window.fetch = async function (input, init) {
        const url = typeof input === 'string' ? input : (input?.url || String(input));
        const response = await origFetch(input, init);
        try {
            if (!getSettings().enabled || !url.includes(TARGET_PATH) || !response.ok) return response;

            let reqInfo = {};
            try {
                const body = JSON.parse(init?.body || '{}');
                reqInfo = { model: body.model, source: body.chat_completion_source, stream: !!body.stream };
            } catch { /* ignore */ }

            const copy = response.clone();
            const acc = {};
            const isSse = (response.headers.get('content-type') || '').includes('text/event-stream') || reqInfo.stream;
            (isSse ? parseStream(copy, acc) : parseJson(copy, acc))
                .then(() => addRecord(finalize(acc, reqInfo)))
                .catch((e) => console.warn(LOG, '解析失败', e));
        } catch (e) {
            console.warn(LOG, e);
        }
        return response;
    };
}

// ------------------------------------------------------------
//  UI
// ------------------------------------------------------------
function short(n) {
    n = Number(n) || 0;
    const f = (v, u) => `${v < 10 ? +v.toFixed(1) : Math.round(v)}${u}`;
    if (n >= 1e6) return f(n / 1e6, 'M');
    if (n >= 1e3) return f(n / 1e3, 'k');
    return String(n);
}

function money(c) {
    if (c === undefined || !Number.isFinite(c)) return null;
    return `$${c >= 1 ? c.toFixed(2) : c >= 0.01 ? c.toFixed(3) : c.toFixed(4)}`;
}

function renderBadge(id) {
    const el = $(`#chat .mes[mesid="${id}"]`);
    if (!el.length) return;
    el.find('.cul-badge').remove();
    if (!getSettings().showBadge) return;
    const rec = ctx().chat[id]?.extra?.cache_usage;
    if (!rec) return;
    const rate = rec.hitRate || 0;
    const chCls = rate >= 0.8 ? 'good' : rate >= 0.3 ? 'mid' : 'bad';
    const seg = (cls, text) => `<span class="cul-${cls}">${text}</span>`;
    const parts = [
        seg('in', `↑${short(rec.input)}`),
        seg('out', `↓${short(rec.output)}`),
        seg('r', `R${short(rec.cacheRead)}`),
        seg('w', `W${short(rec.cacheWrite)}`),
        seg(`ch ${chCls}`, `CH${(rate * 100).toFixed(1)}%`),
    ];
    const cost = rec.cost !== undefined ? money(Number(rec.cost)) : null;
    if (cost) parts.push(seg('cost', cost));
    const badge = $(`<div class="cul-badge">${parts.join('')}</div>`);
    // 放在 .mes_buttons 外面（它默认悬停才显示），保证常驻可见
    const buttons = el.find('.mes_buttons').first();
    if (buttons.length) buttons.before(badge); else el.find('.ch_name').first().append(badge);
}

function renderAllBadges() {
    $('#chat .mes').each(function () {
        renderBadge($(this).attr('mesid'));
    });
}

function buildSettingsHtml() {
    return `
    <div class="cache-usage-log-settings">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>缓存用量记录</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
          <label class="checkbox_label"><input id="cul_enabled" type="checkbox" /><span>启用记录</span></label>
          <label class="checkbox_label"><input id="cul_badge" type="checkbox" /><span>在消息上显示用量</span></label>
          <label for="cul_mode">缓存口径（input_tokens 是否含缓存）</label>
          <select id="cul_mode" class="text_pole">
            <option value="auto">自动（推荐）</option>
            <option value="separate_from_input">不含缓存：↑ = input（原生 Claude）</option>
            <option value="included_in_input">含缓存：↑ = input − R − W（OpenAI 等）</option>
            <option value="read_included_creation_separate">含读取不含写入：↑ = input − R</option>
          </select>
          <div class="cul-row">
            <div id="cul_export" class="menu_button">导出 JSON</div>
            <div id="cul_clear" class="menu_button">清空记录</div>
          </div>
        </div>
      </div>
    </div>`;
}

function bindUI() {
    const s = getSettings();
    $('#cul_enabled').prop('checked', s.enabled).on('change', function () { s.enabled = this.checked; save(); });
    $('#cul_badge').prop('checked', s.showBadge).on('change', function () { s.showBadge = this.checked; save(); renderAllBadges(); });
    $('#cul_mode').val(s.cacheInputMode || 'auto').on('change', function () { s.cacheInputMode = this.value; save(); });
    $('#cul_clear').on('click', () => { s.records = []; save(); });
    $('#cul_export').on('click', () => {
        const blob = new Blob([JSON.stringify(s.records, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `cache-usage-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
    });
}

jQuery(() => {
    try {
        getSettings();
        $('#extensions_settings2').append(buildSettingsHtml());
        bindUI();
        installFetchHook();

        const { eventSource, event_types } = ctx();
        eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
        eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (id) => renderBadge(id));
        for (const ev of [event_types.CHAT_CHANGED, event_types.MORE_MESSAGES_LOADED, event_types.MESSAGE_SWIPED,
            event_types.MESSAGE_UPDATED, event_types.MESSAGE_DELETED]) {
            eventSource.on(ev, () => setTimeout(renderAllBadges, 0));
        }
        renderAllBadges();
        console.log(LOG, '已加载');
    } catch (e) {
        console.error(LOG, '初始化失败', e);
    }
});
