// Owns the native Ridge Racer Type 4 cabinet process: launch, window placement,
// watchdog, restart and pad routing.
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  findWindow, findWindowByPid, isWindow, setWindowRect, keepTopmost,
  focusWindow, getForegroundWindow, getClientCaptureRect,
} from './win32.js';
import { InputBridge } from './input.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class GameManager extends EventEmitter {
  constructor({ config, rootDir }) {
    super();
    this.config = config;
    this.rootDir = rootDir;
    this.input = new InputBridge({ onLog: (m) => this.emit('log', m) });
    this.proc = null;
    this.hwnd = null;
    this.state = 'stopped';
    this.stopping = false;
    this.starting = false;
    this.startedAt = 0;
    this.lastLaunchAt = 0;
    this.readyAt = 0;
    this.lastExit = null;
    this.lastInputAt = 0;
    this.watchTimer = null;
    this.restartTimer = null;
    this.attached = false;
    this.attachPid = 0;
    this.generation = 0;
    this.crashCount = 0;
    this.lastRect = null;
    this.lastRectKey = '';
    this.logPath = path.resolve(rootDir, config.game.logFile || '../_runtime/web-cabinet.log');
    fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
  }

  resolve(p) {
    return path.isAbsolute(p) ? p : path.resolve(this.rootDir, p);
  }

  status() {
    const windowOk = !!this.hwnd && isWindow(this.hwnd);
    return {
      state: this.state,
      running: !!this.proc || (this.attached && windowOk),
      pid: this.proc?.pid || this.attachPid || null,
      window: windowOk,
      foreground: windowOk ? getForegroundWindow() === this.hwnd : false,
      uptimeSec: this.startedAt ? Math.max(0, Math.floor((Date.now() - this.startedAt) / 1000)) : 0,
      lastExit: this.lastExit,
      attached: this.attached,
      capture: this.lastRect ? { ...this.lastRect } : null,
    };
  }

  configuredPid() {
    return Number(process.env.RR4_ATTACH_PID || this.config.game.attachPid || 0) || 0;
  }

  // Resolve the native cabinet window. In spawn mode the process id is the
  // strongest signal; in attach mode prefer RR4_ATTACH_PID but still fall back
  // to the configured window title.
  findTargetWindow() {
    const title = this.config.game.windowTitle;
    if (this.proc?.pid) return findWindowByPid(this.proc.pid) || findWindow(title);
    const pid = this.attachPid || this.configuredPid();
    if (pid) {
      const byPid = findWindowByPid(pid);
      if (byPid) return byPid;
    }
    return findWindow(title);
  }

  // Attach to a cabinet that is already running (the user may have launched it
  // outside the server). Never spawn or restart it in this mode.
  async attachExisting() {
    const g = this.config.game;
    this.attached = true;
    this.stopping = false;
    this.attachPid = this.configuredPid();

    let hwnd = this.findTargetWindow();
    if (!hwnd) {
      const deadline = Date.now() + (g.windowWaitMs || 45000);
      this.state = 'no-window';
      this.emit('state', this.status());
      while (!hwnd && Date.now() < deadline) {
        await sleep(500);
        hwnd = this.findTargetWindow();
      }
    }
    if (!hwnd) {
      this.state = 'no-window';
      this.emit('state', this.status());
      // Keep looking in the background; the cabinet may still be starting.
      this.startWatch();
      throw new Error('no running cabinet window found');
    }
    this.adoptWindow(hwnd, { attached: true });
  }

  captureRect() {
    if (!this.hwnd) return null;
    try {
      const rect = getClientCaptureRect(this.hwnd);
      if (!rect || !rect.w || !rect.h) return null;
      return rect;
    } catch {
      return null;
    }
  }

  emitCapture(force = false) {
    const rect = this.captureRect();
    if (!rect) return;
    const key = `${rect.x},${rect.y},${rect.w},${rect.h}`;
    if (!force && key === this.lastRectKey) return;
    this.lastRectKey = key;
    this.lastRect = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
    this.emit('capture', { ...this.lastRect });
  }

  adoptWindow(hwnd, { attached = false } = {}) {
    this.hwnd = hwnd;
    this.input.setWindow(hwnd);
    this.state = 'ready';
    this.attached = attached || this.attached;
    this.startedAt = this.startedAt || Date.now();
    this.readyAt = Date.now();
    // Only treat this as a healthy launch if the window survives. Resetting on
    // every window is what made a crash-on-boot loop reopen the game every
    // 2.5 s forever; now rapid exits keep backing off (2.5 s -> 20 s).
    const survivedMs = this.lastLaunchAt ? Date.now() - this.lastLaunchAt : Infinity;
    if (survivedMs >= 20000) this.crashCount = 0;
    this.placeWindow();
    this.emit('state', this.status());
    this.emit('ready', { hwnd, attached: this.attached });
    this.startWatch();
  }

  async start() {
    if (this.proc || this.starting) return;
    this.starting = true;
    this.stopping = false;
    this.attached = false;
    this.attachPid = 0;
    this.clearRestartTimer();
    try {
      const g = this.config.game;
      const exe = this.resolve(g.exe);
      const bios = this.resolve(g.bios);
      const disc = this.resolve(g.disc);
      const memcards = this.resolve(g.memcardDir);
      fs.mkdirSync(memcards, { recursive: true });
      if (!fs.existsSync(exe)) throw new Error(`game exe missing: ${exe}`);
      if (!fs.existsSync(disc)) throw new Error(`disc missing: ${disc}`);

      const args = [
        '--no-launcher',
        '--bios', bios,
        '--disc', disc,
        '--window-title', g.windowTitle,
        '--memcard-dir', memcards,
        '--renderer', g.renderer || 'opengl',
      ];
      const gen = ++this.generation;
      this.state = 'booting';
      this.hwnd = null;
      this.startedAt = Date.now();
      this.lastLaunchAt = this.startedAt;
      this.readyAt = 0;
      this.lastRect = null;
      this.lastRectKey = '';
      this.emit('state', this.status());

      const out = fs.createWriteStream(this.logPath, { flags: 'a' });
      out.write(`\n=== cabinet launch ${new Date().toISOString()} ===\n`);
      let proc;
      try {
        proc = spawn(exe, args, {
          cwd: this.resolve(g.workingDir || '.'),
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        out.end();
        this.state = 'exited';
        this.lastExit = { code: null, signal: null, error: e.message, at: Date.now() };
        this.emit('state', this.status());
        this.emit('log', `cabinet spawn failed: ${e.message}`);
        this.scheduleRestart();
        throw e;
      }
      this.proc = proc;

      const onData = (buf) => {
        const text = buf.toString('utf8');
        out.write(text);
        for (const line of text.split(/\r?\n/)) {
          if (!line.trim()) continue;
          this.emit('log', line);
          if (/netplay|error|failed|crash|desync/i.test(line)) this.emit('log:interesting', line);
        }
      };
      proc.stdout?.on('data', onData);
      proc.stderr?.on('data', onData);

      let ended = false;
      const finish = (code, signal, error) => {
        if (ended) return;
        ended = true;
        out.write(`\n=== cabinet exit code=${code} signal=${signal}${error ? ` error=${error.message}` : ''} ${new Date().toISOString()} ===\n`);
        out.end();
        const wasCurrent = this.proc === proc;
        if (wasCurrent) {
          this.proc = null;
          this.hwnd = null;
          this.state = 'exited';
          this.lastExit = { code, signal, error: error?.message || null, at: Date.now() };
          this.input.setWindow(null);
          this.input.releaseAll();
          this.clearWatch();
          this.lastRect = null;
          this.lastRectKey = '';
          this.emit('state', this.status());
          this.emit('exit', this.lastExit);
        }
        if (!wasCurrent || this.stopping || error?.code === 'ENOENT') return;
        if (this.config.game.autoRestart !== false) this.scheduleRestart();
      };
      proc.on('error', (e) => finish(null, null, e));
      proc.on('exit', (code, signal) => finish(code, signal, null));

      this.waitForWindow(gen).catch((e) => this.emit('log', `window wait: ${e.message}`));
    } finally {
      this.starting = false;
    }
  }

  async waitForWindow(gen = this.generation) {
    const deadline = Date.now() + (this.config.game.windowWaitMs || 45000);
    while (this.proc && gen === this.generation && Date.now() < deadline) {
      const hwnd = this.findTargetWindow();
      if (hwnd && isWindow(hwnd)) {
        this.adoptWindow(hwnd);
        return;
      }
      await sleep(450);
    }
    if (this.proc && gen === this.generation) {
      this.state = 'no-window';
      this.emit('state', this.status());
      this.emit('log', 'game process is running but no window was found; still watching');
      this.startWatch();
    }
  }

  placeWindow() {
    if (!this.hwnd || !isWindow(this.hwnd)) return false;
    const w = this.config.game.width || 656;
    const h = this.config.game.height || 519;
    // Keep the native frame. Removing WS_CAPTION/WS_THICKFRAME while the
    // OpenGL window is live can make some SDL runtimes quit; resizing/moving the
    // existing window is safe and lets us capture the client area.
    setWindowRect(this.hwnd, 0, 0, w, h, true);
    this.emitCapture(true);
    // WM_SIZE/WM_MOVE is asynchronous in the native message loop; sample the
    // client rect again after it has settled.
    const t = setTimeout(() => {
      if (this.hwnd && isWindow(this.hwnd)) this.emitCapture();
    }, 150);
    t.unref?.();
    focusWindow(this.hwnd);
    return true;
  }

  startWatch() {
    this.clearWatch();
    this.watchTimer = setInterval(() => {
      try {
        this.watchTick();
      } catch (e) {
        this.emit('log', `window watch: ${e.message}`);
      }
    }, 3000);
    this.watchTimer.unref?.();
  }

  watchTick() {
    if (this.stopping || (!this.proc && !this.attached)) return;

    if (!this.hwnd || !isWindow(this.hwnd)) {
      const hwnd = this.findTargetWindow();
      if (hwnd && isWindow(hwnd)) {
        this.adoptWindow(hwnd, { attached: this.attached });
      } else if (this.state !== 'no-window') {
        this.state = 'no-window';
        this.lastRect = null;
        this.lastRectKey = '';
        this.emit('state', this.status());
        this.emit('log', this.attached
          ? 'attached cabinet window lost; waiting for it to return'
          : 'cabinet window lost; waiting for it to return');
      }
      return;
    }

    const rect = this.captureRect();
    if (rect && (rect.x < 0 || rect.y < 0)) {
      // The window was dragged partly off-screen; snap it back so gdigrab has
      // a valid client area.
      this.placeWindow();
    } else {
      this.emitCapture();
    }

    const w = this.config.game.width || 656;
    const h = this.config.game.height || 519;
    keepTopmost(this.hwnd, 0, 0, w, h);
    // Only steal focus while a browser player has recently sent input.
    if (Date.now() - this.lastInputAt < 15000 && getForegroundWindow() !== this.hwnd) {
      if (focusWindow(this.hwnd)) this.input.resend();
    }
  }

  clearWatch() {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
  }

  clearRestartTimer() {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  scheduleRestart() {
    if (this.stopping || this.restartTimer) return;
    const base = this.config.game.restartDelayMs || 2500;
    const delay = Math.min(base * (2 ** Math.min(this.crashCount, 3)), 20000);
    this.crashCount++;
    this.emit('log', `cabinet restart in ${delay}ms`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping) return;
      this.start().catch((e) => this.emit('log', `restart failed: ${e.message}`));
    }, delay);
    this.restartTimer.unref?.();
  }

  applyInput(player, mask) {
    if (!this.hwnd) return;
    this.lastInputAt = Date.now();
    this.input.setMask(player, mask);
  }

  async tapStart(player = 1) {
    if (!this.hwnd) return;
    this.lastInputAt = Date.now();
    await this.input.tapStart(player);
  }

  async tapKey(vk, hold = 120) {
    if (!this.hwnd) return;
    this.lastInputAt = Date.now();
    await this.input.tap(vk, hold);
  }

  async restart() {
    this.emit('log', 'cabinet restart requested');
    if (this.attached) {
      // Attach mode owns no process: re-discover the window, never spawn.
      this.clearWatch();
      this.hwnd = null;
      this.input.setWindow(null);
      this.state = 'no-window';
      this.lastRect = null;
      this.lastRectKey = '';
      this.emit('state', this.status());
      try {
        await this.attachExisting();
      } catch (e) {
        this.emit('log', `re-attach failed: ${e.message}`);
        this.startWatch();
      }
      return;
    }
    await this.stop();
    await sleep(900);
    await this.start();
  }

  async stop() {
    this.stopping = true;
    this.generation++;
    this.clearRestartTimer();
    this.clearWatch();
    this.input.releaseAll();
    const proc = this.proc;
    this.proc = null;
    this.hwnd = null;
    this.attached = false;
    this.attachPid = 0;
    this.lastRect = null;
    this.lastRectKey = '';
    this.input.setWindow(null);
    this.state = 'stopped';
    this.emit('state', this.status());
    if (proc && proc.pid) {
      await new Promise((resolve) => {
        const k = spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        k.on('exit', resolve);
        k.on('error', resolve);
        const t = setTimeout(resolve, 4000);
        t.unref?.();
      });
    }
  }
}
