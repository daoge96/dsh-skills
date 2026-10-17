#!/usr/bin/env node
/**
 * mux_normalize.mjs — normalize a WAV to a loudness/true-peak target and mux it
 * onto an already-encoded video with -c:v copy, then verify with a third,
 * independent measurement pass. ffmpeg/ffprobe only, no npm dependencies.
 * Child output is captured through file descriptors (sandbox-safe, no pipes).
 *
 *   node mux_normalize.mjs <video.mp4> <audio.wav> <out.mp4> [options]
 *
 * Options:
 *   --lufs <n>      integrated target, default -14
 *   --tp <n>        true-peak ceiling in dBTP, default -1
 *   --lra <n>       loudness range target, default 11
 *   --abr <rate>    AAC bitrate, default 320k
 *   --ar <hz>       sample rate, default 48000
 *   --tolerance <n> allowed |measured - target| in LU, default 0.5
 *   --tmp <dir>     scratch directory
 *   --json          machine-readable output only
 *
 * Exit 0 = muxed and verified, 1 = a check failed, 2 = usage/tool error.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const [videoArg, wavArg, outArg] = argv;
if (!videoArg || !wavArg || !outArg || videoArg.startsWith('-')) { console.error('usage: node mux_normalize.mjs <video> <audio.wav> <out.mp4> [--lufs -14 --tp -1 --abr 320k]'); process.exit(2); }
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const video = path.resolve(videoArg), wav = path.resolve(wavArg), out = path.resolve(outArg);
const LUFS = parseFloat(opt('lufs', '-14'));
const TP = parseFloat(opt('tp', '-1'));
const LRA = parseFloat(opt('lra', '11'));
const ABR = opt('abr', '320k');
const AR = opt('ar', '48000');
const TOL = parseFloat(opt('tolerance', '0.5'));
const JSON_ONLY = argv.includes('--json');

const TMP = (() => {
  for (const d of [opt('tmp', null), path.join(os.tmpdir(), `mux_${process.pid}`), path.join(path.dirname(out), '.mux-tmp')].filter(Boolean)) {
    try { fs.mkdirSync(d, { recursive: true }); return d; } catch { /* next */ }
  }
  return path.dirname(out);
})();

let seq = 0;
function runCapture(cmd, a, { allowFail = false } = {}) {
  const tag = path.join(TMP, `cap${++seq}`);
  const fdOut = fs.openSync(tag + '.txt', 'w'), fdErr = fs.openSync(tag + '.err', 'w');
  let r;
  try { r = spawnSync(cmd, a, { stdio: ['ignore', fdOut, fdErr], windowsHide: true }); }
  finally { fs.closeSync(fdOut); fs.closeSync(fdErr); }
  const outTxt = fs.readFileSync(tag + '.txt', 'utf8'), errTxt = fs.readFileSync(tag + '.err', 'utf8');
  fs.rmSync(tag + '.txt', { force: true }); fs.rmSync(tag + '.err', { force: true });
  if (r.error) { if (allowFail) return { status: -1, out: outTxt, err: String(r.error.message) }; throw r.error; }
  if (r.status !== 0 && !allowFail) throw new Error(`${path.basename(cmd)} failed (${r.status}): ${errTxt.slice(-400)}`);
  return { status: r.status ?? 0, out: outTxt, err: errTxt };
}
function resolveTool(kind) {
  const env = process.env[kind === 'ffprobe' ? 'FFPROBE' : 'FFMPEG'];
  const exe = process.platform === 'win32' ? '.exe' : '';
  for (const c of [env, `/usr/bin/${kind}`, `/usr/local/bin/${kind}`, `D:/ffmpeg-dl/bin/${kind}${exe}`, kind].filter(Boolean)) {
    const r = spawnSync(c, ['-version'], { stdio: 'ignore', windowsHide: true });
    if (!r.error && r.status === 0) return c;
  }
  console.error(`[mux] cannot run ${kind}; set $FFMPEG/$FFPROBE or PATH`); process.exit(2);
}
const FFMPEG = resolveTool('ffmpeg');
const FFPROBE = resolveTool('ffprobe');

const normalized = path.join(TMP, 'normalized.wav');
const probeJson = (f) => JSON.parse(runCapture(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', f]).out);
const measure = (f) => {
  const r = runCapture(FFMPEG, ['-v', 'info', '-i', f, '-af', `loudnorm=I=${LUFS}:TP=${TP}:LRA=${LRA}:print_format=json`, '-f', 'null', '-'], { allowFail: true });
  const blocks = r.err.match(/\{[^{}]*"input_i"[^{}]*\}/g);
  return blocks ? JSON.parse(blocks[blocks.length - 1]) : null;
};

/* pass 1 — measure the source */
const m1 = measure(wav);
if (!m1) { console.error('[mux] pass 1 produced no measurement'); process.exit(1); }
if (!JSON_ONLY) console.log(`[mux] input ${m1.input_i} LUFS / ${m1.input_tp} dBTP`);

/* pass 2 — linear normalize */
runCapture(FFMPEG, ['-v', 'error', '-y', '-i', wav, '-af',
  `loudnorm=I=${LUFS}:TP=${TP}:LRA=${LRA}:linear=true:measured_I=${m1.input_i}:measured_TP=${m1.input_tp}:measured_LRA=${m1.input_lra}:measured_thresh=${m1.input_thresh}:offset=${m1.target_offset ?? 0}`,
  '-ar', AR, '-ac', '2', '-c:a', 'pcm_s16le', normalized]);

/* pass 3 — mux (video stream copied) */
runCapture(FFMPEG, ['-v', 'error', '-y', '-i', video, '-i', normalized, '-map', '0:v:0', '-map', '1:a:0',
  '-c:v', 'copy', '-c:a', 'aac', '-b:a', ABR, '-aac_coder', 'twoloop', '-ar', AR, '-ac', '2', '-shortest', out]);

/* independent verification */
const meta = probeJson(out), vIn = probeJson(video);
const vS = (meta.streams || []).find((s) => s.codec_type === 'video');
const aS = (meta.streams || []).find((s) => s.codec_type === 'audio');
const vInS = (vIn.streams || []).find((s) => s.codec_type === 'video');
const m2 = measure(out);

const checks = {
  has_video: !!vS, has_audio: !!aS,
  video_codec_copied: !!vS && vS.codec_name === vInS?.codec_name,
  duration_seconds: +parseFloat(meta.format.duration).toFixed(3),
  duration_preserved: Math.abs(parseFloat(meta.format.duration) - parseFloat(vIn.format.duration)) < 0.05,
  audio_codec: aS?.codec_name ?? null, audio_rate: aS?.sample_rate ?? null,
  audio_bitrate_kbps: aS ? Math.round(Number(aS.bit_rate || 0) / 1000) : null,
  integrated_lufs: m2 ? +parseFloat(m2.input_i).toFixed(2) : null,
  true_peak_dbtp: m2 ? +parseFloat(m2.input_tp).toFixed(2) : null,
};
const fails = [];
const notes = [];
if (checks.audio_bitrate_kbps && /k$/.test(ABR) && checks.audio_bitrate_kbps < 0.85 * parseFloat(ABR)) {
  notes.push(`AAC averaged ${checks.audio_bitrate_kbps} kbps against a ${ABR} target: -b:a is a target for ffmpeg native AAC, not a floor`);
}
if (!checks.has_audio) fails.push('no audio stream in output');
if (!checks.has_video) fails.push('no video stream in output');
if (!checks.duration_preserved) fails.push('duration changed during mux');
if (checks.integrated_lufs === null || Math.abs(checks.integrated_lufs - LUFS) > TOL) fails.push(`integrated loudness off target (${checks.integrated_lufs} vs ${LUFS} +/- ${TOL})`);
if (checks.true_peak_dbtp === null || checks.true_peak_dbtp > TP + 1e-6) fails.push(`true peak above ${TP} dBTP (${checks.true_peak_dbtp})`);

const ok = fails.length === 0;
if (!JSON_ONLY) { console.log(JSON.stringify({ out, ...checks, pass: ok, fails, notes }, null, 1)); console.log(ok ? 'VERDICT PASS' : 'VERDICT FAIL'); }
else console.log(JSON.stringify({ out, ...checks, pass: ok, fails, notes }));
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* keep */ }
process.exit(ok ? 0 : 1);
