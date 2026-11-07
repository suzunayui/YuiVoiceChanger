// Runs the JavaScript config code over many inputs and saves the results.
// crates/yvc-core/tests/config_parity.rs checks that the Rust gives the same answers.
const fs = require('node:fs');
const path = require('node:path');
const { normalize, liveControls } = require('../electron/config.cjs');
const { adoptManualTiming, latencySignature } = require('../electron/manual-delay.cjs');

const icon = 'a'.repeat(64);
const long = count => 'x'.repeat(count);
const inputs = [
  {}, { beatrice_pitch: 3 }, { beatrice_pitch: 24 }, { beatrice_pitch: 25 }, { beatrice_pitch: -24 }, { beatrice_pitch: -25 }, { beatrice_pitch: 1.5 }, { beatrice_pitch: '3' }, { beatrice_pitch: null }, { beatrice_pitch: true },
  { beatrice_voice: 0 }, { beatrice_voice: 65535 }, { beatrice_voice: 65536 }, { beatrice_voice: 1.5 }, { beatrice_voice: -1 },
  { beatrice_formant: 0.5 }, { beatrice_formant: 0.25 }, { beatrice_formant: 2 }, { beatrice_formant: 2.5 }, { beatrice_formant: -2 },
  { input_gain: 18 }, { input_gain: 19 }, { input_gain: -12 }, { input_gain: -13 }, { input_gain: 1.5 },
  { gain: 18 }, { gain: 19 }, { gain: 30 }, { gain: 30, beatrice_vst: 'x' }, { gain: 31, beatrice_vst: 'x' }, { gain: 19, engine_version: 2, beatrice_vst: 'x' },
  { input: -1 }, { input: 5 }, { input: 1.5 }, { input: -2 }, { input: 65536 }, { output: 3 }, { output: 1.5 }, { output: '1' },
  { engine_version: 2 }, { engine_version: 1 }, { engine_version: '2' },
  { beatrice_block: 0.08 }, { beatrice_block: 0.1 }, { beatrice_block: 0.1, beatrice_libs: 'x' }, { schedule_ms: 160 }, { schedule_ms: 100 }, { schedule_ms: 100, beatrice_libs: 'x' },
  { beatrice_model: 'C:\\m\\a.pt.gz' }, { beatrice_model: 'C:\\m\\a.toml' }, { beatrice_model: 'C:\\m\\a.TOML', engine_version: 2 }, { beatrice_model: 'C:\\m\\a.toml', gain: 25, python: 'p.exe', input_gain: 3 },
  { beatrice_model: 5 }, { python: 'C:\\p\\python.exe' }, { python: 5 },
  { beatrice_model_alias: 'ゆい' }, { beatrice_model_alias: long(80) }, { beatrice_model_alias: long(81) }, { beatrice_model_alias: 'a\nb' }, { beatrice_model_alias: 'a\u007fb' }, { beatrice_model_alias: '😀'.repeat(40) }, { beatrice_model_alias: '😀'.repeat(41) },
  { beatrice_model_icon: '' }, { beatrice_model_icon: icon }, { beatrice_model_icon: 'A'.repeat(64) }, { beatrice_model_icon: 'abc' },
  { compute: 'auto' }, { compute: 'cpu' }, { compute: 'cuda' }, { compute: 'cuda:0' }, { compute: 'cuda:12345' }, { compute: 'cuda:123456' }, { compute: 'cuda:01' }, { compute: 'metal' }, { compute: '' }, { compute: 1 },
  { singing_enabled: true }, { singing_enabled: 1 }, { singing_latency_ms: 200 }, { singing_latency_ms: 199 }, { singing_latency_ms: 2000 }, { singing_latency_ms: 2001 }, { singing_latency_ms: 300.5 },
  { fx_enabled: true }, { fx_lowcut: 0 }, { fx_lowcut: 200 }, { fx_lowcut: 201 }, { fx_lowcut: 10.5 }, { fx_brightness: -6 }, { fx_brightness: 7 }, { fx_compressor: 100 }, { fx_compressor: 101 }, { fx_deesser: -1 }, { fx_reverb: 50 }, { fx_reverb: 51 }, { fx_echo: 51 }, { fx_echo_ms: 79 }, { fx_echo_ms: 80 }, { fx_echo_ms: 1000 }, { fx_echo_ms: 1001 }, { fx_limiter: false }, { fx_limiter: 0 },
  { obs_enabled: true }, { obs_port: 1 }, { obs_port: 0 }, { obs_port: 65535 }, { obs_port: 65536 }, { obs_port: 4455.5 }, { obs_input_uuid: 'u' }, { obs_input_name: long(512) }, { obs_input_name: long(513) }, { obs_input_name: 'a\tb' }, { obs_correction_ms: 1000 }, { obs_correction_ms: 1001 }, { obs_correction_ms: -1000 }, { obs_correction_ms: 1.5 }, { obs_delay_manual: true }, { obs_path_delay_ms: -1001 }, { obs_path_delay_ms: 5 }, { obs_path_signature: long(8192) }, { obs_path_signature: long(8193) }, { obs_video_enabled: true }, { obs_video_correction_ms: 1000 }, { obs_video_correction_ms: 1001 }, { obs_video_correction_ms: 0.5 },
  { obs_video_sources: [] }, { obs_video_sources: 'x' }, { obs_video_sources: null }, { obs_video_sources: [{}] }, { obs_video_sources: [null] }, { obs_video_sources: [[]] }, { obs_video_sources: [{ id: 'a', inputUuid: 'u', inputName: 'n', offset_ms: 5 }] }, { obs_video_sources: [{ id: 'a b' }] }, { obs_video_sources: [{ id: 'a' }, { id: 'a' }] }, { obs_video_sources: [{ inputUuid: 'u' }, { inputUuid: 'u' }] }, { obs_video_sources: [{ inputName: 'n' }, { inputName: 'n' }] }, { obs_video_sources: [{ inputName: 'n' }, { inputUuid: 'n' }] }, { obs_video_sources: [{ offset_ms: 1001 }] }, { obs_video_sources: [{ offset_ms: 1.5 }] }, { obs_video_sources: [{ inputName: 'a\nb' }] }, { obs_video_sources: [{ inputName: 5 }] }, { obs_video_sources: Array.from({ length: 8 }, () => ({})) }, { obs_video_sources: Array.from({ length: 9 }, () => ({})) },
  { obs_video_uuid: 'u', obs_video_name: 'n' }, { obs_video_name: 'n' }, { obs_video_uuid: '' },
  { mix_enabled: true }, { mix_enabled: true, singing_enabled: false }, { mix_latency_ms: 200 }, { mix_latency_ms: 199 }, { mix_latency_ms: 3000 }, { mix_latency_ms: 3001 }, { mix_latency_ms: 200.5 }, { mix_music_gain: 6 }, { mix_music_gain: 7 }, { mix_music_gain: -24 }, { mix_music_gain: -25 }, { mix_music_gain: 1.5 }, { mix_device_id: 'x' }, { mix_device_name: long(513) }, { mix_voice_name: 'a\nb' }, { mix_voice_uuid: 5 },
  { teacher_pitch: 25 }, { training_steps: 1 }, { training_steps: 0 }, { training_steps: 100000 }, { training_steps: 100001 }, { training_steps: 1.5 }, { training_source: 'a.pth' }, { training_audio: 'd' }, { hotkeys_enabled: true }, { hotkeys_enabled: 'yes' },
  { unknown_key: 1 }, { beatrice_pitch: 5, unknown_key: 'x' },
];

function attempt(run) {
  try {
    return { ok: run() };
  } catch (error) {
    return { error: error.message };
  }
}

const base = normalize({});
const liveCases = [
  [{}, 'stopped'], [{}, 'running'], [{ beatrice_pitch: 5 }, 'stopped'], [{ beatrice_pitch: 5 }, 'running'], [{ beatrice_pitch: 5 }, 'loading'], [{ gain: 3 }, 'running'], [{ input_gain: 3 }, 'running'], [{ beatrice_formant: 1 }, 'running'],
  [{ fx_reverb: 10 }, 'running'], [{ fx_enabled: true }, 'running'], [{ mix_music_gain: -3 }, 'running'], [{ beatrice_model: 'x' }, 'running'], [{ input: 3 }, 'running'], [{ compute: 'cpu' }, 'running'], [{ singing_latency_ms: 500 }, 'running'],
  [{ obs_port: 5000 }, 'running'], [{ obs_correction_ms: 5 }, 'running'], [{ beatrice_model_alias: 'x' }, 'running'], [{ beatrice_model_icon: icon }, 'running'], [{ hotkeys_enabled: true }, 'running'], [{ mix_enabled: true }, 'running'], [{ beatrice_pitch: 5, input: 3 }, 'running'],
];

const singing = normalize({ singing_enabled: true, singing_latency_ms: 400, obs_correction_ms: 100 });
const manualConfig = { ...singing, obs_delay_manual: true };
const timing = extra => ({ previous_base_ms: 400, previous_correction_ms: 100, singing_latency_ms: 450, obs_correction_ms: 50, ...extra });
const signature = latencySignature(singing);
const timingCases = [
  [singing, timing()], [manualConfig, timing()], [manualConfig, null], [manualConfig, timing({ singing_latency_ms: 460 })], [manualConfig, timing({ previous_base_ms: 401 })], [manualConfig, timing({ previous_correction_ms: 1 })],
  [manualConfig, timing({ singing_latency_ms: 199, obs_correction_ms: 301 })], [manualConfig, timing({ singing_latency_ms: 2001 })], [manualConfig, timing({ obs_correction_ms: 1001 })], [manualConfig, timing({ singing_latency_ms: 450.5, obs_correction_ms: 49.5 })],
  [normalize({}), timing()],
  [singing, timing({ legacy_timing: true, obs_correction_ms: 0 })], [manualConfig, timing({ legacy_timing: true, obs_correction_ms: 0 })], [singing, timing({ legacy_timing: true, obs_correction_ms: 5 })],
  [singing, timing({ legacy_timing: true, singing_latency_ms: 300, obs_correction_ms: 0 })],
  [{ ...singing, obs_path_signature: signature, obs_path_delay_ms: 50 }, timing({ legacy_timing: true, obs_correction_ms: 50 })],
];
const signatureCases = [
  normalize({}), normalize({ beatrice_model: 'm.pt', beatrice_voice: 2, compute: 'cpu', input: 3, output: 4, obs_port: 5000, obs_input_uuid: 'u', obs_input_name: 'n' }),
  normalize({ input: 3, input_name: 'mic', output: 4, output_name: 'out', obs_input_name: 'n' }),
];

const results = {
  normalize: inputs.map(input => ({ input, result: attempt(() => normalize(input)) })),
  importing: inputs.map(input => ({ input, result: attempt(() => normalize(input, { importing: true })) })),
  notObjects: [null, [], 'x', 5, true].map(input => ({ input, result: attempt(() => normalize(input)) })),
  live: liveCases.map(([change, state]) => ({ change, state, result: attempt(() => liveControls(base, { ...base, ...change }, state)) })),
  timing: timingCases.map(([config, value]) => ({ config, timing: value, result: adoptManualTiming(config, value) })),
  signature: signatureCases.map(config => ({ config, result: latencySignature(config) })),
};
const output = path.join(__dirname, '..', 'crates', 'yvc-core', 'tests', 'fixtures', 'config-parity.json');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(results)}\n`);
console.log(`${results.normalize.length} inputs, ${results.live.length} live cases, ${results.timing.length} timing cases`);
