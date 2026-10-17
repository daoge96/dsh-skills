---
name: video-production
description: Produce a video artifact with code — a pure time→frame renderer plus a validated render/encode/mux pipeline (motion graphics, data animations, explainers, showreels, generative loops, audio-reactive pieces). Use when the deliverable is a video file, a looping animation, a frame sequence to mux with audio, or when you must verify duration/fps/container specs, loop seams, a "nothing is ever frozen" floor, contact-sheet reviews, loudness/true-peak targets, or render throughput. Load before writing the first line of drawing code.
whenToUse: The task names a video/mp4/webm/gif deliverable, an animation or motion-design piece, a render pipeline (frames → ffmpeg → mux), a loop that must restart seamlessly, or any QC of a video artifact.
---

# Video production with code

Treat a video as **a pure function `render(t)` plus a staged, assertable pipeline**. Almost every failure mode in this task class is a units/sign/channel/metric bug that ships silently — so the workflow below is built around making each one *observable*.

## 0. Freeze the contract before drawing anything

1. **One time source.** Everything lives inside `render(t)`; the frame↔time mapping (`t = frame/fps`) is the whole public API. No CSS animation, no timers, no frame-to-frame state. Result: frames are parallelizable, resumable, comparable, and a bug is localizable to a time range.
2. **Determinism.** Seeded PRNG (`hash(i)`/`mulberry32`), never `Math.random`; never `Date.now`; embed fonts and textures as data URIs so no network/font-fallback can change pixels mid-run.
3. **Write the spec as assertions, not prose.** Duration, fps, resolution, codec, pixel format, loudness, true peak, safe area/margins, banned techniques, file paths, CLI flags, exit codes, JSON output shape. If a number is in the brief, it must end up in a check.
4. **Decide the seam policy up front** — one-shot / loop / concatenated segments. For a loop: every oscillator is `sin(2π·k·t/D)` with integer `k`; the film **converges back to its own first state** (not "looks similar"); event tables and on-screen counters/labels reset inside the final transition; verify `render(0)` vs `render(D)` renders.
5. **Per-frame budget.** Measure `render(t)` before building content (a 1080p canvas draw is 2–30 ms; 3 subframes × 5400 frames multiplies it). Record the budget and hold it.
6. **Freeze the interface, then hash it.** Canvas size, page/API surface, worker CLI, output paths. All QC is bound to that revision hash — a render QC'd against a stale hash is worthless.
7. **Log deliberate deviations.** Every place reality departs from the brief (a grid wobble on "clean" lines, micro-type smaller than the stated minimum, a spring rate outside the stated range) goes into a short list with a reason, so a reviewer can judge rather than discover.

## 1. Three probes on day one

| Probe | Assert | Why |
|---|---|---|
| Capture integrity | exact pixels, **alpha == 255**, colour range, first/last frame present | translucent accumulation, range/colour-space mistakes silently ruin the whole film |
| Cost | `render(t)` ms distribution per scene, memory | architecture changes are cheap now, expensive later |
| Motion | per-frame difference series over the full duration + longest frozen run | shows the dead time ranges immediately |

Rules that came out of real failures:

- **The white-composite trap.** Reviewing frames through a viewer that composites alpha onto white hides translucency; the encode composites onto black. Make the review path composite exactly like the delivery path, and diff a pixel between the two.
- **Know what a metric can see.** After a 12× downscale, sub-pixel motion of a thin line changes the mean absolute difference by ~0.03/255, while a whole-frame brightness change moves it by ~1.5/255. If the acceptance metric is a downscaled mean, the cheapest real lever is a **global value channel** (e.g. a 2 Hz ±3 % luminance pulse at the beat rate), not bigger wobble.
- **Verify the metric before the asset.** When a check fails, dump the raw signal (envelope at 1 ms, pixel row profile, frame series) first. Half of "the asset is wrong" turns out to be the detector.
- **Make detectors self-describing.** Model and compensate systematic bias (filter group delay, causal analysis-window lag); prefer the candidate **nearest the event** over the loudest one; never tune a threshold until it passes.
- **Exact vs approximate claims.** "render(0) ≡ render(D), PSNR ∞" is a proof; "first vs last encoded frame differ by 2/255 (one frame of motion)" is an observation. Never blur the two in a report.

Bundled: `scripts/av_audit.mjs` implements the container/motion/loop/loudness/sheet half of this (ffmpeg-only, no npm deps).

## 2. The review loop is a feature, not overhead

- **Grid it**: hundreds of stills → a dozen contact sheets, reviewed in one pass.
- **Bake guides in**: safe-area box, centre crosshair, timecode, event id. The reviewer should not have to hold the layout in their head.
- **Sample by event**, not by fixed interval: one frame on each intended event and one mid-move.
- **Look hardest at seams**: scene transitions, loop wrap, segment boundaries, first/last frame.
- **Isolate and zoom** a suspect element onto a blank canvas at 4–6×; most bugs are invisible in the full frame.
- **Artifacts are disposable**: one command regenerates them; never hand-patch a review frame.
- Keep an issue list (cluttered / off-beat / overlapping / outside safe area / unreadable / frozen) and re-review after every fix round.

## 3. Motion and loop craft

- **Ambient ≠ action.** Every scene needs a continuous channel at a different frequency from the action (drift, wave, idle rotation, value pulse) with zero-crossings aligned to the beat so actions still land cleanly. This is what satisfies "nothing is ever frozen".
- **One easing family.** Critically damped spring `1-(1+x)e^-x` (never overshoots) for moves; exponential ease-out/in for wipes, presses, exits. Make the *landing* coincide with the event: start = event − duration, and normalize so progress = 1 exactly at the event.
- **Motion blur in two places**: inside the frame function (2–4 shutter samples averaged with a **running average** — `alpha = 1/(k+1)` — which ends fully opaque), denser around events; plus an encoder-side time blend. Prove filter window semantics with an **index-coded fixture** (feed frames whose pixels encode the frame number and read back which indices were averaged), never from documentation.
- **Continuity by construction.** Carry one geometry/state model across scenes and transform it (morph, material swap, hard-edge wipe flood, scan line) instead of cutting or dissolving.
- **Length-preserving morphs**: parametrize shapes by angle/arc-length so blends grow rather than scale.
- **Banned-by-default list** (delete unless asked): particles, glows, lens flares, camera shake, RGB split, crossfades, generic gradients, bouncy overshoot.

## 4. Render and encode

- **Format vs target**: measure throughput first. Lossless PNG frames are multi-MB and stress the pipe; high-quality JPEG is ~1.5× faster. Decide once, then keep it.
- **Pipe, don't spool**: feed frames to ffmpeg stdin (`-f image2pipe -framerate <fps*sub> -vcodec png -i -`). Blend with `tmix`, select the group's last frame, re-time, `-frames:v <n>` to trim.
- **Parallelize by cost, not frame count.** Measure per-scene ms, then partition into chunks of roughly equal *time*; uniform frame counts make the slowest worker set the wall clock.
- **Segments must be concat-safe**: repeat 2 boundary frames at each end, identical encoder parameters and time base, verify frames/duration with ffprobe, then `-c copy` concat.
- **Stage the pipeline** so a failure costs one stage: render → blend → encode → audio → mux → measure; each stage writes a file.
- **Keep a lossless video master** between stages (`-c copy` everywhere), and do loudness last.
- **Probe an unknown toolchain** before relying on it: filter/encoder lists, browser executables, versions; allow `$FFMPEG`/`$FFPROBE` overrides; prefer pinned local binaries over PATH guesses. A stripped "media" ffmpeg shipped with a browser usually lacks `x264`/`tmix`/`loudnorm`.
- **Capture child output through file descriptors, not pipes.** Inside a confined sandbox, `spawn`/`execSync` with `stdio: 'pipe'` can fail with `EPERM` while the same binary runs fine from a shell. Pass open file handles instead: `spawnSync(cmd, a, { stdio: ['ignore', fdOut, fdErr] })`, then read the files — and use `stdio: 'ignore'` for pure existence/version probes. Route stdout and stderr to *separate* files so binary frame data is not interleaved with log text.
- **Finish with an end-to-end rebuild from source**, so the delivered file is not a lucky cache.

## 5. Audio and mux

- Same time base and same determinism as the picture (offline render, seeded, no realtime dependency).
- One **cue table** (`{t, name}`) as the single source of truth for every audible/visible event; SFX live on their own bus, quieter than music.
- Normalize with **two-pass loudnorm** (`print_format=json` → measured_* → second pass with `linear=true`), then verify with an **independent third measurement**; assert integrated loudness within ±0.5 LU and true peak ≤ target.
- Loops: fade the tail (~40 ms) to exact zero, first sample non-clicking; measure percussive-hit alignment to the grid and report it.
- Mux `-c:v copy -c:a aac -b:a <spec>`, then ffprobe the container as an assertion, not a look.
- `-b:a Nk` is a **target, not a floor** for ffmpeg's native AAC encoder (measured ~180–250 kbps against a 320k request on quiet material; `-aac_coder twoloop` helps). Read the declared `bit_rate` back and report the measured average instead of repeating the requested number, and say so explicitly when the spec demands a bitrate.

Bundled: `scripts/mux_normalize.mjs`.

## 6. Keep the drawing layer cheap and deterministic

- Cache everything time-invariant: baked backgrounds, text masks, patterns, Path2D. Cache keys contain **every** parameter that can change pixels.
- Canvas pools must be sized from the **source canvas** dimensions, not the logical content size — otherwise `drawImage` silently stretches or crops (this produced clipped/mangled type).
- Avoid `shadowBlur`/`filter` in the frame loop; prefer geometry.
- Memory: a 1080p canvas is ~8 MB; bound the pool.
- Remember subframe count multiplies the frame budget linearly.

## 7. Collaboration

- **Split author vs verifier.** The verifier owns the QC scripts and the authority to fail the deliverable, and independently checks dimensions the author did not (alpha, fidelity vs page, loudness, loop closure). This is what catches the class of bug the author is blind to.
- **Disjoint write scopes + a frozen interface** so parallel work cannot collide; hash the revision and re-run QC after any change.
- **Fail loud**: non-zero exits, one `PASS/FAIL` line per claim, JSON for anything machine-read, no silent fallbacks.

## 8. Anti-patterns

1. Judging colour through a white-composited review image.
2. Editing the asset to satisfy a metric you never characterized.
3. Threshold-tuning a detector instead of fixing its model.
4. Re-running the full render to answer a question a 20-second page-side probe answers.
5. Uniform frame-count chunking across scenes of very different cost.
6. A review path that differs from the delivery path (scale, colour range, composite).
7. "It looked fine" instead of an assertion; failures that exit 0.
8. Text/asset surgery with tools that mangle non-ASCII (verify encoding after the edit).
9. Fixing review frames by hand instead of fixing the source.
10. Hiding a state discontinuity behind a crossfade.

## 9. Checklists

**Pre-flight** — spec → assertions; `render(t)` signature frozen; seam policy + loop algebra; assets embedded; three probes exist; per-frame budget set; FFMPEG/FFPROBE resolved and capability-probed.

**In-flight** — after each scene: cost probe, motion series, event-sampled review grid; issue list closed; syntax/type check plus a non-ASCII check on edited sources; hash the revision.

**Pre-delivery** — rebuild from source; full render (cost-weighted, boundary frames, concat verified); loudness two-pass + third verify; independent measurement script → `PASS/FAIL`; report exact vs approximate claims explicitly; delete temp scripts/screenshots and document the one-command regeneration for each.

**Definition of done** — container metadata exact; seam behaviour proven; frozen-run limit met; loudness/true peak met; on-screen text matches the brief verbatim; one command rebuilds from source; all QC green on the frozen hash.

## 10. Bundled scripts

Both are single-file, zero-dependency (ffmpeg/ffprobe only), resolve their tools from `$FFMPEG`/`$FFPROBE` → PATH → common locations, print one `PASS/FAIL` line per claim, emit JSON with `--json`, and exit non-zero on failure. Resolve their directory from this skill's own path.

```bash
# QC a finished file: container vs expectations, frozen-run limit, loop seam,
# loudness/true peak, optional contact sheets for human review
node av_audit.mjs film.mp4 --expect-duration 30 --expect-fps 60 --expect-size 1920x1080 \
     --static-limit 0.5 --sheets ./sheets        # exit 0 = all checks passed

# Normalize a WAV to a target and mux it onto an encoded video (video stream copied),
# then verify with a third independent measurement pass
node mux_normalize.mjs silent.mp4 score.wav film.mp4 --lufs -14 --tp -1 --abr 320k
```

`av_audit.mjs` deliberately uses a low-resolution (160×90) MAD series: it sees whole-frame value changes and block movement, **not** sub-pixel motion of thin lines — pair it with the metric-sensitivity rule in §1. For a loop, treat `first_vs_last_psnr_db` as an observation about one frame of motion and prove exactness separately by comparing two renders of the renderer itself.

**One-line summary** — success depends on three things, none of them drawing skill: the time function is pure and verifiable, the metrics are understood before they are optimized, and the review plus delivery paths are the same path.
