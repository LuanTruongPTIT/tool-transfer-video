import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  EncodedPacket,
  EncodedVideoPacketSource,
  FilePathTarget,
  MkvOutputFormat,
  Output
} from 'mediabunny';
import { FolderWatcher } from '../src/main/folderWatcher';
import { AuthManager } from '../src/main/authManager';
import { LanServer } from '../src/main/lanServer';
import { MobileVideoItem } from '../src/shared/types';

async function generateGenuineH264MkvFile(filePath: string): Promise<Buffer> {
  // Minimal valid AVCC (avcC) decoderConfigurationRecord + H.264 IDR slice packet
  const sps = Buffer.from([0x67, 0x42, 0xc0, 0x1e, 0xd9, 0x01, 0x41, 0xfb, 0x01, 0x10, 0x00, 0x00, 0x03, 0x00, 0x10, 0x00, 0x00, 0x03, 0x03, 0xc0, 0xf1, 0x42, 0x99, 0x60]);
  const pps = Buffer.from([0x68, 0xcb, 0x83, 0xcb, 0x20]);

  const avcC = Buffer.concat([
    Buffer.from([
      0x01, // configurationVersion
      sps[1], // AVCProfileIndication
      sps[2], // profile_compatibility
      sps[3], // AVCLevelIndication
      0xff, // lengthSizeMinusOne = 3 (4-byte NAL length)
      0xe1 // numOfSequenceParameterSets = 1
    ]),
    Buffer.from([(sps.length >> 8) & 0xff, sps.length & 0xff]),
    sps,
    Buffer.from([0x01]), // numOfPictureParameterSets = 1
    Buffer.from([(pps.length >> 8) & 0xff, pps.length & 0xff]),
    pps
  ]);

  const idrPayload = Buffer.from([0x65, 0x88, 0x84, 0x00, 0x10, 0xff, 0xff, 0xff]);
  const nalUnit = Buffer.alloc(4 + idrPayload.length);
  nalUnit.writeUInt32BE(idrPayload.length, 0);
  idrPayload.copy(nalUnit, 4);

  const output = new Output({
    format: new MkvOutputFormat(),
    target: new FilePathTarget(filePath)
  });

  const videoSource = new EncodedVideoPacketSource('avc');
  output.addVideoTrack(videoSource);
  await output.start();

  const packet = new EncodedPacket(nalUnit, 'key', 0, 1 / 30);
  await videoSource.add(packet, {
    decoderConfig: {
      codec: 'avc1.42c01e',
      codedWidth: 320,
      codedHeight: 240,
      description: avcC
    }
  });

  await output.finalize();
  return fs.promises.readFile(filePath);
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

describe('MKV Detection & Lossless iOS MP4 Container Remuxing', () => {
  let tempDir: string;
  let watcher: FolderWatcher;
  let auth: AuthManager;
  let server: LanServer;
  let baseUrl: string;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evd-mkv-test-'));
    watcher = new FolderWatcher({ stabilityWindowMs: 80, pollIntervalMs: 30 });
    auth = new AuthManager();
    server = new LanServer(watcher, auth, {
      rendererDistDir: path.resolve(__dirname, '../dist/renderer'),
      allowLoopbackForTests: true,
      abortGraceMs: 80
    });
    await watcher.startWatching(tempDir);
    await server.start('127.0.0.1', 0);
    baseUrl = `http://127.0.0.1:${server.getPairingInfo().port}`;
  });

  afterEach(async () => {
    await server.stop();
    await watcher.stopWatching();
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  it('detects MKV files, losslessly remuxes to MP4 for iPhone Safari/Photos, and keeps original MKV untouched', async () => {
    const mkvPath = path.join(tempDir, '2026-06-03 13-03-01.mkv');
    const originalMkvBytes = await generateGenuineH264MkvFile(mkvPath);
    const originalSha256 = crypto.createHash('sha256').update(originalMkvBytes).digest('hex');

    await waitFor(() => watcher.getSnapshot().videos[0]?.status === 'ready');
    const detected = watcher.getSnapshot().videos[0];
    expect(detected.extension).toBe('mkv');
    expect(detected.needsIosRemux).toBe(true);

    // Pair iPhone
    const pairRes = await fetch(`${baseUrl}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: baseUrl },
      body: JSON.stringify({ qrKey: auth.getQrKey(), pinCode: auth.getPinCode() })
    });
    const sessionCookie = pairRes.headers.get('set-cookie')!.split(';')[0];

    const listRes = await fetch(`${baseUrl}/api/videos`, {
      headers: { Cookie: sessionCookie }
    });
    const listData = (await listRes.json()) as { videos: MobileVideoItem[] };
    expect(listData.videos).toHaveLength(1);
    const vid = listData.videos[0];
    expect(vid.iosDownloadFileName).toBe('2026-06-03 13-03-01.mp4');

    // Download to iPhone -> receives valid MP4 container
    const dlRes = await fetch(`${baseUrl}${vid.downloadUrl}`);
    expect(dlRes.status).toBe(200);
    expect(dlRes.headers.get('content-type')).toBe('video/mp4');
    expect(dlRes.headers.get('content-disposition')).toContain('2026-06-03%2013-03-01.mp4');

    const mp4Buf = Buffer.from(await dlRes.arrayBuffer());
    expect(mp4Buf.subarray(4, 8).toString('ascii')).toBe('ftyp');

    // Verify original MKV on disk is 100% unmodified
    const afterMkvBytes = await fs.promises.readFile(mkvPath);
    const afterSha256 = crypto.createHash('sha256').update(afterMkvBytes).digest('hex');
    expect(afterSha256).toBe(originalSha256);
  });
});
