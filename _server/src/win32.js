// Minimal Win32 bridge used by the LAN cabinet:
//  - find / style / focus the native game window
//  - inject keyboard state with keybd_event
// Everything is local to this machine; no native build step required.
import koffi from 'koffi';

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');

const FindWindowW = user32.func('void *FindWindowW(str16 cls, str16 title)');
const IsWindow = user32.func('bool IsWindow(void *h)');
const GetForegroundWindow = user32.func('void *GetForegroundWindow()');
const GetWindowThreadProcessId = user32.func('uint32 GetWindowThreadProcessId(void *h, _Out_ uint32 *pid)');
const AttachThreadInput = user32.func('bool AttachThreadInput(uint32 a, uint32 b, bool attach)');
const SetForegroundWindow = user32.func('bool SetForegroundWindow(void *h)');
const BringWindowToTop = user32.func('bool BringWindowToTop(void *h)');
const SetActiveWindow = user32.func('void *SetActiveWindow(void *h)');
const SetFocus = user32.func('void *SetFocus(void *h)');
const SwitchToThisWindow = user32.func('void SwitchToThisWindow(void *h, bool alt)');
const SetWindowLongW = user32.func('int SetWindowLongW(void *h, int index, int value)');
const SetWindowPos = user32.func('bool SetWindowPos(void *h, void *after, int x, int y, int cx, int cy, uint flags)');
const ShowWindow = user32.func('bool ShowWindow(void *h, int cmd)');
const GetWindowRect = user32.func('bool GetWindowRect(void *h, _Out_ int32 *r)');
const GetClientRect = user32.func('bool GetClientRect(void *h, _Out_ int32 *r)');
const ClientToScreen = user32.func('bool ClientToScreen(void *h, _Out_ int32 *p)');
const keybd_event = user32.func('void keybd_event(uint8 vk, uint8 scan, uint32 flags, uintptr extra)');
const MapVirtualKeyW = user32.func('uint32 MapVirtualKeyW(uint32 code, uint32 mapType)');
const GetCurrentThreadId = kernel32.func('uint32 GetCurrentThreadId()');
const EnumWindowsProc = koffi.proto('bool EnumWindowsProc(void *hwnd, intptr lParam)');
const EnumWindows = user32.func('bool EnumWindows(EnumWindowsProc *cb, intptr lParam)');
const IsWindowVisible = user32.func('bool IsWindowVisible(void *h)');
const GetWindowTextLengthW = user32.func('int GetWindowTextLengthW(void *h)');

export const HWND_TOPMOST = -1;
export const WS_POPUP = 0x80000000;
export const WS_VISIBLE = 0x10000000;
export const SWP_FRAMECHANGED = 0x0020;
export const SWP_SHOWWINDOW = 0x0040;
export const KEYEVENTF_EXTENDEDKEY = 0x0001;
export const KEYEVENTF_KEYUP = 0x0002;

export function findWindow(title) {
  try { return FindWindowW(null, title) || null; } catch { return null; }
}

export function findWindowByPid(pid) {
  if (!pid) return null;
  let first = null;
  let found = null;
  let cb = null;
  try {
    cb = koffi.register((hwnd) => {
      const p = [0];
      GetWindowThreadProcessId(hwnd, p);
      if (p[0] !== pid) return true;
      if (!first) first = hwnd;
      // Prefer the visible, titled SDL window over hidden helper windows.
      if (IsWindowVisible(hwnd) && GetWindowTextLengthW(hwnd) > 0) {
        found = hwnd;
        return false;
      }
      return true;
    }, koffi.pointer(EnumWindowsProc));
    EnumWindows(cb, 0);
  } catch {
    found = null;
  } finally {
    if (cb) {
      try { koffi.unregister(cb); } catch { /* ignore */ }
    }
  }
  return found || first;
}

export function isWindow(hwnd) {
  return !!hwnd && IsWindow(hwnd);
}

export function getForegroundWindow() {
  return GetForegroundWindow() || null;
}

export function getWindowPid(hwnd) {
  const pid = [0];
  GetWindowThreadProcessId(hwnd, pid);
  return pid[0];
}

export function makeBorderless(hwnd, x, y, w, h) {
  if (!isWindow(hwnd)) return false;
  SetWindowLongW(hwnd, -16, WS_POPUP | WS_VISIBLE);
  SetWindowPos(hwnd, HWND_TOPMOST, x, y, w, h, SWP_FRAMECHANGED | SWP_SHOWWINDOW);
  ShowWindow(hwnd, 5);
  return true;
}

export function keepTopmost(hwnd, x, y, w, h) {
  if (!isWindow(hwnd)) return false;
  SetWindowPos(hwnd, HWND_TOPMOST, x, y, w, h, 0x0002 | 0x0001 | 0x0010);
  return true;
}

// Resize/move without touching the window style. Style changes can make the
// SDL/OpenGL window re-create itself, which some runtimes treat as a quit.
export function setWindowRect(hwnd, x, y, w, h, topmost = true) {
  if (!isWindow(hwnd)) return false;
  SetWindowPos(hwnd, topmost ? HWND_TOPMOST : null, x, y, w, h, SWP_SHOWWINDOW);
  return true;
}

export function getClientCaptureRect(hwnd) {
  if (!isWindow(hwnd)) return null;
  const outer = [0, 0, 0, 0];
  const client = [0, 0, 0, 0];
  const pt = [0, 0];
  GetWindowRect(hwnd, outer);
  GetClientRect(hwnd, client);
  ClientToScreen(hwnd, pt);
  return {
    x: pt[0],
    y: pt[1],
    w: client[2] - client[0],
    h: client[3] - client[1],
    outerW: outer[2] - outer[0],
    outerH: outer[3] - outer[1],
  };
}

export function focusWindow(hwnd) {
  if (!isWindow(hwnd)) return false;
  if (getForegroundWindow() === hwnd) return true;
  const fg = getForegroundWindow();
  const fgThread = fg ? GetWindowThreadProcessId(fg, null) : 0;
  const me = GetCurrentThreadId();
  let attached = false;
  if (fgThread) {
    try { attached = AttachThreadInput(me, fgThread, true); } catch { attached = false; }
  }
  SetForegroundWindow(hwnd);
  BringWindowToTop(hwnd);
  SetActiveWindow(hwnd);
  SetFocus(hwnd);
  if (attached) {
    try { AttachThreadInput(me, fgThread, false); } catch { /* ignore */ }
  }
  if (getForegroundWindow() !== hwnd) {
    try { SwitchToThisWindow(hwnd, true); } catch { /* ignore */ }
  }
  return getForegroundWindow() === hwnd;
}

const EXTENDED_VKS = new Set([0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E, 0x24, 0x23, 0x21, 0x22, 0x90, 0x91]);

export function sendKey(vk, down) {
  const scan = MapVirtualKeyW(vk, 0) & 0xFF;
  let flags = down ? 0 : KEYEVENTF_KEYUP;
  if (EXTENDED_VKS.has(vk)) flags |= KEYEVENTF_EXTENDEDKEY;
  keybd_event(vk, scan, flags, 0);
}

export async function tapKey(vk, holdMs = 110) {
  sendKey(vk, true);
  await new Promise(r => setTimeout(r, holdMs));
  sendKey(vk, false);
}

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
