import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { FolderWatcher } from '../src/main/folderWatcher';

function createValidMp4Buffer(payloadBytes = 4096): Buffer {
  // Valid ISO BMFF ftyp box (24 bytes) + mdat box
  const ftyp = Buffer.from([
    0x00, 0x00, 0x00, 0x18, // size = 24
    0x66, 0x74, 0x79, 0x70, // 'ftyp'
    0x69, 0x73, 0x6f, 0x6d, // 'isom'
    0x00, 0x00, 0x02, 0x00, // minor_version
    0x69, 0x73, 0x6f, 0x6d, // compatible_brands: isom
    0x6d, 0x70, 0x34, 0x32  // mp42
  ]);
  const mdatSize = 8 + payloadBytes;
  const mdatHeader = Buffer.alloc(8);
  mdatHeader.writeUInt32BE(mdatSize, 0);
  mdatHeader.write('mdat', 4, 'ascii');
  const payload = crypto.randomBytes(payloadBytes);
  return Buffer.concat([ftyp, mdatHeader, payload]);
}

function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
  stepMs = 40
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        reject(new Error('Timed out waiting for condition'));
        return;
      }
      setTimeout(check, stepMs);
    };
    check();
  });
}

describe('FolderWatcher & Download Stability Engine', () => {
  let tempDir: string;
  let watcher: FolderWatcher;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evd-watcher-test-'));
    watcher = new FolderWatcher({
      stabilityWindowMs: 180,
      pollIntervalMs: 50,
      maxInvalidWaitMs: 500
    });
    await watcher.startWatching(tempDir);
  });

  afterEach(async () => {
    await watcher.stopWatching();
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  it('waits for Chrome .crdownload temp file and file size stability before marking ready, without modifying source file', async () => {
    const tempDownloadPath = path.join(tempDir, 'openart_clip.mp4.crdownload');
    const finalVideoPath = path.join(tempDir, 'openart_clip.mp4');
    const validMp4 = createValidMp4Buffer(16384);
    const originalSha256 = crypto.createHash('sha256').update(validMp4).digest('hex');

    // Step 1: Browser creates .crdownload file
    await fs.promises.writeFile(tempDownloadPath, validMp4.subarray(0, 2048));
    await waitFor(() => watcher.getSnapshot().activeBrowserDownloadsCount === 1);
    expect(watcher.getSnapshot().videos).toHaveLength(0);

    // Step 2: Browser renames to .mp4 (first half written, then finishes)
    await fs.promises.rename(tempDownloadPath, finalVideoPath);
    await waitFor(() => watcher.getSnapshot().videos.length === 1);

    // Immediately after appearing, it must be in waiting_complete, NOT prematurely ready
    const firstSeen = watcher.getSnapshot().videos[0];
    expect(firstSeen.status).toBe('waiting_complete');

    // Simulate final bytes flushing
    await fs.promises.writeFile(finalVideoPath, validMp4);

    // Step 3: After stability window, transitions to ready
    await waitFor(() => watcher.getSnapshot().videos[0]?.status === 'ready');

    const readyVideo = watcher.getSnapshot().videos[0];
    expect(readyVideo.fileName).toBe('openart_clip.mp4');
    expect(readyVideo.sizeBytes).toBe(validMp4.length);
    expect(readyVideo.extension).toBe('mp4');

    // Verify source file was strictly read-only (bit-for-bit identical)
    const afterBytes = await fs.promises.readFile(finalVideoPath);
    const afterSha256 = crypto.createHash('sha256').update(afterBytes).digest('hex');
    expect(afterSha256).toBe(originalSha256);
  });

  it('keeps MOV file in waiting_complete while companion .part file exists', async () => {
    const movPath = path.join(tempDir, 'google_flow_export.MOV');
    const partPath = path.join(tempDir, 'google_flow_export.MOV.part');
    const validMov = createValidMp4Buffer(8192);

    await fs.promises.writeFile(partPath, Buffer.from('partial'));
    await fs.promises.writeFile(movPath, validMov);

    await waitFor(() => watcher.getSnapshot().videos.length === 1);
    await new Promise((r) => setTimeout(r, 260));
    expect(watcher.getSnapshot().videos[0].status).toBe('waiting_complete');

    // Once Firefox removes .part, file stabilizes and becomes ready
    await fs.promises.unlink(partPath);
    await waitFor(() => watcher.getSnapshot().videos[0]?.status === 'ready');
    expect(watcher.getSnapshot().videos[0].mimeType).toBe('video/quicktime');
  });

  it('ignores non-video files and marks corrupt non-MP4 files as invalid', async () => {
    await fs.promises.writeFile(path.join(tempDir, 'notes.txt'), 'hello');
    await fs.promises.writeFile(path.join(tempDir, 'image.png'), Buffer.alloc(128));
    await fs.promises.writeFile(
      path.join(tempDir, 'corrupt_fake.mp4'),
      Buffer.from('NOT_AN_MP4_HEADER_AT_ALL_1234567890')
    );

    await waitFor(() => watcher.getSnapshot().videos[0]?.status === 'invalid');
    const snap = watcher.getSnapshot();
    expect(snap.videos).toHaveLength(1);
    expect(snap.videos[0].fileName).toBe('corrupt_fake.mp4');
    expect(snap.videos[0].status).toBe('invalid');
  });
});
