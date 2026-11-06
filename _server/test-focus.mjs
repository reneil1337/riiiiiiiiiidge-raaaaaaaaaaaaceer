import koffi from 'koffi';
const u = koffi.load('user32.dll');
const FindWindowW = u.func('void* FindWindowW(str16 cls, str16 title)');
const SetWindowLongW = u.func('int SetWindowLongW(void* h, int i, int v)');
const SetWindowPos = u.func('bool SetWindowPos(void* h, void* after, int x, int y, int cx, int cy, uint flags)');
const ShowWindow = u.func('bool ShowWindow(void* h, int c)');
const SetForegroundWindow = u.func('bool SetForegroundWindow(void* h)');
const GetForegroundWindow = u.func('void* GetForegroundWindow()');
const keybd_event = u.func('void keybd_event(uint8 vk, uint8 scan, uint32 flags, uintptr extra)');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const h = FindWindowW(null, 'RR4-LAN');
console.log('hwnd', h);
if (h) {
  SetWindowLongW(h, -16, 0x90000000);
  SetWindowPos(h, -1, 0, 0, 1280, 960, 0x60);
  ShowWindow(h, 5);
  SetForegroundWindow(h);
  await sleep(500);
  console.log('fg is game?', GetForegroundWindow() === h);
  for (let i = 0; i < 3; i++) {
    keybd_event(0x0d, 0, 0, 0); await sleep(120);
    keybd_event(0x0d, 0, 2, 0); await sleep(900);
  }
}
