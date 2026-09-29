/*
 * 缓存用量记录 (Cache Usage Log)
 * SillyTavern 第三方 UI 扩展
 *
 * 只做一件事：记录每次生成返回的 usage（缓存写入 / 缓存读取 / 未缓存输入 / 输出 / 推理 / 费用）。
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
    toast: true,
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
    set('cacheWrite', u.cache_creation_input_tokens);
    set('cacheRead', u.cache_read_input_tokens);
    set('output', u.output_tokens);
    set('reasoning', u.output_tokens_details?.thinking_tokens);
    if (u.cache_creation) {
        set('cacheWrite5m', u.cache_creation.ephemeral_5m_input_tokens);
        set('cacheWrite1h', u.cache_creation.ephemeral_1h_input_tokens);
    }

    // OpenAI 兼容
    if (u.prompt_tokens !== undefined) {
        acc.format = acc.format || 'openai';
        const cached = num(u.prompt_tokens_details?.cached_tokens) ?? 0;
        set('cacheRead', cached);
        set('input', num(u.prompt_tokens) - cached);
        set('cacheWrite', u.prompt_tokens_details?.cache_write_tokens);
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
function finalize(acc, reqInfo) {
    const input = acc.input ?? 0;
    const cacheWrite = acc.cacheWrite ?? 0;
    const cacheRead = acc.cacheRead ?? 0;
    const totalInput = input + cacheWrite + cacheRead;
    return {
        time: Date.now(),
        model: acc.model || reqInfo.model || '',
        source: reqInfo.source || '',
        provider: acc.provider || '',
        stream: reqInfo.stream,
        found: !!acc.found,
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
    render();
    console.log(LOG, rec);
    if (s.toast && rec.found) {
        toastr.info(
            `写 ${fmt(rec.cacheWrite)} · 读 ${fmt(rec.cacheRead)} · 未缓存 ${fmt(rec.input)} · 命中 ${pct(rec.hitRate)} · 输出 ${fmt(rec.output)}`,
            '缓存用量',
            { timeOut: 4000 },
        );
    }
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
function fmt(n) {
    return n === undefined || n === null ? '—' : `${Number(n).toLocaleString()} tok`;
}
function pct(r) {
    return `${(r * 100).toFixed(1)}%`;
}
function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function renderLast(rec) {
    if (!rec) return '<div class="cul-empty">暂无记录（生成一次后出现）</div>';
    if (!rec.found) return '<div class="cul-empty">上次请求没有返回 usage（非流式 Claude 会被 ST 后端丢弃，建议开启流式）</div>';
    const w = rec.cacheWrite5m || rec.cacheWrite1h
        ? ` <small>(5m ${rec.cacheWrite5m ?? 0} / 1h ${rec.cacheWrite1h ?? 0})</small>` : '';
    const rows = [
        ['总输入', fmt(rec.totalInput)],
        ['缓存创建', fmt(rec.cacheWrite) + w],
        ['未缓存输入', fmt(rec.input)],
        ['缓存读取', fmt(rec.cacheRead)],
        ['缓存命中', pct(rec.hitRate)],
        ['推理', fmt(rec.reasoning)],
        ['输出', fmt(rec.output)],
    ];
    if (rec.cost !== undefined) rows.push(['费用', `$${rec.cost}`]);
    return `<div class="cul-grid">${rows.map(([k, v]) => `<div class="cul-k">${k}</div><div class="cul-v">${v}</div>`).join('')}</div>
        <div class="cul-meta">${esc(rec.model)} ${rec.provider ? '· ' + esc(rec.provider) : ''} · ${new Date(rec.time).toLocaleString()}</div>`;
}

function renderHistory(records) {
    if (!records.length) return '';
    const head = '<tr><th>时间</th><th>写</th><th>读</th><th>未缓存</th><th>命中</th><th>输出</th></tr>';
    const body = records.map((r) => r.found
        ? `<tr title="${esc(r.model)}"><td>${new Date(r.time).toLocaleTimeString()}</td><td>${r.cacheWrite}</td><td>${r.cacheRead}</td><td>${r.input}</td><td>${pct(r.hitRate)}</td><td>${r.output}</td></tr>`
        : `<tr><td>${new Date(r.time).toLocaleTimeString()}</td><td colspan="5">无 usage</td></tr>`).join('');
    return `<table class="cul-table">${head}${body}</table>`;
}

function renderSummary(records) {
    const ok = records.filter((r) => r.found);
    if (!ok.length) return '';
    const sum = (k) => ok.reduce((a, r) => a + (r[k] || 0), 0);
    const total = sum('totalInput');
    const cost = ok.some((r) => r.cost !== undefined) ? ` · 费用 $${sum('cost').toFixed(6)}` : '';
    return `<div class="cul-meta">合计 ${ok.length} 次 · 写 ${sum('cacheWrite').toLocaleString()} · 读 ${sum('cacheRead').toLocaleString()} · 未缓存 ${sum('input').toLocaleString()} · 输出 ${sum('output').toLocaleString()} · 总命中 ${pct(total ? sum('cacheRead') / total : 0)}${cost}</div>`;
}

function render() {
    const s = getSettings();
    $('#cul_last').html(renderLast(s.records[0]));
    $('#cul_summary').html(renderSummary(s.records));
    $('#cul_history').html(renderHistory(s.records));
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
          <label class="checkbox_label"><input id="cul_toast" type="checkbox" /><span>每次生成后弹出提示</span></label>
          <div class="cul-row">
            <span>保留条数</span>
            <input id="cul_max" class="text_pole" type="number" min="1" max="5000" style="width:80px" />
            <div id="cul_clear" class="menu_button">清空</div>
            <div id="cul_export" class="menu_button">导出 JSON</div>
          </div>
          <h4>最近一次</h4>
          <div id="cul_last"></div>
          <h4>历史</h4>
          <div id="cul_summary"></div>
          <div id="cul_history" class="cul-history"></div>
        </div>
      </div>
    </div>`;
}

function bindUI() {
    const s = getSettings();
    $('#cul_enabled').prop('checked', s.enabled).on('change', function () { s.enabled = this.checked; save(); });
    $('#cul_toast').prop('checked', s.toast).on('change', function () { s.toast = this.checked; save(); });
    $('#cul_max').val(s.maxRecords).on('change', function () {
        s.maxRecords = Math.max(1, Number(this.value) || DEFAULTS.maxRecords);
        if (s.records.length > s.maxRecords) s.records.length = s.maxRecords;
        save(); render();
    });
    $('#cul_clear').on('click', () => { s.records = []; save(); render(); });
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
        render();
        installFetchHook();
        console.log(LOG, '已加载');
    } catch (e) {
        console.error(LOG, '初始化失败', e);
    }
});
