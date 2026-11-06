// Low-latency cabinet stream: ffmpeg (MPEG-TS, MPEG-1 video + MP2 audio) ->
// WebSocket -> jsmpeg in the browser. New viewers receive a short tail buffer
// so they do not wait for the next keyframe.
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = {
  maxBuffer: 1200000,
  maxBufferChunks: 240,
  maxClientBuffer: 4 * 1024 * 1024,
  hardClientBuffer: 16 * 1024 * 1024,
  slowGraceMs: 2500,
  restartBaseMs: 1000,
  restartMaxMs: 30000,
  audioCooldownMs: 60000,
  rectDebounceMs: 350,
};

function intOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

export class StreamManager extends EventEmitter {
  constructor({ config, rootDir }) {
    super();
    this.config = config;
    this.rootDir = rootDir;
    this.ffmpeg = null;
    this.audio = null;
    this.clients = new Set();
    this.buffer = [];
    this.bufferBytes = 0;

    const s = config.stream || {};
    this.maxBuffer = intOr(s.bufferBytes, DEFAULTS.maxBuffer);
    this.maxBufferChunks = intOr(s.maxBufferChunks, DEFAULTS.maxBufferChunks);
    this.maxClientBuffer = intOr(s.maxClientBufferBytes, DEFAULTS.maxClientBuffer);
    this.hardClientBuffer = intOr(s.hardClientBufferBytes, DEFAULTS.hardClientBuffer);
    this.slowGraceMs = intOr(s.slowViewerGraceMs, DEFAULTS.slowGraceMs);
    this.restartBaseMs = intOr(s.restartBaseMs, DEFAULTS.restartBaseMs);
    this.restartMaxMs = intOr(s.restartMaxMs, DEFAULTS.restartMaxMs);
    this.audioCooldownMs = intOr(s.audioCooldownMs, DEFAULTS.audioCooldownMs);
    this.rectDebounceMs = intOr(s.rectDebounceMs, DEFAULTS.rectDebounceMs);

    this.stopping = false;
    this.starting = false;
    this.restarting = false;
    this.pendingRestart = false;
    this.restartTimer = null;
    this.rectTimer = null;
    this.restartAttempts = 0;
    this.restarts = 0;
    this.dropped = 0;
    this.lastDrop = null;
    this.startedAt = 0;
    this.lastStartAt = 0;
    this.lastDataAt = 0;
    this.lastError = null;
    this.bytesWindow = 0;
    this.bytesPerSec = 0;
    this.audioActive = false;
    this.audioName = null;
    this.audioCooldownUntil = 0;
    this.generation = 0;

    const source = String(process.env.RR4_STREAM_SOURCE || s.source || '').toLowerCase();
    this.testMode = source === 'test';
    this.captureRect = {
      x: intOr(config.game?.captureX, 0),
      y: intOr(config.game?.captureY, 0),
      w: intOr(config.game?.captureW, config.game?.width || 640),
      h: intOr(config.game?.captureH, config.game?.height || 480),
    };

    this.rateTimer = null;
    this.ensureRateTimer();
  }

  resolve(p) {
    return path.isAbsolute(p) ? p : path.resolve(this.rootDir, p);
  }

  ensureRateTimer() {
    if (this.rateTimer) return;
    this.rateTimer = setInterval(() => {
      this.bytesPerSec = this.bytesWindow;
      this.bytesWindow = 0;
    }, 1000);
    this.rateTimer.unref?.();
  }

  stats() {
    return {
      running: !!this.ffmpeg,
      viewers: this.clients.size,
      bytesPerSec: this.bytesPerSec,
      audio: this.audioActive,
      audioDevice: this.audioName,
      lastDataAgeMs: this.lastDataAt ? Date.now() - this.lastDataAt : null,
      uptimeSec: this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
      source: this.testMode ? 'test' : 'capture',
      bufferBytes: this.bufferBytes,
      bufferChunks: this.buffer.length,
      dropped: this.dropped,
      restarts: this.restarts,
      reconnecting: !!(this.restartTimer || this.starting),
      lastDrop: this.lastDrop,
      lastError: this.lastError,
    };
  }

  setCaptureRect(rect) {
    if (!rect) return;
    const x = intOr(rect.x, NaN);
    const y = intOr(rect.y, NaN);
    const w = intOr(rect.w, 0);
    const h = intOr(rect.h, 0);
    if (!Number.isFinite(x) || !Number.isFinite(y) || w < 2 || h < 2) return;
    const next = { x, y, w, h };
    if (next.x === this.captureRect.x && next.y === this.captureRect.y &&
        next.w === this.captureRect.w && next.h === this.captureRect.h) return;
    this.captureRect = next;
    this.emit('log', `capture rect ${next.w}x${next.h} at ${next.x},${next.y}`);
    if (!this.ffmpeg || this.testMode || this.stopping) return;
    // Window drag/resize produces a burst of rect updates. Coalesce them so a
    // single move only restarts ffmpeg once.
    if (this.rectTimer) clearTimeout(this.rectTimer);
    this.rectTimer = setTimeout(() => {
      this.rectTimer = null;
      this.restart('capture rect changed').catch((e) => this.emit('log', `rect restart failed: ${e.message}`));
    }, this.rectDebounceMs);
    this.rectTimer.unref?.();
  }

  addClient(ws) {
    if (!ws || this.clients.has(ws)) return;
    this.clients.add(ws);
    ws._rr4SlowSince = 0;
    if (this.buffer.length && ws.readyState === 1) {
      for (const chunk of this.buffer) {
        if (ws.bufferedAmount > this.hardClientBuffer) break;
        try { ws.send(chunk); } catch { break; }
      }
    }
    const remove = () => {
      if (this.clients.delete(ws)) this.emit('viewers', this.clients.size);
    };
    ws.on('close', remove);
    ws.on('error', remove);
    this.emit('viewers', this.clients.size);
  }

  removeClient(ws, reason) {
    if (!this.clients.delete(ws)) return false;
    this.dropped++;
    this.lastDrop = { reason, at: Date.now() };
    this.emit('log', `viewer dropped (${reason})`);
    try { ws.terminate(); } catch { /* ignore */ }
    return true;
  }

  broadcast(chunk) {
    if (!chunk || !chunk.length) return;
    this.bytesWindow += chunk.length;
    this.lastDataAt = Date.now();
    // A process that stays alive for a few seconds is healthy; clear the
    // exponential restart backoff so a later crash restarts quickly.
    if (this.lastStartAt && Date.now() - this.lastStartAt > 5000) this.restartAttempts = 0;

    this.buffer.push(chunk);
    this.bufferBytes += chunk.length;
    while ((this.bufferBytes > this.maxBuffer || this.buffer.length > this.maxBufferChunks) &&
           this.buffer.length > 1) {
      this.bufferBytes -= this.buffer.shift().length;
    }
    if (this.buffer.length === 1 && this.bufferBytes > this.maxBuffer) {
      // Never keep a single oversized chunk forever.
      const only = this.buffer[0];
      if (only.length > this.maxBuffer) {
        this.buffer[0] = only.subarray(only.length - this.maxBuffer);
        this.bufferBytes = this.buffer[0].length;
      }
    }

    let changed = false;
    const now = Date.now();
    for (const ws of this.clients) {
      if (ws.readyState !== 1) {
        if (this.clients.delete(ws)) changed = true;
        continue;
      }
      const buffered = ws.bufferedAmount || 0;
      if (buffered > this.hardClientBuffer) {
        if (this.removeClient(ws, 'buffer overflow')) changed = true;
        continue;
      }
      if (buffered > this.maxClientBuffer) {
        if (!ws._rr4SlowSince) ws._rr4SlowSince = now;
        if (now - ws._rr4SlowSince > this.slowGraceMs) {
          if (this.removeClient(ws, 'slow viewer')) changed = true;
          continue;
        }
      } else {
        ws._rr4SlowSince = 0;
      }
      try { ws.send(chunk); } catch {
        if (this.removeClient(ws, 'send failed')) changed = true;
      }
    }
    if (changed) this.emit('viewers', this.clients.size);
  }

  ffmpegArgs(withAudio) {
    const s = this.config.stream || {};
    const g = this.config.game || {};
    const ff = this.resolve(this.config.ffmpeg || '../_tools/ffmpeg/bin/ffmpeg.exe');
    const args = ['-hide_banner', '-loglevel', 'warning', '-fflags', 'nobuffer'];
    if (this.testMode) {
      const testFile = this.resolve(s.testFile || '../_runtime/capture-test.ts');
      if (!fs.existsSync(testFile)) throw new Error(`test stream missing: ${testFile}`);
      args.push('-stream_loop', '-1', '-re', '-i', testFile, '-c', 'copy');
      args.push('-muxdelay', '0', '-muxpreload', '0', '-flush_packets', '1', '-f', 'mpegts', 'pipe:1');
      return { ff, args };
    }
    // gdigrab needs even dimensions; round down without changing the stored
    // client rect so stats still report the real window area.
    const x = Math.max(0, intOr(this.captureRect.x, 0));
    const y = Math.max(0, intOr(this.captureRect.y, 0));
    const w = Math.max(2, intOr(this.captureRect.w, 640) & ~1);
    const h = Math.max(2, intOr(this.captureRect.h, 480) & ~1);
    args.push(
      '-f', 'gdigrab',
      '-framerate', String(g.fps || 60),
      '-offset_x', String(x),
      '-offset_y', String(y),
      '-video_size', `${w}x${h}`,
      '-i', 'desktop',
    );
    if (withAudio) {
      args.push('-f', 's16le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0');
    }
    args.push(
      '-vf', `scale=${s.width || 960}:${s.height || 720}:flags=fast_bilinear`,
      '-c:v', 'mpeg1video',
      '-b:v', s.bitrate || '6M',
      '-maxrate', s.maxrate || '8M',
      '-bufsize', s.bufsize || '4M',
      '-g', String(s.gop || 30),
      '-bf', '0',
      '-r', String(g.fps || 60),
    );
    if (withAudio) {
      args.push('-c:a', 'mp2', '-b:a', s.audioBitrate || '128k', '-ar', '44100', '-ac', '2');
    }
    args.push('-muxdelay', '0', '-muxpreload', '0', '-flush_packets', '1', '-f', 'mpegts', 'pipe:1');
    return { ff, args };
  }

  async start() {
    if (this.ffmpeg || this.starting || this.stopping) return;
    this.starting = true;
    this.startedAt = this.startedAt || Date.now();
    this.ensureRateTimer();
    try {
      const wantAudio = !!this.config.stream?.audio && !this.testMode &&
        Date.now() >= this.audioCooldownUntil;
      if (wantAudio) {
        try {
          await this.startWithAudio();
          return;
        } catch (e) {
          this.lastError = e.message;
          this.emit('log', `audio unavailable (${e.message}); starting video-only`);
          this.stopAudio();
          this.audioCooldownUntil = Date.now() + this.audioCooldownMs;
        }
      }
      this.startVideoOnly();
    } finally {
      this.starting = false;
      if (this.pendingRestart && !this.stopping) {
        this.pendingRestart = false;
        this.restart('pending restart').catch((e) => this.emit('log', `restart failed: ${e.message}`));
      }
    }
  }

  startVideoOnly() {
    if (this.stopping) return;
    try {
      const { ff, args } = this.ffmpegArgs(false);
      this.audioActive = false;
      this.spawnFfmpeg(ff, args, false);
    } catch (e) {
      this.lastError = e.message;
      this.emit('log', `stream start failed: ${e.message}`);
      this.scheduleRestart();
    }
  }

  async startWithAudio() {
    const py = this.config.python || 'py';
    const script = this.resolve(this.config.stream?.audioScript || 'src/audio.py');
    const audio = spawn(py, ['-3', script], {
      cwd: this.rootDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.audio = audio;
    this.audioActive = false;
    this.audioName = null;

    let settled = false;
    let stderrBuf = '';
    const readyPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('audio helper timeout'));
      }, 6000);
      timer.unref?.();
      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      };
      audio.on('error', fail);
      audio.on('exit', (code) => {
        if (!settled) {
          fail(new Error(`audio helper exited ${code}`));
          return;
        }
        if (this.audio !== audio) return;
        this.audio = null;
        this.audioActive = false;
        this.audioName = null;
        this.audioCooldownUntil = Date.now() + this.audioCooldownMs;
        if (this.stopping) return;
        this.emit('log', `audio helper exited ${code}; restarting video-only`);
        this.restart('audio lost').catch((e) => this.emit('log', `audio fallback failed: ${e.message}`));
      });
      audio.stderr.on('data', (buf) => {
        if (this.audio !== audio) return;
        stderrBuf += buf.toString('utf8');
        const lines = stderrBuf.split(/\r?\n/);
        stderrBuf = lines.pop() || '';
        for (const line of lines) {
          if (line.startsWith('AUDIO_READY')) {
            this.audioActive = true;
            this.audioName = line.slice('AUDIO_READY'.length).trim();
            this.emit('log', `audio loopback: ${this.audioName}`);
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve();
            }
          } else if (line.startsWith('AUDIO_')) {
            this.emit('log', line);
          }
        }
      });
    });

    await readyPromise;
    if (this.stopping) throw new Error('stream stopped');
    if (this.audio !== audio) throw new Error('audio helper exited');
    const { ff, args } = this.ffmpegArgs(true);
    this.spawnFfmpeg(ff, args, true);
  }

  spawnFfmpeg(ff, args, withAudio) {
    if (this.stopping) return;
    let proc;
    try {
      proc = spawn(ff, args, {
        cwd: this.rootDir,
        windowsHide: true,
        stdio: [withAudio ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      this.lastError = e.message;
      this.emit('log', `ffmpeg spawn failed: ${e.message}`);
      if (withAudio) {
        this.audioCooldownUntil = Date.now() + this.audioCooldownMs;
        this.stopAudio();
      }
      this.scheduleRestart();
      return;
    }

    const gen = ++this.generation;
    this.ffmpeg = proc;
    this.lastStartAt = Date.now();
    this.buffer = [];
    this.bufferBytes = 0;
    this.emit('state', this.stats());

    if (withAudio && this.audio?.stdout && proc.stdin) {
      this.audio.stdout.on('error', () => {});
      proc.stdin.on('error', () => {});
      this.audio.stdout.pipe(proc.stdin);
    }

    proc.stdout.on('data', (chunk) => {
      if (gen !== this.generation) return;
      this.broadcast(chunk);
    });
    let err = '';
    proc.stderr.on('data', (buf) => {
      err += buf.toString('utf8');
      const lines = err.split(/\r?\n/);
      err = lines.pop() || '';
      for (const line of lines) if (line.trim()) this.emit('log', `ffmpeg: ${line}`);
    });

    let ended = false;
    const finish = (code, signal, error) => {
      if (ended) return;
      ended = true;
      const wasCurrent = this.ffmpeg === proc;
      if (wasCurrent) this.ffmpeg = null;
      if (withAudio) {
        // The audio pipe belongs to this ffmpeg instance.
        this.stopAudio();
        if (wasCurrent && !this.stopping) {
          // Only fall back to video-only when the capture process died
          // unexpectedly. An intentional restart (e.g. a window move) should
          // keep audio enabled.
          this.audioCooldownUntil = Date.now() + this.audioCooldownMs;
        }
      }
      if (error) this.lastError = error.message;
      else if (code) this.lastError = `ffmpeg exited ${code}`;
      this.emit('state', this.stats());
      if (!wasCurrent || this.stopping) return;
      this.emit('down', { code, signal, error: error?.message });
      this.scheduleRestart();
    };
    proc.on('error', (e) => finish(null, null, e));
    proc.on('exit', (code, signal) => finish(code, signal, null));
  }

  stopAudio() {
    if (this.audio) {
      const audio = this.audio;
      this.audio = null;
      try { audio.kill(); } catch { /* ignore */ }
    }
    this.audioActive = false;
    this.audioName = null;
  }

  scheduleRestart() {
    if (this.stopping || this.restartTimer) return;
    const attempt = Math.min(this.restartAttempts, 5);
    const delay = Math.min(this.restartBaseMs * (2 ** attempt), this.restartMaxMs);
    this.restartAttempts++;
    this.emit('log', `stream restart in ${delay}ms (attempt ${this.restartAttempts})`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping) return;
      if (this.starting || this.restarting) {
        this.pendingRestart = true;
        return;
      }
      this.start().catch((e) => {
        this.lastError = e.message;
        this.emit('log', `stream restart failed: ${e.message}`);
        this.scheduleRestart();
      });
    }, delay);
    this.restartTimer.unref?.();
  }

  async restart(reason = 'restart') {
    if (this.stopping) return;
    if (this.starting || this.restarting) {
      this.pendingRestart = true;
      return;
    }
    this.restarting = true;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    if (this.rectTimer) { clearTimeout(this.rectTimer); this.rectTimer = null; }
    try {
      this.restarts++;
      this.emit('log', `stream restart (${reason})`);
      const proc = this.ffmpeg;
      this.ffmpeg = null;
      this.stopAudio();
      if (proc) {
        try { proc.kill(); } catch { /* ignore */ }
      }
      await this.start();
    } finally {
      this.restarting = false;
      if (this.pendingRestart && !this.stopping) {
        this.pendingRestart = false;
        this.restart('pending restart').catch((e) => this.emit('log', `restart failed: ${e.message}`));
      }
    }
  }

  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    this.pendingRestart = false;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    if (this.rectTimer) { clearTimeout(this.rectTimer); this.rectTimer = null; }
    this.stopAudio();
    const proc = this.ffmpeg;
    this.ffmpeg = null;
    if (proc) {
      try { proc.kill(); } catch { /* ignore */ }
    }
    if (this.rateTimer) { clearInterval(this.rateTimer); this.rateTimer = null; }
    this.buffer = [];
    this.bufferBytes = 0;
    this.emit('state', this.stats());
  }
}
