/* DeepSeek 朗读解锁 —— 隔离世界脚本：给弹窗当后端，并做接口直连
 *
 * 它能读到本页 localStorage（同源共享）里的 userToken，所以可以在页面上下文里
 * 直接调官方接口：音色列表 / 切音色 / 历史消息 / 取 TTS 票据 / 合成音频（导出 WAV）。
 */

const KEY = '__ds_remote_feature_store_model';
const SAMPLE_RATE = 24000;
const BRIDGE_VERSION = 4;

function token() {
  try { return JSON.parse(localStorage.getItem('userToken') || 'null')?.value || null; } catch { return null; }
}

// 磁盘上的真实配置：用来告诉用户「你本来有没有被灰度到」
function grayInfo() {
  try {
    const store = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!store) return null;
    const list = (store.entries && store.entries.model_configs && store.entries.model_configs.value) || [];
    return {
      remoteVersion: store.remoteVersion ?? null,
      models: list.map(c => ({ model: c.model_type, enabled: !!c.enabled, gray: !!c.tts_feature })),
    };
  } catch { return null; }
}

async function api(path, init = {}, tk) {
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(tk ? { Authorization: 'Bearer ' + tk } : {}),
      ...(init.headers || {}),
    },
  });
  return res.json();
}

function sessionIdFromUrl() {
  const m = location.pathname.match(/\/a\/chat\/s\/([^/?#]+)/i);
  return m ? m[1] : null;
}

function messageText(m) {
  if (!m) return '';
  // 当前接口把正文放在 fragments[].content（type: REQUEST / RESPONSE / THINK）
  if (Array.isArray(m.fragments)) {
    const parts = m.fragments.filter((f) => f && typeof f.content === 'string' && f.content);
    const visible = parts.filter((f) => !/^think/i.test(String(f.type || '')));
    const text = (visible.length ? visible : parts).map((f) => f.content).join('\n').trim();
    if (text) return text;
  }
  const content = m.content;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object') {
    for (const key of ['text', 'content', 'value', 'answer']) {
      if (typeof content[key] === 'string') return content[key];
    }
    if (Array.isArray(content)) {
      return content.map((x) => (typeof x === 'string' ? x : (x && typeof x.text === 'string' ? x.text : ''))).join(' ');
    }
  }
  return typeof m.text === 'string' ? m.text : '';
}

function messageRole(m) {
  const raw = m && (m.role || m.message_role || m.sender || m.role_type || m.type);
  if (raw == null) return '';
  const value = String(raw).toLowerCase();
  if (value === 'user' || value === 'human') return 'user';
  if (value === 'assistant' || value === 'ai' || value === 'bot') return 'assistant';
  return '';
}

function mapMessageList(list) {
  return (Array.isArray(list) ? list : [])
    .map((m) => m && { m, id: m.message_id != null ? m.message_id : m.id })
    .filter((x) => x && x.id != null)
    .slice(-40)
    .map(({ m, id }) => {
      const text = messageText(m).replace(/\s+/g, ' ').trim();
      return {
        id: String(id),
        role: messageRole(m),
        preview: text.slice(0, 80) || ('#' + String(id).slice(0, 8)),
      };
    });
}

// 页面主世界（inject.js）会把官方前端自己拉到的 history_messages 转过来
let pageMessages = null;

window.addEventListener('message', (ev) => {
  if (ev.source !== window) return;
  const data = ev.data;
  if (data && data.__dsTtsUnlock === 'messages' && Array.isArray(data.messages)) {
    pageMessages = { sessionId: data.sessionId || null, messages: data.messages };
  }
});

function requestPageMessages() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener('message', handler);
      resolve(value || null);
    };
    const handler = (ev) => {
      if (ev.source !== window) return;
      const data = ev.data;
      if (data && data.__dsTtsUnlock === 'messages' && Array.isArray(data.messages)) {
        finish({ sessionId: data.sessionId || null, messages: data.messages });
      }
    };
    const timer = setTimeout(() => finish(pageMessages), 700);
    window.addEventListener('message', handler);
    window.postMessage({ __dsTtsUnlock: 'getMessages' }, '*');
  });
}

function ack(ws, seq) {
  try {
    ws.send(JSON.stringify({ event: 'ack', received_seq: seq, played_seq: seq }));
  } catch { /* socket 已关 */ }
}

class TtsError extends Error {
  constructor(code, message) {
    super(message || ('tts error ' + code));
    this.code = code;
  }
}

// 官方朗读用的是同一条 wss；这里按 seq 收集二进制帧，攒成完整 PCM
function synthesizePcm(sessionId, messageId, ticket) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams({
      chat_session_id: sessionId,
      message_id: String(messageId),
      ticket,
      mode: 'manual',
      format: 'pcm',
    });
    const ws = new WebSocket(`wss://${location.host}/api/v0/chat/tts/?${qs}`);
    ws.binaryType = 'arraybuffer';

    const frames = new Map();
    let realFormat = 'pcm';
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* 忽略 */ }
      fn(arg);
    };
    const timer = setTimeout(() => finish(reject, new Error('timeout')), 180000);

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.event === 'ready') {
          realFormat = m.format || realFormat;
          ack(ws, 0);
        } else if (m.event === 'finish') {
          if (typeof m.code === 'number' && m.code !== 0) finish(reject, new TtsError(m.code, m.msg));
          else finish(resolve, { frames, realFormat });
        } else if (m.event === 'error') {
          finish(reject, new TtsError(m.code, m.msg || m.message));
        }
        return;
      }
      const view = new DataView(ev.data);
      const seq = view.getUint32(0, false);
      frames.set(seq, new Uint8Array(ev.data, 4));
      ack(ws, seq);
    };
    ws.onerror = () => finish(reject, new Error('websocket error'));
    ws.onclose = () => finish(resolve, { frames, realFormat });
  });
}

function toBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/* ---------- 按角色切换音色（下载对话时用） ---------- */
const VOICE_STORE = '__dsTtsPendingVoice';
let knownVoice = null;
let restoring = null;

async function readCurrentVoice(tk) {
  if (knownVoice) return knownVoice;
  const res = await api('/api/v0/chat/tts/voices', {}, tk);
  const id = res && res.code === 0 && res.data && res.data.biz_code === 0 && res.data.biz_data
    ? res.data.biz_data.current_voice_id
    : null;
  if (id) knownVoice = id;
  return id;
}

async function applyVoice(tk, voiceId) {
  const res = await api('/api/v0/chat/tts/voice', { method: 'POST', body: JSON.stringify({ voice_id: voiceId }) }, tk);
  if (!res || res.code !== 0 || !res.data || res.data.biz_code !== 0) {
    throw new Error('setVoice: ' + JSON.stringify(res).slice(0, 200));
  }
  knownVoice = voiceId;
}

function savedVoice() {
  try { return sessionStorage.getItem(VOICE_STORE); } catch { return null; }
}

function savePendingVoice(value) {
  try {
    if (value) sessionStorage.setItem(VOICE_STORE, value);
    else sessionStorage.removeItem(VOICE_STORE);
  } catch { /* 忽略 */ }
}

async function restoreSavedVoice(tk) {
  const saved = savedVoice();
  if (!saved) return null;
  if (knownVoice === saved) {
    savePendingVoice(null);
    return saved;
  }
  if (restoring) return restoring;
  restoring = (async () => {
    try {
      await applyVoice(tk, saved);
      savePendingVoice(null);
      return saved;
    } catch (e) {
      knownVoice = null;
      throw e;
    } finally {
      restoring = null;
    }
  })();
  return restoring;
}

// 弹窗中途被关掉时，页面下次加载把临时切换的音色恢复回去
setTimeout(() => {
  try {
    const tk = token();
    if (tk) restoreSavedVoice(tk).catch(() => {});
  } catch { /* 忽略 */ }
}, 1500);

async function downloadPcm(sessionId, messageId, tk) {
  const ticketRes = await api('/api/v0/auth/ticket', { method: 'POST', body: JSON.stringify({ scope: 'tts' }) }, tk);
  if (!ticketRes || ticketRes.code !== 0 || !ticketRes.data || ticketRes.data.biz_code !== 0) {
    throw new Error('ticket: ' + JSON.stringify(ticketRes).slice(0, 200));
  }

  const { frames, realFormat } = await synthesizePcm(sessionId, messageId, ticketRes.data.biz_data.ticket);
  if (realFormat !== 'pcm') throw new Error('unsupported format: ' + realFormat);

  const seqs = [...frames.keys()].sort((a, b) => a - b);
  let total = 0;
  for (const seq of seqs) total += frames.get(seq).length;
  if (!total) throw new Error('no audio');

  const pcm = new Uint8Array(total);
  let offset = 0;
  for (const seq of seqs) {
    const chunk = frames.get(seq);
    pcm.set(chunk, offset);
    offset += chunk.length;
  }
  return { audio: toBase64(pcm), bytes: pcm.length, seconds: total / 2 / SAMPLE_RATE };
}

// 跨浏览器：Firefox 用 browser.*（Promise），Chrome/Edge 用 chrome.*
// 注意：下面已有一个叫 api() 的取接口函数，所以这里叫 ext
const ext = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome;

ext.runtime.onMessage.addListener((msg, _sender, reply) => {
  let replied = false;
  const done = (payload) => {
    if (replied) return;
    replied = true;
    try { reply(payload); } catch { /* 弹窗已关 */ }
  };

  (async () => {
    try {
      const tk = token();
      if (msg.type === 'status') {
        done({
          ok: true,
          bridgeVersion: BRIDGE_VERSION,
          installed: document.documentElement.getAttribute('data-ds-tts-unlock') === '1',
          hasToken: !!tk,
          gray: grayInfo(),
          href: location.href,
        });
      } else if (msg.type === 'voices') {
        done({ ok: true, data: await api('/api/v0/chat/tts/voices', {}, tk) });
      } else if (msg.type === 'setVoice') {
        const res = await api('/api/v0/chat/tts/voice', { method: 'POST', body: JSON.stringify({ voice_id: msg.voiceId }) }, tk);
        if (res && res.code === 0 && res.data && res.data.biz_code === 0) {
          knownVoice = msg.voiceId;
          savePendingVoice(null);
        }
        done({ ok: true, data: res });
      } else if (msg.type === 'ticket') {
        done({ ok: true, data: await api('/api/v0/auth/ticket', { method: 'POST', body: JSON.stringify({ scope: 'tts' }) }, tk) });
      } else if (msg.type === 'messages') {
        const sessionId = sessionIdFromUrl();
        if (!sessionId) { done({ ok: false, error: 'no-session' }); return; }

        let messages = [];
        let total = 0;
        let keys = [];
        let apiError = null;

        // 1) 正常路径：插件自己调官方历史接口
        // cache_version=0 强制服务端返回全量快照（否则可能拿到 MERGE / 0 条增量）
        const res = await api('/api/v0/chat/history_messages?chat_session_id=' + encodeURIComponent(sessionId) + '&cache_version=0', {}, tk);
        if (res && res.code === 0 && res.data && res.data.biz_code === 0) {
          const biz = (res.data && res.data.biz_data) || {};
          const list = biz.chat_messages || biz.messages || [];
          keys = Object.keys(biz).slice(0, 12);
          total = Array.isArray(list) ? list.length : 0;
          messages = mapMessageList(list);
        } else {
          apiError = 'messages api: ' + JSON.stringify(res).slice(0, 200);
        }

        // 2) 兜底：用官方前端自己拉到的同一份历史（inject.js 捕获）
        if (!messages.length) {
          const recorded = await requestPageMessages();
          const fromPage = recorded && (!recorded.sessionId || recorded.sessionId === sessionId)
            ? recorded.messages
            : null;
          const pageList = mapMessageList(fromPage);
          if (pageList.length) {
            messages = pageList;
            total = fromPage.length;
            keys = [];
            console.info('[ds-tts] 使用页面缓存的历史消息兜底');
          }
        }

        if (!messages.length && apiError) {
          done({ ok: false, error: apiError });
          return;
        }
        if (!messages.length) {
          console.warn('[ds-tts] history_messages 没有可用消息；keys =', keys, '；消息条数 =', total);
        } else {
          console.debug('[ds-tts] history_messages：', messages.length, '条');
        }
        done({ ok: true, data: { sessionId, messages, total, keys } });
      } else if (msg.type === 'download') {
        const sessionId = sessionIdFromUrl();
        if (!sessionId) { done({ ok: false, error: 'no-session' }); return; }
        if (!tk) { done({ ok: false, error: 'no-token' }); return; }
        if (!msg.messageId) { done({ ok: false, error: 'no-message' }); return; }

        const current = await readCurrentVoice(tk);
        const want = msg.voiceId || current;
        let switched = false;
        if (want && current && want !== current) {
          await applyVoice(tk, want);
          switched = true;
          if (msg.keepVoice && !savedVoice()) savePendingVoice(current);
        }
        try {
          const data = await downloadPcm(sessionId, msg.messageId, tk);
          done({ ok: true, data: { ...data, voice: want || current || null } });
        } finally {
          if (switched && !msg.keepVoice) {
            try { await applyVoice(tk, current); } catch { knownVoice = null; }
          }
        }
      } else if (msg.type === 'restoreVoice') {
        if (!tk) { done({ ok: true, data: { voice: null } }); return; }
        done({ ok: true, data: { voice: await restoreSavedVoice(tk) } });
      } else if (msg.type === 'reset') {
        // 清掉本地配置缓存：下次加载会从服务端重新拉真值，缓存里的补丁一起消失
        localStorage.removeItem(KEY);
        done({ ok: true });
        setTimeout(() => location.reload(), 120);
      } else {
        done({ ok: false, error: 'unknown message: ' + msg.type });
      }
    } catch (e) {
      done({ ok: false, error: String(e), code: (e && typeof e.code === 'number') ? e.code : null });
    }
  })();

  return true; // 异步回复
});
