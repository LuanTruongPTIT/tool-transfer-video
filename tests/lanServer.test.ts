import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { FolderWatcher } from '../src/main/folderWatcher';
import { AuthManager } from '../src/main/authManager';
import { LanServer } from '../src/main/lanServer';
import { MobileVideoItem } from '../src/shared/types';

function createValidMp4Buffer(payloadBytes: number): Buffer {
  const ftyp = Buffer.from([
    0x00, 0x00, 0x00, 0x18,
    0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d,
    0x00, 0x00, 0x02, 0x00,
    0x69, 0x73, 0x6f, 0x6d,
    0x6d, 0x70, 0x34, 0x32
  ]);
  const mdatHeader = Buffer.alloc(8);
  mdatHeader.writeUInt32BE(8 + payloadBytes, 0);
  mdatHeader.write('mdat', 4, 'ascii');
  const payload = crypto.randomBytes(payloadBytes);
  return Buffer.concat([ftyp, mdatHeader, payload]);
}

function waitFor(predicate: () => boolean, timeoutMs = 5000, stepMs = 40): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        reject(new Error('Timed out waiting for condition'));
        return;
      }
      setTimeout(tick, stepMs);
    };
    tick();
  });
}

describe('LanServer End-to-End Streaming, Auth & iOS Transfer States', () => {
  let tempDir: string;
  let watcher: FolderWatcher;
  let auth: AuthManager;
  let server: LanServer;
  let baseUrl: string;
  let port: number;
  let videoBuffer: Buffer;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evd-server-test-'));
    videoBuffer = createValidMp4Buffer(512 * 1024); // 512 KB + headers (>8 stream chunks)
    const videoFile = path.join(tempDir, 'Video_Mẫu_Áo_Thun_AI.mp4');
    await fs.promises.writeFile(videoFile, videoBuffer);

    watcher = new FolderWatcher({
      stabilityWindowMs: 80,
      pollIntervalMs: 30
    });
    await watcher.startWatching(tempDir);
    await waitFor(() => watcher.getSnapshot().videos[0]?.status === 'ready');

    auth = new AuthManager();
    server = new LanServer(watcher, auth, {
      rendererDistDir: path.resolve(__dirname, '../dist/renderer'),
      allowLoopbackForTests: true,
      abortGraceMs: 80
    });
    await server.start('127.0.0.1', 0);
    port = server.getPairingInfo().port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await server.stop();
    await watcher.stopWatching();
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  it('blocks DNS rebinding Host headers and unauthenticated API calls', async () => {
    const dnsRebindStatus = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/api/session',
          method: 'GET',
          headers: { Host: 'evil-rebind.example.com' }
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }
      );
      req.on('error', reject);
      req.end();
    });
    expect(dnsRebindStatus).toBe(403);

    const unauthVideos = await fetch(`${baseUrl}/api/videos`);
    expect(unauthVideos.status).toBe(401);
  });

  it('supports iOS Safari 206 Range preview, detects mid-stream abort, retries full download to downloaded_to_safari, and confirms saved_to_photos', async () => {
    // 1. Pair iPhone via QR key + 6-digit PIN
    const pairRes = await fetch(`${baseUrl}/api/pair`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: baseUrl
      },
      body: JSON.stringify({
        qrKey: auth.getQrKey(),
        pinCode: auth.getPinCode()
      })
    });
    expect(pairRes.status).toBe(200);
    const setCookie = pairRes.headers.get('set-cookie');
    expect(setCookie).toBeTruthy();
    const sessionCookie = setCookie!.split(';')[0];

    // 2. Fetch ready videos with signed preview/download URLs
    const listRes = await fetch(`${baseUrl}/api/videos`, {
      headers: { Cookie: sessionCookie }
    });
    expect(listRes.status).toBe(200);
    const listData = (await listRes.json()) as { videos: MobileVideoItem[] };
    expect(listData.videos).toHaveLength(1);
    const vid = listData.videos[0];
    expect(vid.fileName).toBe('Video_Mẫu_Áo_Thun_AI.mp4');

    // 3. iOS Safari <video> initial 2-byte Range probe (Range: bytes=0-1)
    const rangeProbe = await fetch(`${baseUrl}${vid.previewUrl}`, {
      headers: { Range: 'bytes=0-1' }
    });
    expect(rangeProbe.status).toBe(206);
    expect(rangeProbe.headers.get('accept-ranges')).toBe('bytes');
    expect(rangeProbe.headers.get('content-range')).toBe(`bytes 0-1/${videoBuffer.length}`);
    const probeBytes = Buffer.from(await rangeProbe.arrayBuffer());
    expect(probeBytes).toEqual(videoBuffer.subarray(0, 2));

    // QuickTime suffix range probe (Range: bytes=-100)
    const suffixProbe = await fetch(`${baseUrl}${vid.previewUrl}`, {
      headers: { Range: 'bytes=-100' }
    });
    expect(suffixProbe.status).toBe(206);
    const suffixBytes = Buffer.from(await suffixProbe.arrayBuffer());
    expect(suffixBytes).toEqual(videoBuffer.subarray(videoBuffer.length - 100));

    // Preview must NOT change video status away from ready
    expect(watcher.getSnapshot().videos[0].status).toBe('ready');

    // 4. Simulate mid-transfer Wi-Fi drop (abort socket after first chunk)
    await new Promise<void>((resolve, reject) => {
      const req = http.get(`${baseUrl}${vid.downloadUrl}`, (res) => {
        res.once('data', () => {
          req.destroy();
          resolve();
        });
      });
      req.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ECONNRESET') resolve();
        else reject(err);
      });
    });

    await waitFor(() => watcher.getSnapshot().videos[0]?.status === 'transfer_error');

    // 5. Retry full download -> transitions to downloaded_to_safari (NOT saved_to_photos yet!)
    const fullDlRes = await fetch(`${baseUrl}${vid.downloadUrl}`);
    expect(fullDlRes.status).toBe(200);
    expect(fullDlRes.headers.get('content-disposition')).toContain("filename*=UTF-8''");
    const downloadedBuf = Buffer.from(await fullDlRes.arrayBuffer());
    expect(downloadedBuf.equals(videoBuffer)).toBe(true);

    await waitFor(() => watcher.getSnapshot().videos[0]?.status === 'downloaded_to_safari');
    expect(watcher.getSnapshot().videos[0].downloadCount).toBe(1);

    // 6. User saves from Safari Downloads into Apple Photos and taps Confirm
    const confirmRes = await fetch(`${baseUrl}/api/videos/${vid.id}/confirm-photos`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: sessionCookie,
        Origin: baseUrl
      },
      body: JSON.stringify({ confirmed: true })
    });
    expect(confirmRes.status).toBe(200);
    expect(watcher.getSnapshot().videos[0].status).toBe('saved_to_photos');
  });

  it('serves self-contained Mobile Web UI assets, streams large files with flat heap memory, and pushes SSE updates', async () => {
    // Verify mobile index.html and static bundle load offline without external CDNs
    const htmlRes = await fetch(`${baseUrl}/`);
    expect(htmlRes.status).toBe(200);
    const htmlText = await htmlRes.text();
    expect(htmlText).toContain('Ecom Video Drop');
    const jsMatch = htmlText.match(/src="\.\.(\/assets\/[^"]+\.js)"/);
    expect(jsMatch).toBeTruthy();

    const assetRes = await fetch(`${baseUrl}${jsMatch![1]}`);
    expect(assetRes.status).toBe(200);

    // Block path traversal on /assets/
    const traversalStatus = await new Promise<number>((resolve, reject) => {
      const req = http.get(`${baseUrl}/assets/../../package.json`, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
    });
    expect([302, 403, 404]).toContain(traversalStatus);

    // Pair session
    const pairRes = await fetch(`${baseUrl}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: baseUrl },
      body: JSON.stringify({ qrKey: auth.getQrKey(), pinCode: auth.getPinCode() })
    });
    const sessionCookie = pairRes.headers.get('set-cookie')!.split(';')[0];

    // Write a 32 MB MP4 file and verify streaming keeps heap delta minimal
    const largePath = path.join(tempDir, 'large_ai_render.mp4');
    const header = createValidMp4Buffer(1024);
    const writeStream = fs.createWriteStream(largePath);
    writeStream.write(header);
    const chunk1Mb = Buffer.alloc(1024 * 1024, 0x42);
    for (let i = 0; i < 32; i++) {
      writeStream.write(chunk1Mb);
    }
    await new Promise<void>((resolve) => writeStream.end(() => resolve()));

    await waitFor(
      () =>
        watcher
          .getSnapshot()
          .videos.some((v) => v.fileName === 'large_ai_render.mp4' && v.status === 'ready'),
      6000
    );

    const listRes = await fetch(`${baseUrl}/api/videos`, {
      headers: { Cookie: sessionCookie }
    });
    const listData = (await listRes.json()) as { videos: MobileVideoItem[] };
    const largeVideo = listData.videos.find((v) => v.fileName === 'large_ai_render.mp4')!;
    expect(largeVideo).toBeTruthy();

    const heapBefore = process.memoryUsage().heapUsed;
    let totalReceived = 0;

    await new Promise<void>((resolve, reject) => {
      http.get(`${baseUrl}${largeVideo.downloadUrl}`, (res) => {
        expect(res.statusCode).toBe(200);
        res.on('data', (chunk: Buffer) => {
          totalReceived += chunk.length;
        });
        res.on('end', () => resolve());
        res.on('error', reject);
      });
    });

    const heapAfter = process.memoryUsage().heapUsed;
    expect(totalReceived).toBe(largeVideo.sizeBytes);
    // Heap growth should remain far below the 32 MB file size
    expect(heapAfter - heapBefore).toBeLessThan(12 * 1024 * 1024);
  });
});
