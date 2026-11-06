import { spawn } from 'node:child_process';
import fs from 'node:fs';

const root = '.';
const ff = '../_tools/ffmpeg/bin/ffmpeg.exe';
const out = '../_runtime/av-test.ts';
try { fs.unlinkSync(out); } catch {}

const audio = spawn('py', ['-3', 'src/audio.py'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
audio.stderr.on('data', d => process.stderr.write(d));
const args = [
  '-y', '-hide_banner', '-loglevel', 'warning',
  '-f', 'gdigrab', '-framerate', '60', '-offset_x', '0', '-offset_y', '0', '-video_size', '1280x960', '-i', 'desktop',
  '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0',
  '-t', '5',
  '-vf', 'scale=960:720:flags=fast_bilinear',
  '-c:v', 'mpeg1video', '-b:v', '6M', '-maxrate', '8M', '-bufsize', '4M', '-g', '30', '-bf', '0', '-r', '60',
  '-c:a', 'mp2', '-b:a', '128k', '-ar', '44100', '-ac', '2',
  '-muxdelay', '0', '-muxpreload', '0', '-flush_packets', '1',
  '-f', 'mpegts', out,
];
const proc = spawn(ff, args, { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
audio.stdout.pipe(proc.stdin);
proc.stderr.on('data', d => process.stderr.write(d));
proc.on('exit', (code) => {
  console.log('ffmpeg exit', code);
  try { audio.kill(); } catch {}
  if (fs.existsSync(out)) console.log('size', fs.statSync(out).size);
});
setTimeout(() => { try { audio.kill(); } catch {} }, 9000);
