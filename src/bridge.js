/**
 * The text bridge: everything that turns an OpenAI-style conversation into the one text message a web chat takes, and its answer back into OpenAI-style
 * text and tool calls. No network and no provider in here, only strings.
 *
 * A web chat has no native tool calling, so the tool schemas of a request go into the prompt, the model is asked to answer with a call in a plain format
 * (<tool_call>{...}</tool_call> for DeepSeek, one fenced JSON block), and what comes back is read for calls in every shape these chats have been
 * seen to use (the tag, DeepSeek's own DSML markup, a fenced or bare JSON object, a call that lost its closing characters to a cut-off stream). A tool
 * result in the next request is rendered into the transcript for the model. Only tools that were offered are ever accepted, and a request that offered
 * none never has a tool call read out of its answer.
 */
'use strict';

const crypto = require('crypto');

const TOOL_RESULT_CAP = 60000;
// DeepSeek sometimes answers in its native DSML block form instead of the bridge format. Both are accepted. The bars around "DSML" are two as a
// rule, but a tag written with one (seen live: "</｜DSML｜｜ parameter>") is the same tag, so any count is read.
const DSML_MARK = '(?:｜|\\|)+';


/**
 * What a tool call aims at: its name and its short arguments (a path, a command). A file's whole contents differ on every pass of a loop, so they are
 * left out (forty rewrites of one file are one step repeated); an edit's long old and new text say which change it makes, so they count, as a hash
 * (three different edits to one file are three steps, seen 2026-10-28 on a copy tuning its stylesheet). A call with no short argument has no signature
 * and is never counted as a repeat.
 */
const WHOLE_FILE = /^(content|contents|text|code|body|data)$/i;
function callSignature(call) {
  const f = call && call.function ? call.function : {};
  const args = parseArgs(f.arguments) || {};
  const short = Object.keys(args).sort().filter((k) => (typeof args[k] === 'string' && args[k].length <= 200) || typeof args[k] === 'number' || typeof args[k] === 'boolean');
  if (!f.name || !short.length) return null;
  const long = Object.keys(args).sort().filter((k) => typeof args[k] === 'string' && args[k].length > 200 && !WHOLE_FILE.test(k));
  const pathKey = short.find((k) => /path|file/i.test(k) && typeof args[k] === 'string') || short.find((k) => typeof args[k] === 'string');
  return { key: `${f.name}|${[...short.map((k) => `${k}=${args[k]}`), ...long.map((k) => `${k}#${shortHash(args[k])}`)].join('|')}`, label: `${f.name}${pathKey ? ` ${String(args[pathKey]).split('/').filter(Boolean).pop() || args[pathKey]}` : ''}` };
}

/**
 * How many tool calls at the very end of the conversation aim at the same thing, with nothing but their results between them. A person's message
 * or the model's own words end the run (so "continue" starts afresh). A model that has finished but keeps calling the same tool on the same file is
 * looping (seen on a real account: forty rewrites of one file, a call on a personal account each).
 */
function trailingRepeat(messages) {
  let key = null;
  let label = '';
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === 'tool' || m.role === 'function') continue;
    if (m.role !== 'assistant' || !Array.isArray(m.tool_calls) || !m.tool_calls.length) break;
    const sigs = m.tool_calls.map(callSignature);
    if (sigs.some((x) => !x)) break;
    let same = true;
    for (const sig of sigs.reverse()) {
      if (key === null) { key = sig.key; label = sig.label; }
      if (sig.key !== key) { same = false; break; }
      count += 1;
    }
    if (!same) break;
  }
  return { count, label };
}

const IMAGE_NOTE = '[image omitted by the bridge]';
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const IMAGE_MARK = /\[attached image (\d+)\]/g;

const isImagePart = (part) => Boolean(part) && typeof part === 'object' && (part.type === 'image_url' || part.type === 'input_image');
const isFilePart = (part) => Boolean(part) && typeof part === 'object' && (part.type === 'file' || part.type === 'input_file');

const FILE_TEXT_CHARS = 200000;
const TEXT_MIME = /^(?:text\/|application\/(?:json|ld\+json|xml|javascript|x-javascript|ecmascript|typescript|x-typescript|yaml|x-yaml|toml|x-toml|sql|graphql|x-sh|x-httpd-php|csv)$|application\/[a-z.-]+\+(?:json|xml)$)/i;

/** Bytes with no NUL that decode as UTF-8: a text file that came without a type. */
function looksText(bytes) {
  if (bytes.subarray(0, 8192).includes(0)) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return true; } catch (_) { return false; }
}

/**
 * A file part (chat `{ type: 'file', file: { filename, file_data } }`, Responses `{ type: 'input_file', filename, file_data }`) as prompt text. A text file
 * sent inline is written out under its name; any other file (a PDF, an archive, one named by id or address) is named as left out, so the model says so
 * instead of answering as if it had read it. Only pictures and text reach a model through this bridge.
 */
function fileText(part) {
  const f = part.type === 'file' ? (part.file && typeof part.file === 'object' ? part.file : {}) : part;
  const name = String(f.filename || f.name || 'file').replace(/[\r\n"\]]/g, ' ').trim().slice(0, 120) || 'file';
  const m = /^data:([^;,]*)((?:;[^;,]*)*),([\s\S]*)$/.exec(String(f.file_data || ''));
  if (!m) return `[file "${name}" omitted by the bridge: only a file sent inline can be read]`;
  const mime = (m[1] || 'application/octet-stream').toLowerCase();
  let bytes;
  try { bytes = /;base64/i.test(m[2]) ? Buffer.from(m[3].replace(/\s+/g, ''), 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8'); } catch (_) { bytes = null; }
  const unknown = mime === 'application/octet-stream' || !mime.includes('/');
  if (!bytes || !(TEXT_MIME.test(mime) || (unknown && looksText(bytes)))) {
    return `[file "${name}" (${mime}) omitted by the bridge: only pictures and text files reach the model. Its contents are NOT visible to you.]`;
  }
  const text = bytes.toString('utf8');
  const cut = text.length > FILE_TEXT_CHARS ? `\n[... the rest of the file, ${text.length - FILE_TEXT_CHARS} characters, was cut by the bridge]` : '';
  return `[attached file "${name}"]\n${text.slice(0, FILE_TEXT_CHARS)}${cut}\n[end of file "${name}"]`;
}

/** The picture an image part holds, { mime, ext, bytes, hash }, or null. Only a picture sent inline (a data: URL) is read: the bridge never goes to an address a client names. */
function pictureOf(part) {
  const raw = part && (typeof part.image_url === 'string' ? part.image_url : part.image_url && part.image_url.url);
  const m = /^data:(image\/[a-z+.-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(raw || ''));
  if (!m) return null;
  const mime = m[1].toLowerCase();
  const bytes = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
  if (!IMAGE_TYPES[mime] || !bytes.length) return null;
  return { mime, ext: IMAGE_TYPES[mime], bytes, hash: crypto.createHash('sha256').update(bytes).digest('hex') };
}

/**
 * The pictures of one request, numbered in the order they first appear in the whole conversation (the same picture, byte for byte, keeps its number), so a
 * picture is called the same thing in the first message of a chat and in a later one that continues it. A picture is written into the prompt as
 * `[attached image N]`; `inPrompt(text)` is the pictures whose marker a prompt holds, which is what has to be sent along with that prompt. A provider that
 * cannot take pictures simply never gets one of these, and its prompt says the picture was left out.
 */
function createPictures() {
  const byHash = new Map();
  const all = [];
  const take = (part) => {
    const pic = pictureOf(part);
    if (!pic) return null;
    let found = byHash.get(pic.hash);
    if (!found) { found = { ...pic, n: all.length + 1 }; byHash.set(pic.hash, found); all.push(found); }
    return `[attached image ${found.n}]`;
  };
  return {
    take,
    scan(content) { if (Array.isArray(content)) for (const part of content) if (isImagePart(part)) take(part); },
    inPrompt(text) {
      const seen = new Set();
      for (const m of String(text || '').matchAll(IMAGE_MARK)) seen.add(Number(m[1]));
      return all.filter((p) => seen.has(p.n));
    },
    get count() { return all.length; }
  };
}

function contentToText(content, pictures = null) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      if (typeof part.text === 'string') return part.text;
      if (isImagePart(part)) return (pictures && pictures.take(part)) || IMAGE_NOTE;
      if (isFilePart(part)) return fileText(part);
      return '';
    }).filter(Boolean).join('\n');
  }
  if (content == null) return '';
  try { return JSON.stringify(content); } catch (_) { return String(content); }
}

function sanitizeJsonControlChars(str) {
  let inString = false;
  let escaped = false;
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        out += ch;
      } else if (ch === '\\') {
        escaped = true;
        out += ch;
      } else if (ch === '"') {
        inString = false;
        out += ch;
      } else if (ch === '\n') {
        out += '\\n';
      } else if (ch === '\r') {
        out += '\\r';
      } else if (ch === '\t') {
        out += '\\t';
      } else if (ch.charCodeAt(0) < 32) {
        out += '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
      } else {
        out += ch;
      }
    } else {
      if (ch === '"') inString = true;
      out += ch;
    }
  }
  return out;
}

function tryJson(text) {
  if (typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch (_) {}
  try { return JSON.parse(sanitizeJsonControlChars(text)); } catch (_) {}
  return null;
}

/**
 * A JSON object that lost only its closing characters to a cut-off stream. Closers are added only
 * when the text ends outside a string, so a call cut in the middle of its content is never half-used.
 */
function closedJson(text) {
  const direct = tryJson(text);
  if (direct) return direct;
  const source = String(text || '');
  const stack = [];
  let inString = false;
  let escaped = false;
  for (const ch of source) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return null;
    }
  }
  if (inString || !stack.length || stack.length > 8) return null;
  return tryJson(source + stack.reverse().join(''));
}

/**
 * Arguments written as a string with their quotes escaped once too often ("{\\"filePath\\": ...}" as text that is not JSON as it stands): read with one
 * level of escaping taken off. Null when that does not give an object.
 */
function unescapedJson(text) {
  if (typeof text !== 'string' || !/\\"/.test(text)) return null;
  let decoded;
  try { decoded = JSON.parse(`"${sanitizeJsonControlChars(text).replace(/(^|[^\\])"/g, '$1\\"').replace(/(^|[^\\])"/g, '$1\\"')}"`); } catch (_) { return null; }
  const obj = closedJson(decoded);
  return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
}

function parseArgs(value) {
  let parsed = null;
  if (typeof value === 'string') {
    parsed = tryJson(value) || closedJson(value) || unescapedJson(value);
  } else if (value && typeof value === 'object' && !Array.isArray(value)) {
    parsed = { ...value };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (!parsed.filePath && (parsed.path || parsed.file)) {
    parsed.filePath = parsed.path || parsed.file;
  }
  if (!parsed.content && (parsed.code || parsed.text)) {
    parsed.content = parsed.code || parsed.text;
  }
  if (!parsed.oldString && (parsed.old_string || parsed.old_str || parsed.search)) {
    parsed.oldString = parsed.old_string || parsed.old_str || parsed.search;
  }
  if (!parsed.newString && (parsed.new_string || parsed.new_str || parsed.replace)) {
    parsed.newString = parsed.new_string || parsed.new_str || parsed.replace;
  }
  return parsed;
}

function normalizeToolName(name, allowed) {
  if (!name) return '';
  if (allowed && allowed.has(name)) return name;
  const lower = name.toLowerCase().replace(/[-_]/g, '');
  if ((lower === 'writefile' || lower === 'createfile') && allowed && allowed.has('write')) return 'write';
  if ((lower === 'editfile' || lower === 'modifyfile') && allowed && allowed.has('edit')) return 'edit';
  if ((lower === 'readfile' || lower === 'viewfile') && allowed && allowed.has('read')) return 'read';
  return name;
}

// The task a request belongs to: the last message from the person (its place in the conversation and its words). Every later step of the same task only adds
// messages after it, so the key stays the same until the person writes again.
function taskKeyOf(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m && m.role === 'user') {
      const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
      return `${i}:${crypto.createHash('sha1').update(text).digest('hex').slice(0, 16)}`;
    }
  }
  return '';
}

// The conversation with each thought put back where it was asked (the client never saw those steps, so its own record of the task has none).
function withThoughts(messages, entries) {
  if (!entries.length) return messages;
  const out = messages.slice();
  let added = 0;
  for (const e of entries) {
    const at = Math.min(Math.max(0, e.at) + added, out.length);
    out.splice(at, 0, ...e.messages);
    added += e.messages.length;
  }
  return out;
}

function toolDefs(tools) {
  return tools.map((t) => (t && t.function ? t.function : t)).filter((f) => f && typeof f.name === 'string' && f.name);
}

// ---- telling a conversation apart from another, without keeping any of it ---------------------------------------------------------------------------------
// A provider chat that is continued (instead of started again for every request) needs to know which messages it already holds. Each message is reduced to a
// short hash of what makes it that message: its role, its words and, for an assistant message, the name and the arguments of each call (not the call ids,
// which are made fresh for every answer, and not the order the keys of the arguments came back in). Only hashes are ever kept, never the text.

/** JSON with the keys of every object in sorted order, so two spellings of the same arguments are one string. */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value === undefined ? null : value);
}

const shortHash = (text) => crypto.createHash('sha1').update(text).digest('hex').slice(0, 20);

/** The hash of one message of the conversation (not a system message: see conversationFingerprints). */
function fingerprint(message) {
  const m = message || {};
  const role = m.role === 'function' ? 'tool' : String(m.role || '');
  let calls = '';
  if (role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
    calls = m.tool_calls.map((c) => {
      const f = c && c.function ? c.function : {};
      const args = parseArgs(f.arguments);
      return `${f.name || ''}\u0001${args ? stableJson(args) : String(f.arguments || '')}`;
    }).join('\u0002');
  }
  // A picture is part of what a message says: two messages that differ only in the picture are not the same message.
  const pics = Array.isArray(m.content) ? m.content.filter(isImagePart).map((p) => { const pic = pictureOf(p); return pic ? pic.hash : 'x'; }).join(',') : '';
  return shortHash(`${role}\u0000${contentToText(m.content).trim()}\u0000${calls}\u0000${pics}`);
}

/**
 * What a request says about its conversation: `system` (one hash for all the system text) and `talk` (one hash for each message that is not a system message,
 * in order: the same messages buildPrompt calls the transcript).
 */
function conversationFingerprints(messages) {
  const list = Array.isArray(messages) ? messages.filter(Boolean) : [];
  const system = list.filter((m) => m.role === 'system').map((m) => contentToText(m.content)).filter(Boolean).join('\n\n');
  return { system: shortHash(`system\u0000${system}`), talk: list.filter((m) => m.role !== 'system').map(fingerprint) };
}

/** What the tools of a request are, as one hash: the same tools in another order, or with their keys in another order, are the same tools. */
function toolsKey(tools) {
  const defs = Array.isArray(tools) ? toolDefs(tools) : [];
  return shortHash(stableJson(defs.map((f) => ({ name: f.name, description: f.description || '', parameters: f.parameters || null })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))));
}

// Tools whose job is to create or change files. A coding agent that offers one of these needs telling, in words, to deliver code through it and not paste it into the
// chat; a request with no such tool (a weather lookup, say) must stay free to answer with code in the chat. Everything the bridge says about tools comes from the tools it
// was actually offered.
const FILE_TOOLS = /^(write|edit|write_file|edit_file|create_file|apply_patch|str_replace_editor)$/i;

function hasFileTools(tools) {
  return toolDefs(tools).some((f) => FILE_TOOLS.test(f.name));
}

/** The rules every format shares, as sentences. `options`: replyChars and callChars (a provider whose reply is cut off at a length), thinkWhen, batch. */
function sharedRules(tools, options = {}) {
  const files = hasFileTools(tools);
  const rules = [
    'Call a tool only when the request needs one. When it does not, answer in plain words and call nothing.',
    ...(files ? ['To create or change files, use the file tools. Do not output raw code into the chat.'] : []),
    'After a TOOL RESULT line, continue: call the next tool, or give the final answer when the task is complete. Never invent a tool result.',
    'The arguments are a JSON object, never a string. Escape a double quote or a line break only inside a string value, as \\" and \\n; the quotes around the keys and the values stay plain: {"filePath":"a.css","oldString":"a {\\n  color: red;\\n}"}. Give every parameter the tool requires.'
  ];
  if (options.replyChars) {
    rules.push(`One reply of yours holds about ${options.replyChars.toLocaleString('en-US')} characters, and a call that does not fit is cut off and lost. Keep every call under about ${options.callChars.toLocaleString('en-US')} characters${files ? ': split a big page into several files (a stylesheet, a script), or write the file in parts, a first "write" and then "edit" calls that add to the end' : ''}.`);
  }
  if (options.thinkWhen && toolDefs(tools).some((f) => f.name === 'think')) {
    rules.push('You have a "think" tool that hands one question to a slower reasoning model and returns its answer. Think FIRST, before your first tool call, when the task is to design or build something new from scratch (a site, an app, a game) or to plan a change across several files: ask how to structure it, which stack and design direction to take and what to avoid, naming every requirement the person gave (a library they asked for, light and dark modes, and so on), then build from its answer. Think again when the same error comes back twice. If a plan from thinking is already in this conversation (a TOOL RESULT of think), build from it and do not think about the same thing again. Do NOT think for a question, a small edit, a change to one file or anything you can simply do.');
  }
  if (options.batch) {
    rules.push('Put steps that do not depend on each other in the same reply, one call after the other (several files to write, several things to read): fewer replies are faster and gentler on the person\'s account. A step that needs the result of another goes in the next reply.');
  }
  return rules;
}

function toolList(tools) {
  return toolDefs(tools).map((f) => {
    const schema = f.parameters && typeof f.parameters === 'object' ? f.parameters : { type: 'object', properties: {} };
    return `### ${f.name}\n${String(f.description || '').trim()}\nparameters: ${JSON.stringify(schema)}`;
  }).join('\n\n');
}

/** The tool bridge in the <tool_call> format (DeepSeek's chat follows it, and answers in its own DSML markup now and then, which parseAnswer also reads). */
function bridgeSection(tools, options = {}) {
  return [
    '# Tool bridge',
    'To call tools, output tool-call blocks in this format:',
    '<tool_call>{"name":"TOOL_NAME","arguments":{"argument":"value"}}</tool_call>',
    '',
    'Rules:',
    ...sharedRules(tools, options).map((rule, i) => `${i + 1}. ${rule}`),
    '',
    'Available tools:',
    toolList(tools)
  ].join('\n');
}

/**
 * The tool bridge as one fenced JSON block (for a page whose chat shows every reply as formatted text). Outside a code block that page drops backslashes and
 * anything that looks like HTML, which breaks a call, so the call goes in a code block, where the text is shown as written.
 */
function fencedBridgeSection(tools, options = {}) {
  return [
    '# Tool bridge',
    'You are connected through a text-only bridge. Native tool calling is not available here, and any earlier instruction that describes it does not apply.',
    'To call a tool, reply with ONE fenced code block and nothing else: three backticks and the word json, a single JSON object, three backticks:',
    '```json',
    '{"name":"TOOL_NAME","arguments":{"argument":"value"}}',
    '```',
    'Always use the fenced block. This chat shows every reply as formatted text, and outside a code block it removes backslashes and anything that looks like HTML, which breaks the call.',
    'The arguments value is a JSON object matching that tool\'s parameters.',
    ...sharedRules(tools, options),
    ...(options.fileChars && hasFileTools(tools) ? [`Keep every file under about ${options.fileChars.toLocaleString('en-US')} characters. Compact, complete code is better than a long answer that is cut off before its end.`] : []),
    'Available tools:',
    toolList(tools)
  ].join('\n');
}

const PLAIN_HINT = 'Answer the latest USER message now.';
const TOOLS_HINT = 'Answer the latest USER message now. If it needs a tool, reply only with the tool-call blocks.';

/** What a JSON-mode request (response_format) adds to the prompt, or ''. The web chats have no such switch, so it is asked for in words. */
function jsonInstruction(format) {
  if (!format || typeof format !== 'object') return '';
  if (format.type === 'json_object') return 'Reply with one valid JSON value only: no words before or after it and no code fence.';
  if (format.type === 'json_schema') {
    const schema = format.json_schema && format.json_schema.schema;
    return `Reply with one valid JSON value that matches this JSON Schema, and nothing else: no words before or after it and no code fence.${schema ? `\nSCHEMA: ${JSON.stringify(schema)}` : ''}`;
  }
  return '';
}

/**
 * One prompt for a provider that takes a single text message, from the whole conversation: the system messages first, the tool bridge when tools are offered, the
 * transcript with each earlier tool call and its result, and a closing line that says what to do now.
 * options: bridge(tools), noToolsHint (the closing line when tools are offered), formatCall(call), continueHint, closing (a closing line that replaces all of
 * those), jsonMode ({ type: 'json_object' | 'json_schema', json_schema }), continuation ({ from, refreshBridge }).
 *
 * `continuation` is for a chat that already holds the conversation up to message number `from` of the transcript (the messages that are not system messages): only
 * the messages from there on are written, with no system text and no bridge (the chat has them), unless `refreshBridge` asks for the bridge to be said again. A
 * lone new question with no tools and no JSON mode goes as it is, like the first message of a plain chat does.
 */
function buildPrompt(messages, tools, options = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const hasTools = Array.isArray(tools) && toolDefs(tools).length > 0;
  const json = jsonInstruction(options.jsonMode);
  const pictures = options.images || null;
  const system = list.filter((m) => m && m.role === 'system').map((m) => contentToText(m.content)).filter(Boolean).join('\n\n');
  const talk = list.filter((m) => m && m.role !== 'system');
  // Every picture is numbered by the whole conversation, also those in messages a continued chat already holds, so a number means the same picture in every message.
  if (pictures) for (const m of talk) pictures.scan(m.content);
  const cont = options.continuation && Number.isInteger(options.continuation.from) ? options.continuation : null;
  const shown = cont ? talk.slice(cont.from) : talk;
  // A plain question with nothing around it goes as it is: a framed transcript is only needed when there is something to frame. A caller that asks for
  // a closing line of its own (options.closing, the question put to a thinking mode) always gets it.
  if (!hasTools && !json && !options.closing && shown.length === 1 && shown[0].role === 'user' && (cont || talk.length === 1)) {
    return [cont ? '' : system, contentToText(shown[0].content, pictures)].filter(Boolean).join('\n\n');
  }
  const bridge = options.bridge || bridgeSection;
  const noToolsHint = hasTools ? (options.noToolsHint || TOOLS_HINT) : PLAIN_HINT;
  // How a call the model made earlier is shown to it again: in the format the provider told it to use, so it keeps using that one.
  const formatCall = typeof options.formatCall === 'function' ? options.formatCall : (call) => `<tool_call>${JSON.stringify(call)}</tool_call>`;
  const continueHint = hasTools ? (options.continueHint || 'The tool result above is real. Continue the task now: call another tool, or give the final answer.') : 'Continue the conversation now.';
  const names = new Map();
  // A tool result is named by the call it answers, and that call may be in the part of the conversation the chat already holds.
  for (const m of talk) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) for (const c of m.tool_calls) if (c && c.id && c.function && c.function.name) names.set(String(c.id), String(c.function.name));
  }
  const transcript = [];
  for (const m of shown) {
    if (m.role === 'user') {
      transcript.push(`USER:\n${contentToText(m.content, pictures)}`);
      continue;
    }
    if (m.role === 'assistant') {
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      for (const c of calls) {
        if (c && c.id && c.function && c.function.name) names.set(String(c.id), String(c.function.name));
      }
      let line = `ASSISTANT:\n${contentToText(m.content).trim()}`;
      if (calls.length) {
        const blocks = calls.map((c) => {
          const f = c && c.function ? c.function : {};
          return formatCall({ name: String(f.name || ''), arguments: parseArgs(f.arguments) || {} });
        });
        line += `\n${blocks.join('\n')}`;
      }
      if (line.trim() !== 'ASSISTANT:') transcript.push(line);
      continue;
    }
    if (m.role === 'tool' || m.role === 'function') {
      const name = names.get(String(m.tool_call_id || '')) || String(m.name || 'tool');
      let result = contentToText(m.content, pictures);
      if (result.length > TOOL_RESULT_CAP) result = `${result.slice(0, TOOL_RESULT_CAP)}\n[result shortened by the bridge]`;
      transcript.push(`TOOL RESULT (${name}):\n${result}`);
    }
  }
  const sections = [];
  if (system && !cont) sections.push(system);
  if (hasTools && (!cont || cont.refreshBridge)) sections.push(bridge(tools));
  if (transcript.length) sections.push(transcript.join('\n\n'));
  if (json) sections.push(json);
  const last = talk[talk.length - 1];
  sections.push(options.closing || (last && (last.role === 'tool' || last.role === 'function') ? continueHint : noToolsHint));
  return sections.filter(Boolean).join('\n\n');
}

/**
 * A model now and then wraps the whole argument object in one more "arguments" layer (a DSML parameter of that name, or the same key nested in its JSON).
 * A tool never has a parameter called "arguments", so when that is the only parameter and it holds an object, the object is the call's arguments.
 */
function unwrapArguments(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const keys = Object.keys(args);
  if (keys.length !== 1 || keys[0] !== 'arguments') return args;
  const inner = typeof args.arguments === 'string' ? tryJson(args.arguments) : args.arguments;
  return inner && typeof inner === 'object' && !Array.isArray(inner) ? inner : args;
}

function callFrom(value, allowed) {
  let obj = typeof value === 'string' ? closedJson(value.replace(/<\/?\s*(?:｜|\|)+\s*DSML[\s\S]*?>/gi, '').trim()) : value;
  if (obj && obj.function && typeof obj.function === 'object') obj = { name: obj.function.name, arguments: obj.function.arguments };
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  let name = String(obj.name || obj.tool || obj.tool_name || '');
  name = normalizeToolName(name, allowed);
  if (!name || (allowed && allowed.size && !allowed.has(name))) return null;
  const explicit = obj.arguments != null ? obj.arguments : obj.parameters != null ? obj.parameters : obj.args;
  let args;
  if (explicit != null) {
    args = unwrapArguments(parseArgs(explicit) || {});
  } else {
    const rest = { ...obj };
    delete rest.name;
    delete rest.tool;
    delete rest.tool_name;
    delete rest.id;
    delete rest.type;
    delete rest.function;
    args = Object.keys(rest).length ? unwrapArguments(parseArgs(rest) || rest) : {};
  }
  return { name, arguments: JSON.stringify(args) };
}

function callsFrom(value, allowed) {
  if (Array.isArray(value)) return value.map((v) => callFrom(v, allowed)).filter(Boolean);
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value.tool_calls)) return callsFrom(value.tool_calls, allowed);
  const one = callFrom(value, allowed);
  return one ? [one] : [];
}

/** The index after the closing brace of the object that starts at `at`, or -1 when it never closes. */
function objectEnd(source, at) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = at; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * A web chat's answer can carry its tool call after a sentence of reasoning, or lose its own tail.
 * Both forms are found here, so a complete call is never shown to the person as raw JSON.
 */
function embeddedCalls(source, allowed) {
  const calls = [];
  const spans = [];
  let at = source.indexOf('{');
  let tries = 0;
  while (at !== -1 && tries < 100) {
    tries += 1;
    const end = objectEnd(source, at);
    const obj = end > at ? tryJson(source.slice(at, end)) : null;
    const stop = obj ? end : source.length;
    const found = obj ? callsFrom(obj, allowed) : [];
    if (found.length) {
      calls.push(...found);
      spans.push([at, stop]);
      at = source.indexOf('{', stop);
      continue;
    }
    if (!obj) {
      const repaired = closedJson(source.slice(at));
      const repairedCalls = repaired ? callsFrom(repaired, allowed) : [];
      if (repairedCalls.length) {
        calls.push(...repairedCalls);
        spans.push([at, source.length]);
        break;
      }
    }
    at = source.indexOf('{', at + 1);
  }
  return { calls, spans };
}

function dsmlBlocks(source) {
  const close = `<\\/\\s*${DSML_MARK}\\s*DSML\\s*${DSML_MARK}\\s*calls\\s*>`;
  const closed = new RegExp(`<\\s*${DSML_MARK}\\s*DSML\\s*${DSML_MARK}\\s*calls\\s*>([\\s\\S]*?)${close}`, 'gi');
  const out = [];
  let match;
  while ((match = closed.exec(source))) out.push({ full: match[0], body: match[1] });
  if (out.length) return out;
  const open = new RegExp(`<\\s*${DSML_MARK}\\s*DSML\\s*${DSML_MARK}\\s*calls\\s*>`, 'i');
  const found = open.exec(source);
  if (found) out.push({ full: source.slice(found.index), body: source.slice(found.index + found[0].length) });
  return out;
}

/** The parameters of one DSML block, in the arguments shape the OpenAI protocol uses. */
function callsInDsml(body, allowed) {
  // A model now and then closes a tag where it opens one ("</｜｜DSML｜｜ parameter name="x" ...>"). Read as an opening tag: otherwise the parameter
  // before it runs on to the next real closer, and its value swallows the rest of the call (a file path with markup in it, an edit that never lands).
  const source = String(body || '').replace(new RegExp(`<\\s*\\/\\s*(${DSML_MARK}\\s*DSML\\s*${DSML_MARK}\\s*)(parameter|invoke)(\\s+name\\s*=)`, 'gi'), '<$1$2$3');
  const invoke = new RegExp(`<\\s*${DSML_MARK}\\s*DSML\\s*${DSML_MARK}\\s*invoke\\s+name\\s*=\\s*["']([^"']+)["']\\s*>([\\s\\S]*?)<\\/\\s*${DSML_MARK}\\s*DSML\\s*${DSML_MARK}\\s*invoke\\s*>`, 'gi');
  // A value ends at its own closing tag; a missing one ends it at the next parameter or invoke (a value that runs into the next tag belongs to neither).
  const nextTag = `<\\s*${DSML_MARK}\\s*DSML\\s*${DSML_MARK}\\s*(?:parameter|invoke)\\b`;
  const parameter = new RegExp(`<\\s*${DSML_MARK}\\s*DSML\\s*${DSML_MARK}\\s*parameter\\s+name\\s*=\\s*["']([^"']+)["'](?:\\s+string\\s*=\\s*["'](true|false)["'])?\\s*>([\\s\\S]*?)(?:(<\\/\\s*${DSML_MARK}\\s*DSML\\s*${DSML_MARK}\\s*parameter\\s*>)|(?=${nextTag})|$)`, 'gi');
  const out = [];
  let match;
  while ((match = invoke.exec(source))) {
    let name = match[1];
    name = normalizeToolName(name, allowed);
    if (!name || (allowed && allowed.size && !allowed.has(name))) continue;
    const args = {};
    let p;
    parameter.lastIndex = 0;
    while ((p = parameter.exec(match[2]))) {
      const key = p[1];
      if (!key) continue;
      const flag = p[2];
      // a value never holds DSML markup: a piece of a tag too broken to read as one (a closer without its word) is cut off, not sent on in a path
      const value = p[3].replace(new RegExp(`<\\s*\\/?\\s*${DSML_MARK}\\s*DSML[\\s\\S]*$`, 'i'), '');
      const raw = p[4] && value === p[3] ? value : value.replace(/\s+$/, ''); // ended at the next tag: the whitespace before it belongs to the markup
      if (flag === 'true') { args[key] = raw; continue; }
      const parsed = tryJson(raw);
      args[key] = parsed == null ? raw : parsed;
    }
    out.push({ name, arguments: JSON.stringify(unwrapArguments(args)) });
  }
  return out;
}

/** The parameters a tool takes, and the ones it requires, from the request's own tool list. */
function paramsOf(tools, name) {
  const f = toolDefs(tools).find((d) => d.name === name);
  const schema = f && f.parameters && typeof f.parameters === 'object' ? f.parameters : {};
  return { known: new Set(Object.keys(schema.properties || {})), required: Array.isArray(schema.required) ? schema.required.map(String) : [], props: schema.properties || {} };
}

/** Whether a value is of the JSON type a schema names (a schema with no single type, or a type this does not know, takes anything). */
function ofType(value, type) {
  if (type === 'string') return typeof value === 'string';
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  return true;
}

/**
 * Arguments squashed into one value: the model escaped the quotes that hold the object together ({"filePath": "/a.css\\",\\"oldString\\":\\"...\\"}"}),
 * so the first value carries the rest of the object (seen 2026-10-28 on DeepSeek, an edit whose path held its old and new strings). Read back from that
 * value, only for a call that lacks a parameter it requires, and only when that gives the tool's own parameters.
 */
function unsquash(args, known) {
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== 'string' || !/",\s*"[A-Za-z_]\w*"\s*:/.test(value)) continue;
    const obj = closedJson(`{"${key}":"${value}${/"\s*}\s*$/.test(value) ? '' : '"}'}`);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
    if (Object.keys(obj).some((k) => k !== key && known.has(k) && !(k in args))) return { ...args, ...obj };
  }
  return args;
}

/** The required parameters a call lacks, or holds as the wrong type (a path given as true, seen 2026-10-28): an empty list when all are there. */
function missingOf(call, tools) {
  const { required, props } = paramsOf(tools, call.name);
  if (!required.length) return [];
  const args = parseArgs(call.arguments) || {};
  return required.filter((k) => args[k] == null || args[k] === '' || !ofType(args[k], props[k] && typeof props[k].type === 'string' ? props[k].type : null));
}

/** A call whose arguments lack a parameter its tool requires is mended where the rest of its object is in one value (unsquash); otherwise it is as it came. */
function mended(call, tools) {
  if (!missingOf(call, tools).length) return call;
  const args = parseArgs(call.arguments) || {};
  const fixed = unsquash(args, paramsOf(tools, call.name).known);
  return fixed === args ? call : { ...call, arguments: JSON.stringify(fixed) };
}

/**
 * The calls in an answer that still lack a parameter their tool requires, after mending: "edit (no filePath, oldString)". Such a call is never handed on
 * as it is: the bridge asks the chat again (engine.js), so the agent is not left to work out why its call arrived empty.
 */
function incompleteCalls(text, tools) {
  return parseAnswer(text, tools).calls.filter((c) => c.name !== 'think').map((c) => ({ name: c.name, missing: missingOf(c, tools) })).filter((c) => c.missing.length).map((c) => `${c.name} (no usable ${c.missing.join(', ')})`);
}

/** Splits the answer into tool calls and the words around them. Only tools the request offered are accepted. */
function parseAnswer(text, tools) {
  const found = splitAnswer(text, tools);
  return { ...found, calls: found.calls.map((c) => mended(c, tools)) };
}

function splitAnswer(text, tools) {
  const source = String(text || '');
  const allowed = new Set(toolDefs(tools).map((f) => f.name));
  // A request that offered no tools is a plain chat: nothing in its answer is a call, whatever shape it has (a JSON object with a "name" and "arguments", say).
  if (!allowed.size) return { calls: [], content: source };
  const calls = [];
  let cleaned = source;

  const tag = /<tool_call>\s*([\s\S]*?)(?:<\/tool_call>|$)/gi;
  let match;
  while ((match = tag.exec(source))) {
    const call = callFrom(match[1], allowed);
    if (call) calls.push(call);
  }
  if (calls.length) {
    cleaned = cleaned.replace(/<tool_call>\s*[\s\S]*?(?:<\/tool_call>|$)/gi, '');
    cleaned = cleaned.replace(/<\/?\s*(?:｜|\|)+\s*DSML[\s\S]*?>/gi, '');
  }

  if (!calls.length) {
    for (const block of dsmlBlocks(source)) {
      const found = callsInDsml(block.body, allowed);
      if (!found.length) continue;
      calls.push(...found);
      cleaned = cleaned.replace(block.full, '');
    }
  }

  if (!calls.length) {
    const wholeCalls = callsFrom(closedJson(source.trim()), allowed);
    if (wholeCalls.length) return { calls: wholeCalls, content: '' };
    const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
    let fenceMatch;
    while ((fenceMatch = fence.exec(source))) {
      const found = callsFrom(closedJson(fenceMatch[1]), allowed);
      if (!found.length) continue;
      calls.push(...found);
      cleaned = cleaned.replace(fenceMatch[0], '');
    }
  }

  if (!calls.length) {
    const embedded = embeddedCalls(source, allowed);
    if (embedded.calls.length) {
      calls.push(...embedded.calls);
      for (const [start, end] of embedded.spans.sort((a, b) => b[0] - a[0])) {
        cleaned = cleaned.slice(0, start) + cleaned.slice(end);
      }
    }
  }

  return { calls, content: cleaned.replace(/\n{3,}/g, '\n\n').trim() };
}

/**
 * The first index in text that might be the start of a tool-call marker and cannot be ruled out yet.
 * The live stream holds from there, so raw <tool_call> or DSML markup never reaches the transcript.
 * Ordinary text flows through immediately, except for the odd trailing '<' held for one chunk.
 */
function markerHold(text) {
  let at = text.indexOf('<');
  while (at !== -1) {
    const tail = text.slice(at).toLowerCase();
    if ('<tool_call>'.startsWith(tail) || tail.startsWith('<tool_call>')) return at;
    if (/^<\s*$/.test(tail)) return at;
    if (/^<\s*(?:｜|\|)+$/.test(tail)) return at;
    if (/^<\s*(?:｜+|\|{2,})/.test(tail)) return at; // a full-width bar is never plain text; a plain one is markup only twice over
    at = text.indexOf('<', at + 1);
  }
  return -1;
}

/**
 * The start of a bare JSON object in an answer that began with prose. A model sometimes thinks out loud
 * and then calls a tool, and the raw object must not reach the transcript.
 */
function bareHold(text) {
  let at = text.indexOf('{');
  while (at !== -1) {
    const tail = text.slice(at);
    if (/^\{\s*$/.test(tail) || /^\{\s*"/.test(tail)) return at;
    at = text.indexOf('{', at + 1);
  }
  return -1;
}

/** The start of a fenced call ("```json" and then the object, possibly still arriving): held so the fence never shows as text before the call is known. */
function fenceHold(text) {
  let at = text.indexOf('`');
  while (at !== -1) {
    if (/^`{1,3}(?:j(?:s(?:o(?:n)?)?)?)?\s*(?:\{[\s\S]*)?$/i.test(text.slice(at))) return at;
    at = text.indexOf('`', at + 1);
  }
  return -1;
}

const DSML_OPEN = new RegExp(`<\\s*${DSML_MARK}\\s*DSML\\s*${DSML_MARK}\\s*(?:calls|invoke)\\b`, 'i');
/** An answer that opens a tool call in the provider's own markup (a DSML block or <tool_call>), whether or not the call ends. */
function opensCall(source) {
  return DSML_OPEN.test(source) || /<tool_call>/i.test(source);
}

/**
 * An answer that is a tool call by its shape (it starts with the object {"name":...,"arguments":...}, bare or in a fence, or it opens a DSML block or
 * <tool_call>) but yields none: it was cut off, or its quotes and line breaks were not escaped. Such text is never shown as chat text. A long file written
 * in one call is the usual victim: the reply ends in the middle of the content and the call never closes (seen 2026-10-21 on DeepSeek, 19,000 characters of CSS).
 */
function unreadableCall(text, tools) {
  if (!toolDefs(tools).length) return false; // no tools offered: nothing can be a damaged call
  const source = String(text || '');
  const shaped = /^\s*(?:```(?:json)?\s*)?\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:/i.test(source) || opensCall(source);
  return shaped && parseAnswer(source, tools).calls.length === 0;
}
/**
 * Tool calls in an answer to a request that offered no tools: the model reached for tools it does not have here (Qoder's CLI is an agent, and the
 * model behind it asks to list folders and read files even when the request carries everything). Such an answer is not an answer: the engine asks
 * again once, saying so, and never passes the markup on as the reply. Answers the names of the tools it reached for, or [] when it reached for none.
 */
function strayCalls(text, tools) {
  if (toolDefs(tools).length) return [];
  // the answer IS a call: it opens with the call markup and names a tool to invoke. An answer that talks about the markup (it explains how a call
  // looks, a plain chat about tools) is text, and passes as it is
  const source = String(text || '').trimStart();
  const at = source.search(/<\s*(?:｜|\|)+\s*DSML|<tool_call>/i);
  if (at !== 0) return [];
  const names = [...source.matchAll(/invoke\s+name\s*=\s*"([^"]+)"/gi), ...source.matchAll(/"name"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
  return [...new Set(names)];
}
/** The question of a `think` request in an answer, or null when the answer makes none. */
function thinkRequest(text, tools) {
  const call = parseAnswer(text, tools).calls.find((c) => c.name === 'think');
  if (!call) return null;
  const args = parseArgs(call.arguments) || {};
  const question = String(args.question || '').replace(/\s+$/, '').trim();
  return { question: question || 'What is the best next step for the task?' };
}

function bodyHold(text, bare) {
  if (!bare) return markerHold(text);
  const marks = [markerHold(text), bareHold(text), fenceHold(text)].filter((n) => n >= 0);
  return marks.length ? Math.min(...marks) : -1;
}

module.exports = {
  buildPrompt, parseAnswer, incompleteCalls, markerHold, bareHold, fenceHold, bodyHold, opensCall, unreadableCall, strayCalls, thinkRequest, trailingRepeat, callSignature,
  bridgeSection, fencedBridgeSection, jsonInstruction, contentToText, createPictures, pictureOf, fileText, IMAGE_NOTE, IMAGE_MARK, parseArgs, taskKeyOf, withThoughts, toolDefs, hasFileTools, closedJson, tryJson,
  stableJson, fingerprint, conversationFingerprints, toolsKey
};
