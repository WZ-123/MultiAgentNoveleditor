import { createRequire } from 'node:module';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const { chromium } = require('/Users/potablewater/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const [, , inputPath, outputPath] = process.argv;

if (!inputPath || !outputPath) {
  console.error('Usage: node extract_last_frame_browser.mjs <input-video> <output-png>');
  process.exit(2);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const inputStat = await stat(inputPath);

const server = createServer((request, response) => {
  if (request.url !== '/video.mp4') {
    response.writeHead(404);
    response.end();
    return;
  }

  const range = request.headers.range;
  if (range) {
    const match = range.match(/bytes=(\d+)-(\d*)/);
    const start = match ? Number(match[1]) : 0;
    const end = match && match[2] ? Number(match[2]) : inputStat.size - 1;
    response.writeHead(206, {
      'Content-Type': 'video/mp4',
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${inputStat.size}`,
      'Accept-Ranges': 'bytes',
    });
    createReadStream(inputPath, { start, end }).pipe(response);
    return;
  }

  response.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Content-Length': inputStat.size,
    'Accept-Ranges': 'bytes',
  });
  createReadStream(inputPath).pipe(response);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const videoUrl = `http://127.0.0.1:${address.port}/video.mp4`;

await page.setContent(`
  <html>
    <body style="margin:0;background:#111">
      <video id="video" crossorigin="anonymous" muted playsinline preload="auto" src="${videoUrl}"></video>
      <canvas id="canvas"></canvas>
    </body>
  </html>
`);

const result = await page.evaluate(async () => {
  const video = document.getElementById('video');
  const canvas = document.getElementById('canvas');
  const context = canvas.getContext('2d');

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out loading metadata')), 15000);
    video.addEventListener('loadedmetadata', () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
    video.addEventListener('error', () => reject(new Error(`Video load error: ${video.error?.message || video.error?.code || 'unknown'}`)), { once: true });
    video.load();
  });

  const fpsGuess = 30;
  const target = Math.max(0, video.duration - (1 / fpsGuess));
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out seeking near video end')), 15000);
    video.addEventListener('seeked', () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
    video.currentTime = target;
  });

  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  context.drawImage(video, 0, 0, canvas.width, canvas.height);

  return {
    duration: video.duration,
    currentTime: video.currentTime,
    width: canvas.width,
    height: canvas.height,
    dataUrl: canvas.toDataURL('image/png'),
  };
});

await browser.close();
server.close();

const png = Buffer.from(result.dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
await writeFile(outputPath, png);
console.log(JSON.stringify({
  outputPath,
  duration: result.duration,
  frameTime: result.currentTime,
  width: result.width,
  height: result.height,
}, null, 2));
