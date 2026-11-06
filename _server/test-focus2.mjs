import koffi from 'koffi';
const u = koffi.load('user32.dll');
const k = koffi.load('kernel32.dll');
const FindWindowW = u.func('void* FindWindowW(str16 cls, str16 title)');
const GetForegroundWindow = u.func('void* GetForegroundWindow()');
const GetWindowThreadProcessId = u.func('uint32 GetWindowThreadProcessId(void* h, _Out_ uint32* pid)');
const AttachThreadInput = u.func('bool AttachThreadInput(uint32 a, uint32 b, bool attach)');
const SetForegroundWindow = u.func('bool SetForegroundWindow(void* h)');
const BringWindowToTop = u.func('bool BringWindowToTop(void* h)');
const SetActiveWindow = u.func('void* SetActiveWindow(void* h)');
const SetFocus = u.func('void* SetFocus(void* h)');
const SwitchToThisWindow = u.func('void SwitchToThisWindow(void* h, bool alt)');
const keybd_event = u.func('void keybd_event(uint8 vk, uint8 scan, uint32 flags, uintptr extra)');
const GetCurrentThreadId = k.func('uint32 GetCurrentThreadId()');

const h = FindWindowW(null, 'RR4-LAN');
console.log('hwnd', h);
const pid = [0];
const targetThread = GetWindowThreadProcessId(h, pid);
const fg = GetForegroundWindow();
const fgPid = [0];
const fgThread = GetWindowThreadProcessId(fg, fgPid);
const me = GetCurrentThreadId();
console.log({ targetThread, fgThread, me, fgPid: fgPid[0], pid: pid[0] });

// Alt-tap unlock
keybd_event(0x12, 0, 0, 0); keybd_event(0x12, 0, 2, 0);
AttachThreadInput(me, targetThread, true);
AttachThreadInput(me, fgThread, true);
BringWindowToTop(h);
SetActiveWindow(h);
SetFocus(h);
const ok = SetForegroundWindow(h);
AttachThreadInput(me, fgThread, false);
AttachThreadInput(me, targetThread, false);
SwitchToThisWindow(h, true);
await new Promise(r => setTimeout(r, 600));
console.log('set ok', ok, 'now fg', GetForegroundWindow(), 'is game', GetForegroundWindow() === h);

keybd_event(0x0d, 0, 0, 0); await new Promise(r => setTimeout(r, 120));
keybd_event(0x0d, 0, 2, 0);
