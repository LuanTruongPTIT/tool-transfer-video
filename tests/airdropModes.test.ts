import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import https from 'node:https';
import tls from 'node:tls';
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
import { LocalSendBridge } from '../src/main/localSendBridge';
import { generateLocalSendTlsIdentity } from '../src/main/localSendCert';
import { MobileVideoItem } from '../src/shared/types';

function createValidMp4Buffer(sizeBytes: number): Buffer {
  const buf = Buffer.alloc(sizeBytes, 0x42);
  // Valid ISO BMFF ftyp box (24 bytes) + moov box header
  buf.writeUInt32BE(24, 0);
  buf.write('ftypisom', 4, 'ascii');
  buf.writeUInt32BE(0x200, 12);
  buf.write('isommp42', 16, 'ascii');
  buf.writeUInt32BE(sizeBytes - 24, 24);
  buf.write('mdat', 28, 'ascii');
  return buf;
}

async function createGenuineMkvFile(filePath: string): Promise<Buffer> {
  const sps = Buffer.from([
    0x67, 0x42, 0xc0, 0x1e, 0xd9, 0x01, 0x41, 0xfb, 0x01, 0x10, 0x00, 0x00, 0x03, 0x00, 0x10, 0x00,
    0x00, 0x03, 0x03, 0xc0, 0xf1, 0x42, 0x99, 0x60
  ]);
  const pps = Buffer.from([0x68, 0xcb, 0x83, 0xcb, 0x20]);
  const avcC = Buffer.concat([
    Buffer.from([0x01, sps[1], sps[2], sps[3], 0xff, 0xe1]),
    Buffer.from([(sps.length >> 8) & 0xff, sps.length & 0xff]),
    sps,
    Buffer.from([0x01, (pps.length >> 8) & 0xff, pps.length & 0xff]),
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
  await videoSource.add(new EncodedPacket(nalUnit, 'key', 0, 1 / 30), {
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

function waitFor(predicate: () => boolean, timeoutMs = 6000, stepMs = 40): Promise<void> {
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

describe('Cách 2 (LocalSend AirDrop Auto-Push) & Cách 3 (Apple Shortcuts 1-Tap)', () => {
  let tempDir: string;
  let watcher: FolderWatcher;
  let auth: AuthManager;
  let server: LanServer;
  let bridge: LocalSendBridge;
  let baseUrl: string;

  // Mock iPhone LocalSend Receiver Server (HTTPS + mandatory mTLS client cert like LocalSend rustls)
  let mockIphoneServer: https.Server | null = null;
  let mockIphonePort = 0;
  let receivedUploads: Array<{
    fileId: string;
    fileName: string;
    fileType: string;
    clientCertFingerprint: string;
    body: Buffer;
  }> = [];

  beforeEach(async () => {
    receivedUploads = [];
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evd-airdrop-test-'));
    watcher = new FolderWatcher({ stabilityWindowMs: 80, pollIntervalMs: 30 });
    auth = new AuthManager();
    server = new LanServer(watcher, auth, {
      rendererDistDir: path.resolve(__dirname, '../dist/renderer'),
      allowLoopbackForTests: true,
      abortGraceMs: 80,
      getIcloudShortcutUrl: () => 'https://www.icloud.com/shortcuts/0123456789abcdef0123456789abcdef'
    });
    const senderIdentity = generateLocalSendTlsIdentity();
    bridge = new LocalSendBridge(watcher, server.getMkvRemuxer(), {
      fingerprint: senderIdentity.fingerprint,
      privateKeyPem: senderIdentity.privateKeyPem,
      certificatePem: senderIdentity.certificatePem,
      alias: 'Ecom PC Test',
      allowLoopbackForTests: true
    });
    server.setLocalSendBridge(bridge);

    await watcher.startWatching(tempDir);
    await server.start('127.0.0.1', 0);
    baseUrl = `http://127.0.0.1:${server.getPairingInfo().port}`;

    // Start mock iPhone LocalSend v2.1 HTTPS mTLS server
    const iphoneTls = generateLocalSendTlsIdentity();
    const pendingMeta = new Map<string, { fileName: string; fileType: string }>();
    mockIphoneServer = https.createServer(
      {
        key: iphoneTls.privateKeyPem,
        cert: iphoneTls.certificatePem,
        requestCert: true,
        rejectUnauthorized: false // Self-signed client cert verified manually like LocalSend CustomClientCertVerifier
      },
      (req, res) => {
        const tlsSock = req.socket as tls.TLSSocket;
        const peerCert = tlsSock.getPeerCertificate();
        if (!peerCert || !peerCert.raw) {
          // Reject clients without mTLS certificate just like LocalSend rustls mandatory client auth!
          res.destroy();
          return;
        }
        const x509 = new crypto.X509Certificate(peerCert.raw);
        if (!x509.verify(x509.publicKey)) {
          res.destroy();
          return;
        }
        const clientCertFp = crypto
          .createHash('sha256')
          .update(peerCert.raw)
          .digest('hex')
          .toUpperCase();

        const url = new URL(req.url ?? '/', 'https://127.0.0.1');
        if (url.pathname === '/api/localsend/v2/info' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              alias: 'iPhone 15 Pro Ecom',
              version: '2.1',
              deviceModel: 'iPhone',
              deviceType: 'mobile',
              fingerprint: iphoneTls.fingerprint,
              port: mockIphonePort,
              protocol: 'https',
              download: false
            })
          );
          return;
        }

        if (url.pathname === '/api/localsend/v2/prepare-upload' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          req.on('data', (c: Buffer) => chunks.push(c));
          req.on('end', () => {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
              info: { fingerprint: string };
              files: Record<string, { id: string; fileName: string; fileType: string }>;
            };
            expect(parsed.info.fingerprint).toBe(clientCertFp);
            const tokens: Record<string, string> = {};
            for (const [id, meta] of Object.entries(parsed.files)) {
              tokens[id] = `tok-${id}`;
              pendingMeta.set(id, { fileName: meta.fileName, fileType: meta.fileType });
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ sessionId: 'sess-localsend-1', files: tokens }));
          });
          return;
        }

        if (url.pathname === '/api/localsend/v2/upload' && req.method === 'POST') {
          const fileId = url.searchParams.get('fileId') ?? '';
          const chunks: Buffer[] = [];
          req.on('data', (c: Buffer) => chunks.push(c));
          req.on('end', () => {
            const meta = pendingMeta.get(fileId) ?? { fileName: '', fileType: '' };
            receivedUploads.push({
              fileId,
              fileName: meta.fileName,
              fileType: meta.fileType,
              clientCertFingerprint: clientCertFp,
              body: Buffer.concat(chunks)
            });
            res.writeHead(200);
            res.end();
          });
          return;
        }

        res.writeHead(404);
        res.end();
      }
    );

    await new Promise<void>((resolve) => {
      mockIphoneServer!.listen(0, '127.0.0.1', () => {
        const addr = mockIphoneServer!.address();
        mockIphonePort = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  afterEach(async () => {
    bridge.stopDiscovery();
    if (mockIphoneServer) {
      await new Promise<void>((resolve) => mockIphoneServer!.close(() => resolve()));
      mockIphoneServer = null;
    }
    await server.stop();
    await watcher.stopWatching();
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  it('Cách 2: discovers iPhone LocalSend, remuxes MKV -> MP4 before pushing, and auto-pushes newly arriving MP4 straight to saved_to_photos', async () => {
    // 1. Create an MKV screen recording in the watched folder
    const mkvPath = path.join(tempDir, 'obs-demo.mkv');
    const originalMkvBuf = await createGenuineMkvFile(mkvPath);
    const originalMkvHash = crypto.createHash('sha256').update(originalMkvBuf).digest('hex');

    await waitFor(() => watcher.getSnapshot().videos.some((v) => v.fileName === 'obs-demo.mkv' && v.status === 'ready'));
    const mkvItem = watcher.getSnapshot().videos.find((v) => v.fileName === 'obs-demo.mkv')!;

    // 2. Connect to iPhone LocalSend peer over HTTPS mTLS
    const peer = await bridge.connectManualIp('127.0.0.1', mockIphonePort);
    expect(peer).not.toBeNull();
    expect(peer!.alias).toBe('iPhone 15 Pro Ecom');
    expect(peer!.protocol).toBe('https');
    expect(bridge.getState().selectedPeer?.fingerprint).toHaveLength(64);

    // 3. Push MKV video -> verify receiver got MP4 container & status became saved_to_photos!
    const ok = await bridge.pushSingleVideoNow(mkvItem.id);
    expect(ok).toBe(true);
    expect(receivedUploads).toHaveLength(1);
    expect(receivedUploads[0].fileName).toBe('obs-demo.mp4');
    expect(receivedUploads[0].fileType).toBe('video/mp4');
    expect(receivedUploads[0].body.subarray(4, 8).toString('ascii')).toBe('ftyp');

    const updatedMkvItem = watcher.getSnapshot().videos.find((v) => v.id === mkvItem.id)!;
    expect(updatedMkvItem.status).toBe('saved_to_photos');
    expect(updatedMkvItem.downloadCount).toBe(1);

    // Original MKV file remains 100% untouched
    const afterMkvHash = crypto
      .createHash('sha256')
      .update(await fs.promises.readFile(mkvPath))
      .digest('hex');
    expect(afterMkvHash).toBe(originalMkvHash);

    // 4. Enable Auto-Push (0-tap mode) and drop a brand-new OpenArt MP4 into watched folder
    bridge.setAutoPush(true);
    const autoMp4Bytes = createValidMp4Buffer(128 * 1024);
    const autoMp4Path = path.join(tempDir, 'openart-auto-01.mp4');
    await fs.promises.writeFile(autoMp4Path, autoMp4Bytes);

    await waitFor(() => receivedUploads.length === 2);
    await waitFor(
      () =>
        watcher
          .getSnapshot()
          .videos.find((v) => v.fileName === 'openart-auto-01.mp4')?.status === 'saved_to_photos'
    );

    expect(receivedUploads[1].fileName).toBe('openart-auto-01.mp4');
    expect(receivedUploads[1].body.equals(autoMp4Bytes)).toBe(true);
  });

  it('Cách 3: serves Apple Shortcuts 1-tap URLs, standalone /quick-pull WebClip page, and marks video saved_to_photos on &via=shortcut download', async () => {
    const mp4Bytes = createValidMp4Buffer(96 * 1024);
    const mp4Path = path.join(tempDir, 'flow-tiktok-clip.mp4');
    await fs.promises.writeFile(mp4Path, mp4Bytes);

    await waitFor(() => watcher.getSnapshot().videos[0]?.status === 'ready');

    // Pair iPhone Safari
    const pairRes = await fetch(`${baseUrl}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: baseUrl },
      body: JSON.stringify({ qrKey: auth.getQrKey(), pinCode: auth.getPinCode() })
    });
    expect(pairRes.status).toBe(200);
    const sessionCookie = pairRes.headers.get('set-cookie')!.split(';')[0];

    const listRes = await fetch(`${baseUrl}/api/videos`, {
      headers: { Cookie: sessionCookie }
    });
    const listData = (await listRes.json()) as {
      pendingPhotosCount: number;
      batchShortcutSaveUrl: string | null;
      quickPullHomeUrl: string;
      icloudShortcutUrl: string | null;
      videos: MobileVideoItem[];
    };

    expect(listData.pendingPhotosCount).toBe(1);
    expect(listData.icloudShortcutUrl).toContain('icloud.com/shortcuts/');
    expect(listData.batchShortcutSaveUrl).toContain('shortcuts://run-shortcut?name=Ecom%20Video%20Drop');
    expect(listData.videos[0].shortcutSaveUrl).toContain('shortcuts://run-shortcut?name=Ecom%20Video%20Drop');

    // Verify Home Screen WebClip page (/quick-pull?st=...) works even without session cookie
    const quickPullRes = await fetch(listData.quickPullHomeUrl);
    expect(quickPullRes.status).toBe(200);
    const quickPullHtml = await quickPullRes.text();
    expect(quickPullHtml).toContain('Có 1 video mới');
    expect(quickPullHtml).toContain('apple-touch-icon');
    expect(quickPullHtml).toContain('shortcuts://run-shortcut');

    // Extract inner download URL passed to Apple Shortcut's `text` input and simulate Shortcut fetching it
    const shortcutSchemeUrl = new URL(listData.videos[0].shortcutSaveUrl);
    const innerVideoUrl = shortcutSchemeUrl.searchParams.get('text')!;
    expect(innerVideoUrl).toContain('via=shortcut');

    const shortcutFetchRes = await fetch(innerVideoUrl);
    expect(shortcutFetchRes.status).toBe(200);
    const downloadedBuf = Buffer.from(await shortcutFetchRes.arrayBuffer());
    expect(downloadedBuf.equals(mp4Bytes)).toBe(true);

    // Immediately marked saved_to_photos (no manual confirmation needed!)
    await waitFor(() => watcher.getSnapshot().videos[0]?.status === 'saved_to_photos');

    const afterListRes = await fetch(`${baseUrl}/api/videos`, {
      headers: { Cookie: sessionCookie }
    });
    const afterListData = (await afterListRes.json()) as {
      pendingPhotosCount: number;
      batchShortcutSaveUrl: string | null;
    };
    expect(afterListData.pendingPhotosCount).toBe(0);
    expect(afterListData.batchShortcutSaveUrl).toBeNull();
  });
});
