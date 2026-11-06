// Regenerate public/img/lan-qr.svg for the current LAN address.
// Usage: node make-qr.mjs [url]
import os from 'node:os';
import fs from 'node:fs';
import QRCode from 'qrcode';

function lanUrl() {
  const candidates = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const info of list || []) {
      if (info.family !== 'IPv4' || info.internal || info.address.startsWith('169.254.')) continue;
      candidates.push({ name, address: info.address });
    }
  }
  const preferred = candidates.find(c => /^(WLAN|Wi-Fi|Ethernet)/i.test(c.name) && !/tailscale/i.test(c.name))
    || candidates.find(c => c.address.startsWith('192.168.'))
    || candidates.find(c => /^(10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(c.address))
    || candidates[0];
  return preferred ? `http://${preferred.address}:8080/` : 'http://localhost:8080/';
}

const url = process.argv[2] || lanUrl();
const svg = await QRCode.toString(url, {
  type: 'svg',
  margin: 1,
  width: 256,
  color: { dark: '#08090d', light: '#ffffff' },
});
fs.mkdirSync(new URL('./public/img/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('./public/img/lan-qr.svg', import.meta.url), svg);
console.log(`QR -> ${url}`);
