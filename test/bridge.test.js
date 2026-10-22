'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPrompt, parseAnswer, markerHold, unreadableCall, fencedBridgeSection, jsonInstruction, trailingRepeat } = require('../src/bridge');

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'write',
      description: 'Write a whole file to disk',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Relative path to file' },
          content: { type: 'string', description: 'File content' }
        },
        required: ['filePath', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read',
      description: 'Read a file from disk',
      parameters: {
        type: 'object',
        properties: { filePath: { type: 'string', description: 'Relative path to file' } },
        required: ['filePath']
      }
    }
  }
];

const WEATHER = [{
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Current weather for a city',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
  }
}];

test('buildPrompt: includes system prompt, tool schemas, assistant tool calls, and named tool results', () => {
  const messages = [
    { role: 'system', content: 'You are a senior fullstack engineer.' },
    { role: 'user', content: 'Create a hello world page.' },
    {
      role: 'assistant',
      content: 'I will write the file.',
      tool_calls: [{ id: 'call_123', type: 'function', function: { name: 'write', arguments: JSON.stringify({ filePath: 'index.html', content: '<h1>Hello</h1>' }) } }]
    },
    { role: 'tool', tool_call_id: 'call_123', content: 'File index.html written successfully.' }
  ];
  const prompt = buildPrompt(messages, TOOLS);
  assert.ok(prompt.includes('You are a senior fullstack engineer.'), 'system prompt must be present in prompt');
  assert.ok(prompt.includes('# Tool bridge'), 'tool bridge section header must be present');
  assert.ok(prompt.includes('### write'), 'write tool definition must be present');
  assert.ok(prompt.includes('### read'), 'read tool definition must be present');
  assert.ok(prompt.includes('filePath'), 'tool parameter schema must be present');
  assert.ok(prompt.includes('ASSISTANT:\nI will write the file.'), 'assistant text must be present');
  assert.ok(prompt.includes('<tool_call>{"name":"write","arguments":{"filePath":"index.html","content":"<h1>Hello</h1>"}}</tool_call>'), 'replayed tool_call block must be present');
  assert.ok(prompt.includes('TOOL RESULT (write):\nFile index.html written successfully.'), 'tool result with tool name must be present');
});

test('parseAnswer: extracts single and multiple tool_call blocks', () => {
  const single = 'I will write the file now.\n<tool_call>{"name":"write","arguments":{"filePath":"index.html","content":"hello"}}</tool_call>';
  const parsedSingle = parseAnswer(single, TOOLS);
  assert.equal(parsedSingle.calls.length, 1);
  assert.equal(parsedSingle.calls[0].name, 'write');
  assert.deepEqual(JSON.parse(parsedSingle.calls[0].arguments), { filePath: 'index.html', content: 'hello' });
  assert.equal(parsedSingle.content, 'I will write the file now.');

  const multiple = '<tool_call>{"name":"write","arguments":{"filePath":"index.html","content":"hello"}}</tool_call>\nSome notes.\n<tool_call>{"name":"read","arguments":{"filePath":"styles.css"}}</tool_call>';
  const parsedMultiple = parseAnswer(multiple, TOOLS);
  assert.equal(parsedMultiple.calls.length, 2);
  assert.equal(parsedMultiple.calls[0].name, 'write');
  assert.equal(parsedMultiple.calls[1].name, 'read');
  assert.deepEqual(JSON.parse(parsedMultiple.calls[1].arguments), { filePath: 'styles.css' });
  assert.equal(parsedMultiple.content, 'Some notes.');
});

test('parseAnswer: accepts native DSML tool call blocks', () => {
  const dsml = 'Let me create the index file:\n<｜｜DSML｜｜calls><｜｜DSML｜｜invoke name="write"><｜｜DSML｜｜parameter name="filePath" string="true">index.html</｜｜DSML｜｜parameter><｜｜DSML｜｜parameter name="content" string="true"><h1>Sunrise</h1></｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜calls>';
  const parsed = parseAnswer(dsml, TOOLS);
  assert.equal(parsed.calls.length, 1);
  assert.equal(parsed.calls[0].name, 'write');
  assert.deepEqual(JSON.parse(parsed.calls[0].arguments), { filePath: 'index.html', content: '<h1>Sunrise</h1>' });
  assert.equal(parsed.content, 'Let me create the index file:');
});

test('parseAnswer: accepts fenced JSON and whole-response JSON tool calls', () => {
  const fenced = '```json\n{"name":"write","arguments":{"filePath":"app.js","content":"console.log(1)"}}\n```';
  const parsedFenced = parseAnswer(fenced, TOOLS);
  assert.equal(parsedFenced.calls.length, 1);
  assert.deepEqual(JSON.parse(parsedFenced.calls[0].arguments), { filePath: 'app.js', content: 'console.log(1)' });
  assert.equal(parsedFenced.content, '');

  const whole = '{"name":"read","arguments":{"filePath":"package.json"}}';
  const parsedWhole = parseAnswer(whole, TOOLS);
  assert.equal(parsedWhole.calls.length, 1);
  assert.equal(parsedWhole.calls[0].name, 'read');
  assert.equal(parsedWhole.content, '');
});

test('parseAnswer: rejects tools that were never offered', () => {
  const unoffered = '<tool_call>{"name":"delete_everything","arguments":{"target":"all"}}</tool_call>';
  const parsed = parseAnswer(unoffered, TOOLS);
  assert.equal(parsed.calls.length, 0, 'unoffered tool must not be returned in calls');
  assert.ok(parsed.content.includes('delete_everything'), 'unoffered tool remains in content text');
});

test('parseAnswer: repairs a call that lost its closing characters, but never a call cut inside its content', () => {
  const lostTail = '<tool_call>{"name":"read","arguments":{"filePath":"a.txt"';
  assert.equal(parseAnswer(lostTail, TOOLS).calls.length, 1);
  const cutInContent = '<tool_call>{"name":"write","arguments":{"filePath":"a.txt","content":"half of the fi';
  assert.equal(parseAnswer(cutInContent, TOOLS).calls.length, 0);
  assert.equal(unreadableCall(cutInContent, TOOLS), true, 'a cut-off call is flagged so the bridge can ask again');
});

// ---- the class: what the REQUEST offered decides everything --------------------------------------------------------------------------------------
// A request with no tools is a plain chat. Nothing in its answer may be read as a tool call, and nothing about tools may be said to the model.

test('no tools offered: an answer shaped like a tool call is just text', () => {
  for (const answer of [
    '{"name":"Ada","arguments":{"age":36}}',
    '```json\n{"name":"Ada","arguments":{"age":36}}\n```',
    'Here you go: {"name":"Ada","arguments":{"age":36}}',
    '<tool_call>{"name":"write","arguments":{"filePath":"a","content":"b"}}</tool_call>'
  ]) {
    const parsed = parseAnswer(answer, []);
    assert.equal(parsed.calls.length, 0, `read a call out of: ${answer}`);
    assert.equal(parsed.content, answer, 'the answer must come back untouched');
  }
});

test('no tools offered: talking about the call format is not a damaged call', () => {
  const answer = 'Wrap each call in <tool_call> tags, then close it with </tool_call>.';
  assert.equal(unreadableCall(answer, []), false);
  assert.equal(unreadableCall('{"name":"x","arguments":', []), false);
});

test('buildPrompt: a plain question goes as it is, with the system text first', () => {
  assert.equal(buildPrompt([{ role: 'user', content: 'Why is the sky blue?' }], []), 'Why is the sky blue?');
  assert.equal(buildPrompt([{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Why is the sky blue?' }], []), 'Be brief.\n\nWhy is the sky blue?');
});

test('buildPrompt: an explicit closing line always wins, even over the plain shortcut', () => {
  const prompt = buildPrompt([{ role: 'user', content: 'Design me a page' }], [], { closing: 'THINK ABOUT THIS' });
  assert.ok(prompt.includes('USER:\nDesign me a page'));
  assert.ok(prompt.trim().endsWith('THINK ABOUT THIS'));
});

test('buildPrompt: a plain multi-turn chat says nothing about tools', () => {
  const prompt = buildPrompt([
    { role: 'user', content: 'Hi' },
    { role: 'assistant', content: 'Hello!' },
    { role: 'user', content: 'Write me a function' }
  ], []);
  assert.ok(prompt.includes('USER:\nHi') && prompt.includes('ASSISTANT:\nHello!'));
  assert.ok(!/tool/i.test(prompt), `the prompt mentions tools: ${prompt}`);
  assert.ok(prompt.trim().endsWith('Answer the latest USER message now.'));
});

test('buildPrompt: the rules follow the tools that were offered', () => {
  const weather = buildPrompt([{ role: 'user', content: 'Weather in Dar es Salaam, and write me a python loop' }], WEATHER);
  assert.ok(weather.includes('### get_weather'));
  assert.ok(!/raw code/i.test(weather), 'a request with no file tool must stay free to answer with code in the chat');
  assert.ok(!/"write"|"edit"/.test(weather), 'the file tools are only named when they were offered');
  assert.ok(/only when the request needs one/i.test(weather), 'the model is told a tool is optional');
  const files = buildPrompt([{ role: 'user', content: 'Make a page' }], TOOLS);
  assert.ok(/raw code/i.test(files), 'an agent with file tools is told to deliver code through them');
});

test('buildPrompt: the fenced bridge (Gemini) follows the offered tools too', () => {
  const weather = fencedBridgeSection(WEATHER, { fileChars: 2500 });
  assert.ok(weather.includes('```json') && weather.includes('### get_weather'));
  assert.ok(!/Keep every file/.test(weather) && !/raw code/i.test(weather));
  assert.ok(/Keep every file under about 2,500/.test(fencedBridgeSection(TOOLS, { fileChars: 2500 })));
});

test('buildPrompt: JSON mode is asked for in words, with the schema when there is one', () => {
  assert.match(jsonInstruction({ type: 'json_object' }), /valid JSON/);
  assert.match(jsonInstruction({ type: 'json_schema', json_schema: { schema: { type: 'object' } } }), /SCHEMA: \{"type":"object"\}/);
  assert.equal(jsonInstruction({ type: 'text' }), '');
  const prompt = buildPrompt([{ role: 'user', content: 'List two colours' }], [], { jsonMode: { type: 'json_object' } });
  assert.match(prompt, /valid JSON value only/);
});

test('buildPrompt: a tool result with no tools offered still continues the conversation', () => {
  const prompt = buildPrompt([
    { role: 'user', content: 'Hi' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' }
  ], []);
  assert.ok(prompt.trim().endsWith('Continue the conversation now.'));
});

test('trailingRepeat: counts the same call on the same target, and a message from the person ends the run', () => {
  // a file's contents differ on every pass of a loop and are long, so they are left out of what a call aims at; its path is what counts
  const call = (id) => ({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'write', arguments: JSON.stringify({ filePath: 'a.txt', content: `${id}:${'x'.repeat(300)}` }) } }] });
  const result = (id) => ({ role: 'tool', tool_call_id: id, content: 'ok' });
  const loop = [{ role: 'user', content: 'go' }, call('1'), result('1'), call('2'), result('2'), call('3'), result('3')];
  assert.equal(trailingRepeat(loop).count, 3);
  assert.equal(trailingRepeat([...loop, { role: 'user', content: 'continue' }]).count, 0);
});

test('markerHold: holds partial and complete markers', () => {
  assert.equal(markerHold('Here is <'), 8, 'single trailing < held');
  assert.equal(markerHold('Here is <tool'), 8, 'partial <tool held');
  assert.equal(markerHold('prefix <tool_call'), 7, 'partial <tool_call held');
  assert.equal(markerHold('prefix <tool_call>'), 7, 'complete <tool_call> held');
});

test('markerHold: releases ordinary < text and non-marker tags like <tool_div>', () => {
  assert.equal(markerHold('Comparison: 5 < 10 and 20 > 15'), -1);
  assert.equal(markerHold('<div>content</div>'), -1);
  assert.equal(markerHold('Here is a <tool_div> element'), -1);
  assert.equal(markerHold('Clean paragraph without tags'), -1);
});

test('markerHold: handles fullwidth bars and ascii bars', () => {
  assert.equal(markerHold('prefix <｜'), 7);
  assert.equal(markerHold('prefix <｜｜DSML'), 7);
  assert.equal(markerHold('prefix <||DSML'), 7);
});

test('markerHold: raw tool markup is never emitted when held text is stripped', () => {
  const streamChunks = ['Starting now: ', '<tool', '_call>{"name":"write"}', '</tool_call> Done.'];
  let accumulator = '';
  let emitted = '';
  for (const chunk of streamChunks) {
    accumulator += chunk;
    const holdIndex = markerHold(accumulator);
    if (holdIndex === -1) {
      emitted += accumulator;
      accumulator = '';
    } else {
      emitted += accumulator.slice(0, holdIndex);
      accumulator = accumulator.slice(holdIndex);
    }
  }
  assert.ok(!emitted.includes('<tool'), 'emitted text must not contain a partial <tool');
  assert.equal(emitted, 'Starting now: ');
});
