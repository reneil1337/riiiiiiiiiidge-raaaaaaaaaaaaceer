import koffi from 'koffi';

const user32 = koffi.load('user32.dll');
const FindWindowW = user32.func('void *FindWindowW(str16 cls, str16 title)');
const SetWindowLongW = user32.func('int SetWindowLongW(void *hwnd, int index, int value)');
const SetWindowPos = user32.func('bool SetWindowPos(void *hwnd, void *after, int x, int y, int cx, int cy, uint flags)');
const ShowWindow = user32.func('bool ShowWindow(void *hwnd, int cmd)');
const SetForegroundWindow = user32.func('bool SetForegroundWindow(void *hwnd)');
const keybd_event = user32.func('void keybd_event(uint8 vk, uint8 scan, uint32 flags, uintptr extra)');

const hwnd = FindWindowW(null, 'RR4-LAN');
console.log('hwnd', hwnd);
if (hwnd) {
  // WS_POPUP | WS_VISIBLE
  SetWindowLongW(hwnd, -16, 0x80000000 | 0x10000000);
  SetWindowPos(hwnd, -1, 0, 0, 1280, 960, 0x0020 | 0x0040);
  ShowWindow(hwnd, 5);
  SetForegroundWindow(hwnd);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const tap = async (vk, hold = 80) => {
  keybd_event(vk, 0, 0, 0);
  await sleep(hold);
  keybd_event(vk, 0, 2, 0);
  await sleep(120);
};

await sleep(800);
// Start / skip intro
await tap(0x0d, 250);
await sleep(2500);
// Move menu selection down and up
await tap(0x28);
await sleep(700);
await tap(0x26);
await sleep(700);
// P2 pad button (I / triangle) to prove the second port is polled
await tap(0x49, 200);
console.log('done');
