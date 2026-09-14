// Small Chat Completions adapter. Keep its contract aligned with model-call.ps1
// using relay-compatibility.test.js; never surface upstream response bodies in errors.
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export function modelText(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map(part => typeof part === 'string' ? part
    : ['text', 'output_text'].includes(part?.type) && typeof part.text === 'string' ? part.text : '').join('');
}
export function extractModelText(payload) {
  if (payload?.error) throw new Error('模型接口返回错误');
  const choice = payload?.choices?.[0];
  if (['length', 'content_filter'].includes(choice?.finish_reason)) throw new Error('模型正文未完整生成');
  const output = Array.isArray(payload?.output) ? payload.output
    .filter(item => !item.type || item.type === 'message').flatMap(item => item.content ?? []) : [];
  for (const candidate of [choice?.message?.content, choice?.text, payload?.output_text, output]) {
    const text = modelText(candidate).trim();
    if (text) return text;
  }
  throw new Error('模型没有返回有效文字（需要最终正文，推理内容不算正文）');
}
function parseJson(raw) {
  try { return JSON.parse(raw.replace(/^\uFEFF/u, '')); }
  catch { throw new Error('模型返回了无效 JSON'); }
}
export function parseModelResponse(raw, contentType = '') {
  if (!contentType.toLowerCase().includes('text/event-stream')) {
    const payload = parseJson(raw);
    return { content: extractModelText(payload), finishReason: payload.choices?.[0]?.finish_reason ?? '', usage: payload.usage ?? null };
  }
  const parts = [];
  let ended = false, finishReason = '', usage = null;
  // SSE data lines in one event are joined with LF; UTF-8 is decoded before parsing.
  const events = raw.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n').split('\n\n');
  for (const event of events) {
    const data = event.split('\n').filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /u, '')).join('\n');
    if (!data) continue;
    if (data.trim() === '[DONE]') { ended = true; break; }
    const payload = parseJson(data);
    if (payload?.error) throw new Error('模型流式响应返回错误');
    if (payload.usage) usage = payload.usage;
    const choice = payload.choices?.find(item => item.index === 0) ?? payload.choices?.[0];
    if (!choice) continue;
    parts.push(modelText(choice.delta?.content ?? choice.message?.content ?? choice.text));
    if (choice.finish_reason) { finishReason = choice.finish_reason; ended = true; }
  }
  if (!ended) throw new Error('模型流式响应中断，未收到结束标记');
  if (finishReason === 'length' || finishReason === 'content_filter') throw new Error('模型流式正文未完整生成');
  const content = parts.join('').trim();
  if (!content) throw new Error('模型没有返回有效文字（需要最终正文，推理内容不算正文）');
  return { content, finishReason, usage };
}
async function readBounded(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let bytes = 0, text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('模型响应超过 8 MiB 限制'); }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}
function unsupportedMaxTokens(raw) {
  let error;
  try { error = JSON.parse(raw)?.error; } catch { return false; }
  if (!error || typeof error !== 'object') return false;
  return (error.param === 'max_tokens' && error.code === 'unsupported_parameter')
    || (/\bmax_tokens\b/iu.test(String(error.message ?? ''))
      && /unsupported|not supported|not allowed|unrecognized|unknown parameter/iu.test(String(error.message ?? '')));
}
export async function executeChatRequest(call, { fetchImpl = fetch, signal } = {}) {
  let body = { ...call.body };
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetchImpl(call.url, {
      method: 'POST', headers: call.headers, body: JSON.stringify(body), signal,
      redirect: 'error', // Never move a credentialed request to an unconfigured endpoint.
    });
    const raw = await readBounded(response);
    if (!response.ok) {
      if (attempt === 0 && [400, 422].includes(response.status) && body.max_tokens !== undefined && unsupportedMaxTokens(raw)) {
        body = { ...body, max_completion_tokens: body.max_tokens };
        delete body.max_tokens;
        continue;
      }
      throw new Error(`HTTP ${response.status}`);
    }
    return parseModelResponse(raw, response.headers.get('content-type') ?? '');
  }
}
