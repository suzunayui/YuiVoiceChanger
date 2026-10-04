// Opt-in hardware test. Uses the configured microphone, model and output.
// Never records audio; all settings writes go to a temporary test profile.
// Run: node tests/desktop-audio.cjs <path-to-desktop.json>
const {_electron: electron} = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');

async function until(page, predicate, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate)) return;
    await delay(100);
  }
  throw Error('Audio test timed out: ' + JSON.stringify(await page.evaluate(() => window.audioEvents)));
}

(async () => {
  if (!process.argv[2]) throw Error('Provide an explicit desktop.json path to enable the hardware test.');
  const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8').replace(/^\uFEFF/, ''));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yvc-audio-'));
  fs.writeFileSync(path.join(home, 'desktop.json'), JSON.stringify(config));
  let app;
  try {
    app = await electron.launch({args: [path.resolve(__dirname, '..')], env: {...process.env, YVC_DESKTOP_HOME: home}});
    const page = await app.firstWindow();
    page.setDefaultTimeout(10000);
    await page.getByRole('heading', {name: '声に、もうひとつの表情を。'}).waitFor();
    await page.evaluate(() => {
      window.audioEvents = [];
      window.yvc.subscribe(event => window.audioEvents.push(event));
      return window.yvc.invoke('devices');
    });
    await until(page, () => window.audioEvents.some(e => e.type === 'devices'));
    for (let cycle = 0; cycle < 2; cycle++) {
      await page.evaluate(count => { window.audioEvents = []; window.testMetricsCount = count; }, Number(process.env.YVC_TEST_METRICS || 15));
      await page.getByRole('button', {name: /声変換をはじめる/}).click();
      await until(page, () => window.audioEvents.some(e => e.state === 'running' || e.type === 'error'));
      let events = await page.evaluate(() => window.audioEvents);
      assert.equal(events.find(e => e.type === 'error'), undefined, JSON.stringify(events));
      await until(page, () => window.audioEvents.filter(e => e.type === 'metrics').length >= (window.testMetricsCount || 15), 60000);
      events = await page.evaluate(() => window.audioEvents);
      assert.equal(events.find(e => e.type === 'error'), undefined);
      const metrics = events.filter(e => e.type === 'metrics');
      assert(metrics.every(e => Number.isFinite(e.ms)));
      console.log(JSON.stringify({cycle: cycle + 1, running: events.find(e => e.state === 'running'), last: metrics.at(-1)}));
      await page.getByRole('button', {name: /停止する/}).click();
      await until(page, () => window.audioEvents.some(e => e.state === 'stopped'));
      await page.getByRole('button', {name: /声変換をはじめる/}).waitFor();
    }
    console.log('PASS: first start with idle IPC, native stream metrics, stop, and restart');
  } catch (error) {
    const log = path.join(home, 'logs', 'independent-engine.log');
    if (fs.existsSync(log)) console.error(fs.readFileSync(log, 'utf8'));
    throw error;
  } finally {
    if (app) await app.close();
    fs.rmSync(home, {recursive: true, force: true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
