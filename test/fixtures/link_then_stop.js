'use strict';
// Run by a test as a separate process: start linking a Gemini account, then stop the provider. The process must then be free to exit on its own.
const { createConfig } = require('../../src/config');
const { createGeminiProvider } = require('../../src/providers/gemini');

(async () => {
  const [dir, appUrl] = process.argv.slice(2);
  const provider = createGeminiProvider({ dataDir: dir, config: createConfig({ dataDir: dir }), appUrl, plainChromeArgs: ['--headless=new'] });
  const started = await provider.startLink({ consentAcknowledged: true });
  if (!started.ok) { process.stdout.write(`link failed: ${JSON.stringify(started)}\n`); process.exit(2); }
  await provider.stop();
  process.stdout.write('stopped\n');
})();
