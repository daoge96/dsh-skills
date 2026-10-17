#!/usr/bin/env node
/**
 * av_audit.mjs — read-only QC for a finished video artifact. ffmpeg/ffprobe only,
 * no npm dependencies.
 *
 *   node av_audit.mjs <video> [options]
 *
 * Checks: container metadata vs expectations · per-frame motion series and the
 * longest "nothing moved" run · first-vs-last-frame (loop seam) · integrated
 * loudness + true peak · optional contact sheets for human review.
 *
 * Child processes are captured through file descriptors (not pipes), so it also
 * works inside a confined sandbox where piped stdio can fail with EPERM.
 *
 * Options:
 *   --wav <file>            measure this audio instead of the video's own track
 *   --expect-duration <s>   --expect-fps <n>   --expect-size <WxH>
 *   --static-threshold <n>  mean-abs-diff floor, default 0.35 (of 255)
 *   --static-limit <s>      max allowed frozen run, default 0.5
 *   --lufs-target <n>       default -14   --tolerance-lu <n>  default 0.5
 *   --tp-limit <n>          default -1 (dBTP)
 *   --sheets <dir>          write contact sheets here
 *   --sheet-tiles <n>       tiles per sheet, default 12 (4x4 grid rows /4)
 *   --sheet-every <s>       seconds between sheet samples, default 2.5
 *   --tmp <dir>             scratch directory (default: OS temp, else alongside the video)
 *   --json                  machine-readable output only
 *
 * Exit 0 = every enabled check passed, 1 = at least one failed, 2 = usage/tool error.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
if (!args.length || args[0].startsWith('-')) { console.error('usage: node av_audit.mjs <video> [options]'); process.exit(2); }
const video = path.resolve(args[0]);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : dflt; };
const flag = (name) => args.includes('--' + name);

const EXPECT_DURATION = opt('expect-duration', null);
const EXPECT_FPS = parseFloat(opt('expect-fps', '0'));
const EXPECT_SIZE = opt('expect-size', null);
const STATIC_THRESHOLD = parseFloat(opt('static-threshold', '0.35'));
const STATIC_LIMIT = parseFloat(opt('static-limit', '0.5'));
const LUFS_TARGET = parseFloat(opt('lufs-target', '-14'));
const LU_TOL = parseFloat(opt('tolerance-lu', '0.5'));
const TP_LIMIT = parseFloat(opt('tp-limit', '-1'));
const WAV = opt('wav', null);
const SHEETS = opt('sheets', null);
const TILES = parseInt(opt('sheet-tiles', '12'), 10);
const SHEET_EVERY = parseFloat(opt('sheet-every', '2.5'));
const JSON_ONLY = flag('json');
const KEEP_TMP = !!opt('tmp', null);

const TMP = (() => {
  const explicit = opt('tmp', null);
  for (const d of [explicit, path.join(os.tmpdir(), `av_audit_${process.pid}`), path.join(path.dirname(video), '.av-audit')].filter(Boolean)) {
    try { fs.mkdirSync(d, { recursive: true }); return d; } catch { /* next */ }
  }
  return path.dirname(video);
})();

let capSeq = 0;
/** Run a child and capture its stdout/stderr through files (sandbox-safe). */
function runCapture(cmd, a, { binOut = false, allowFail = false } = {}) {
  const tag = path.join(TMP, `cap${++capSeq}`);
  const fOut = tag + (binOut ? '.bin' : '.txt'), fErr = tag + '.err';
  const fdOut = fs.openSync(fOut, 'w'), fdErr = fs.openSync(fErr, 'w');
  let r;
  try { r = spawnSync(cmd, a, { stdio: ['ignore', fdOut, fdErr], windowsHide: true }); }
  finally { fs.closeSync(fdOut); fs.closeSync(fdErr); }
  const out = fs.readFileSync(fOut, binOut ? undefined : 'utf8');
  const err = fs.readFileSync(fErr, 'utf8');
  fs.rmSync(fOut, { force: true }); fs.rmSync(fErr, { force: true });
  if (r.error) { if (allowFail) return { status: -1, out, err: String(r.error.message) }; throw r.error; }
  if (r.status !== 0) {
    if (allowFail) return { status: r.status, out, err };
    throw new Error(`${path.basename(cmd)} ${a.join(' ')} failed (${r.status}): ${err.slice(-400)}`);
  }
  return { status: 0, out, err };
}

function resolveTool(kind) {
  const env = process.env[kind === 'ffprobe' ? 'FFPROBE' : 'FFMPEG'];
  const exe = process.platform === 'win32' ? '.exe' : '';
  const cands = [env, `/usr/bin/${kind}`, `/usr/local/bin/${kind}`, `/opt/homebrew/bin/${kind}`,
    `D:/ffmpeg-dl/bin/${kind}${exe}`, `C:/ffmpeg/bin/${kind}${exe}`, kind].filter(Boolean);
  for (const c of cands) {
    const r = spawnSync(c, ['-version'], { stdio: 'ignore', windowsHide: true });
    if (!r.error && r.status === 0) return c;
  }
  console.error(`[av_audit] cannot run ${kind}; set $${kind === 'ffprobe' ? 'FFPROBE' : 'FFMPEG'} or put it on PATH`);
  process.exit(2);
}
const FFMPEG = resolveTool('ffmpeg');
const FFPROBE = resolveTool('ffprobe');

const fails = [], passes = [], out = {};
const say = (s) => { if (!JSON_ONLY) console.log(s); };
const check = (ok, msg) => { (ok ? passes : fails).push(msg); say((ok ? 'PASS ' : 'FAIL ') + msg); };

/* ---------------------------------------------------------------- container */
const meta = JSON.parse(runCapture(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', video]).out);
const v = (meta.streams || []).find((s) => s.codec_type === 'video');
const a = (meta.streams || []).find((s) => s.codec_type === 'audio');
if (!v) { say('FAIL no video stream'); process.exit(1); }
const fps = (() => { const [n, d] = String(v.avg_frame_rate || v.r_frame_rate || '0/1').split('/').map(Number); return d ? n / d : 0; })();
const duration = parseFloat(meta.format.duration);
const frames = Number(v.nb_frames || 0) || Math.round(duration * fps);
out.container = {
  width: v.width, height: v.height, fps: v.avg_frame_rate, codec: v.codec_name, pix_fmt: v.pix_fmt,
  frames, duration_seconds: duration, audio_codec: a ? a.codec_name : null,
  audio_rate: a ? a.sample_rate : null, audio_channels: a ? a.channels : null, size_bytes: Number(meta.format.size || 0),
};
say(`container ${v.codec_name} ${v.width}x${v.height} ${v.avg_frame_rate} ${duration}s frames=${frames} audio=${a ? a.codec_name : 'none'}`);
if (EXPECT_DURATION) check(Math.abs(duration - parseFloat(EXPECT_DURATION)) < 1e-3, `duration == ${EXPECT_DURATION}s (got ${duration})`);
if (EXPECT_FPS) check(Math.abs(fps - EXPECT_FPS) < 1e-6, `fps == ${EXPECT_FPS} (got ${fps})`);
if (EXPECT_SIZE) check(`${v.width}x${v.height}` === EXPECT_SIZE, `resolution == ${EXPECT_SIZE} (got ${v.width}x${v.height})`);
check(Number.isFinite(duration) && duration > 0, `duration is finite (${duration}s)`);

/* ------------------------------------------------------------------- motion */
const W = 160, H = 90;
const raw = runCapture(FFMPEG, ['-v', 'error', '-i', video, '-vf', `scale=${W}:${H}`, '-pix_fmt', 'gray', '-f', 'rawvideo', '-'], { binOut: true }).out;
const nFrames = Math.floor(raw.length / (W * H));
const mads = new Float64Array(Math.max(0, nFrames - 1));
let prev = Buffer.alloc(W * H);
for (let i = 0; i < nFrames; i++) {
  const g = raw.subarray(i * W * H, (i + 1) * W * H);
  if (i > 0) { let s = 0; for (let p = 0; p < g.length; p++) s += Math.abs(g[p] - prev[p]); mads[i - 1] = s / g.length; }
  g.copy(prev);
}
let run = 0, runStart = 0, worst = { frames: 0, start: 0 };
for (let i = 0; i < mads.length; i++) {
  if (mads[i] < STATIC_THRESHOLD) { if (run === 0) runStart = i; run++; if (run > worst.frames) worst = { frames: run, start: runStart }; }
  else run = 0;
}
const sorted = Array.from(mads).sort((x, y) => x - y);
out.motion = {
  frames_decoded: nFrames, median_mad: sorted.length ? +sorted[Math.floor(sorted.length / 2)].toFixed(4) : 0,
  p10_mad: sorted.length ? +sorted[Math.floor(sorted.length * 0.1)].toFixed(4) : 0,
  longest_frozen_seconds: +(worst.frames / fps).toFixed(3), longest_frozen_at_seconds: +(worst.start / fps).toFixed(3),
  threshold: STATIC_THRESHOLD,
};
check(worst.frames / fps < STATIC_LIMIT, `longest frozen run < ${STATIC_LIMIT}s (got ${out.motion.longest_frozen_seconds}s at ${out.motion.longest_frozen_at_seconds}s)`);

/* --------------------------------------------------------------------- loop */
const first = path.join(TMP, 'first.png'), last = path.join(TMP, 'last.png');
runCapture(FFMPEG, ['-v', 'error', '-y', '-i', video, '-vf', 'select=eq(n\\,0)', '-frames:v', '1', first]);
runCapture(FFMPEG, ['-v', 'error', '-y', '-i', video, '-vf', `select=eq(n\\,${Math.max(0, frames - 1)})`, '-frames:v', '1', last]);
const psnr = runCapture(FFMPEG, ['-v', 'info', '-i', first, '-i', last, '-lavfi', 'psnr', '-f', 'null', '-'], { allowFail: true }).err;
const mP = psnr.match(/average:([\d.]+|inf)/i);
out.loop = { first_vs_last_psnr_db: mP ? mP[1] : null };
say(`loop first vs last frame psnr=${out.loop.first_vs_last_psnr_db} dB`);

/* ---------------------------------------------------------------- loudness */
const audioSource = WAV ? path.resolve(WAV) : (a ? video : null);
if (audioSource) {
  const r = runCapture(FFMPEG, ['-v', 'info', '-i', audioSource, '-af', 'loudnorm=print_format=json', '-f', 'null', '-'], { allowFail: true });
  const blocks = r.err.match(/\{[^{}]*"input_i"[^{}]*\}/g);
  const j = blocks ? JSON.parse(blocks[blocks.length - 1]) : null;
  if (!j) { out.loudness = { error: 'loudnorm produced no JSON' }; check(false, 'loudness measurable'); }
  else {
    out.loudness = { integrated_lufs: +parseFloat(j.input_i).toFixed(2), true_peak_dbtp: +parseFloat(j.input_tp).toFixed(2) };
    say(`loudness ${out.loudness.integrated_lufs} LUFS, true peak ${out.loudness.true_peak_dbtp} dBTP`);
    check(Math.abs(out.loudness.integrated_lufs - LUFS_TARGET) <= LU_TOL, `integrated loudness within ${LU_TOL} LU of ${LUFS_TARGET} (got ${out.loudness.integrated_lufs})`);
    check(out.loudness.true_peak_dbtp <= TP_LIMIT + 1e-6, `true peak <= ${TP_LIMIT} dBTP (got ${out.loudness.true_peak_dbtp})`);
  }
} else say('note: no audio track, loudness skipped');

/* ------------------------------------------------------------------- sheets */
if (SHEETS) {
  const dir = path.resolve(SHEETS);
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(TMP, 'sheet_src_%04d.png');
  const step = Math.max(1, Math.round(SHEET_EVERY * fps));
  runCapture(FFMPEG, ['-v', 'error', '-y', '-i', video, '-vf', `select=not(mod(n\\,${step})),scale=480:270`, '-vsync', '0', src]);
  const names = fs.readdirSync(TMP).filter((f) => /^sheet_src_\d+\.png$/.test(f));
  const cols = 4, rows = Math.max(1, Math.ceil(TILES / cols));
  const sheets = [];
  for (let s = 0; s < Math.ceil(names.length / TILES); s++) {
    const sheet = path.join(dir, `sheet_${String(s).padStart(2, '0')}.png`);
    runCapture(FFMPEG, ['-v', 'error', '-y', '-start_number', String(s * TILES), '-i', src,
      '-vf', `tile=${cols}x${rows}:padding=4:margin=4:color=0x222222`, '-frames:v', '1', sheet]);
    sheets.push(path.basename(sheet));
  }
  out.sheets = { dir, count: sheets.length };
  say(`sheets: ${sheets.length} written to ${dir}`);
}

out.pass = fails.length === 0;
out.pass_lines = passes;
out.fail_lines = fails;
say(out.pass ? 'VERDICT PASS' : 'VERDICT FAIL');
console.log(JSON_ONLY ? JSON.stringify(out) : JSON.stringify({ pass: out.pass, fails }));
if (!KEEP_TMP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* keep */ } }
process.exit(out.pass ? 0 : 1);
