// The official OpenAI Node SDK, pointed at the local server. npm install openai
import OpenAI from 'openai';

const client = new OpenAI({ baseURL: process.env.ULA_BASE ?? 'http://localhost:8420/v1', apiKey: process.env.ULA_KEY });
const model = process.env.MODEL ?? 'deepseek-chat';

const reply = await client.chat.completions.create({ model, messages: [{ role: 'user', content: 'Say hello in five words.' }] });
console.log(reply.choices[0].message.content);

const stream = await client.chat.completions.create({ model, stream: true, messages: [{ role: 'user', content: 'Write a haiku about rain.' }] });
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
process.stdout.write('\n');
