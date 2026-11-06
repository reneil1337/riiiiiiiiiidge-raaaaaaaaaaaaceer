import koffi from 'koffi';
const user32 = koffi.load('user32.dll');
const keybd_event = user32.func('void keybd_event(uint8 vk, uint8 scan, uint32 flags, uintptr extra)');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const args = process.argv.slice(2);
for (const a of args) {
  const vk = parseInt(a, 16);
  keybd_event(vk, 0, 0, 0);
  await sleep(120);
  keybd_event(vk, 0, 2, 0);
  await sleep(400);
  console.log('key', a);
}
