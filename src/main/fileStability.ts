import fs from 'node:fs';
import path from 'node:path';
import { SupportedVideoExtension, SupportedVideoMimeType } from '../shared/types';

const VALID_QT_BMFF_BOX_TYPES = new Set([
  'ftyp',
  'moov',
  'mdat',
  'wide',
  'free',
  'skip',
  'pnot',
  'styp'
]);

const BROWSER_TEMP_SUFFIXES = [
  '.crdownload',
  '.part',
  '.tmp',
  '.download',
  '.opdownload'
];

export function isBrowserTempFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return BROWSER_TEMP_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

export function getSupportedVideoExtension(fileName: string): SupportedVideoExtension | null {
  if (!fileName || fileName.startsWith('.') || fileName.startsWith('~$')) {
    return null;
  }
  if (isBrowserTempFile(fileName)) {
    return null;
  }
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.mp4') return 'mp4';
  if (ext === '.mov') return 'mov';
  if (ext === '.m4v') return 'm4v';
  if (ext === '.mkv') return 'mkv';
  if (ext === '.webm') return 'webm';
  return null;
}

export function getVideoMimeType(ext: SupportedVideoExtension): SupportedVideoMimeType {
  switch (ext) {
    case 'mp4':
    case 'm4v':
      return 'video/mp4';
    case 'mov':
      return 'video/quicktime';
    case 'mkv':
      return 'video/x-matroska';
    case 'webm':
      return 'video/webm';
  }
}

export function requiresIosMp4Remux(ext: SupportedVideoExtension): boolean {
  return ext === 'mkv' || ext === 'webm';
}

export async function hasCompanionTempFile(filePath: string): Promise<boolean> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const stem = path.basename(filePath, path.extname(filePath));

  const candidates = [
    path.join(dir, `${base}.crdownload`),
    path.join(dir, `${base}.part`),
    path.join(dir, `${base}.tmp`),
    path.join(dir, `${base}.download`),
    path.join(dir, `${stem}.crdownload`),
    path.join(dir, `${stem}.part`)
  ];

  for (const candidate of candidates) {
    try {
      await fs.promises.access(candidate, fs.constants.F_OK);
      return true;
    } catch {
      // Does not exist
    }
  }
  return false;
}

export type HeaderProbeResult =
  | { state: 'valid' }
  | { state: 'locked'; reason: string }
  | { state: 'invalid'; reason: string };

/**
 * Strictly read-only inspection of the first 32 bytes of a supported video file
 * (ISO BMFF / QuickTime for MP4/MOV/M4V, or EBML header for MKV/WebM).
 * Never loads the video into memory and never modifies file timestamps or contents.
 */
export async function probeVideoHeaderReadOnly(
  filePath: string,
  ext: SupportedVideoExtension
): Promise<HeaderProbeResult> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(filePath, fs.constants.O_RDONLY);
    const buffer = Buffer.alloc(32);
    const { bytesRead } = await handle.read(buffer, 0, 32, 0);

    if (bytesRead < 12) {
      return {
        state: 'invalid',
        reason: 'File quá nhỏ hoặc chưa có cấu trúc header video hợp lệ.'
      };
    }

    if (ext === 'mkv' || ext === 'webm') {
      // Matroska / WebM EBML Magic Bytes: 0x1A 0x45 0xDF 0xA3
      const isEbml =
        buffer[0] === 0x1a &&
        buffer[1] === 0x45 &&
        buffer[2] === 0xdf &&
        buffer[3] === 0xa3;

      if (!isEbml) {
        return {
          state: 'invalid',
          reason: 'Định dạng container không phải chuẩn MKV/WebM (EBML) hợp lệ.'
        };
      }
      return { state: 'valid' };
    }

    const boxSize = buffer.readUInt32BE(0);
    const boxType = buffer.subarray(4, 8).toString('ascii');

    const validBoxSize = boxSize === 0 || boxSize === 1 || boxSize >= 8;
    if (!validBoxSize || !VALID_QT_BMFF_BOX_TYPES.has(boxType)) {
      return {
        state: 'invalid',
        reason: 'Định dạng container không phải chuẩn MP4/MOV hợp lệ.'
      };
    }

    return { state: 'valid' };
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
      return {
        state: 'locked',
        reason: 'Trình duyệt hoặc tiến trình khác đang ghi file.'
      };
    }
    return {
      state: 'invalid',
      reason: 'Không thể đọc file video.'
    };
  } finally {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
  }
}

// Backward-compatible alias
export const probeMp4MovHeaderReadOnly = (filePath: string) =>
  probeVideoHeaderReadOnly(filePath, 'mp4');
