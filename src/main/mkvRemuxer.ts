import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  ALL_FORMATS,
  Conversion,
  FilePathSource,
  FilePathTarget,
  Input,
  Mp4OutputFormat,
  Output
} from 'mediabunny';

export interface RemuxedMp4Result {
  mp4FilePath: string;
  sizeBytes: number;
}

/**
 * Losslessly remuxes MKV / WebM containers (such as OBS Studio H.264/HEVC recordings)
 * into a temporary iOS-compatible MP4 container inside OS temp directory so iPhone Safari
 * can preview inline and Apple Photos ("Save Video") accepts the file for TikTok.
 *
 * Strictly read-only on the original source file: never modifies, renames, or deletes it.
 */
export class MkvRemuxer {
  private readonly cacheDir: string;
  private inFlight = new Map<string, Promise<RemuxedMp4Result | null>>();

  constructor(cacheDir?: string) {
    this.cacheDir =
      cacheDir ??
      path.join(
        os.tmpdir(),
        'ecom-video-drop-mp4-cache',
        `${process.pid}-${crypto.randomBytes(6).toString('hex')}`
      );
  }

  private getCacheKey(sourcePath: string, sizeBytes: number, modifiedAtMs: number): string {
    return crypto
      .createHash('sha256')
      .update(`${sourcePath}:${sizeBytes}:${modifiedAtMs}`)
      .digest('hex')
      .slice(0, 24);
  }

  public async ensureIosMp4(
    sourcePath: string,
    sizeBytes: number,
    modifiedAtMs: number
  ): Promise<RemuxedMp4Result | null> {
    const key = this.getCacheKey(sourcePath, sizeBytes, modifiedAtMs);
    const targetPath = path.join(this.cacheDir, `${key}.mp4`);

    try {
      const existingStat = await fs.promises.stat(targetPath);
      if (existingStat.isFile() && existingStat.size > 32) {
        return {
          mp4FilePath: targetPath,
          sizeBytes: existingStat.size
        };
      }
    } catch {
      // Cache miss -> remux below
    }

    const active = this.inFlight.get(key);
    if (active) {
      return active;
    }

    const job = this.performLosslessRemux(sourcePath, targetPath).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, job);
    return job;
  }

  private async performLosslessRemux(
    sourcePath: string,
    targetPath: string
  ): Promise<RemuxedMp4Result | null> {
    await fs.promises.mkdir(this.cacheDir, { recursive: true });
    const tmpOutPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;

    let input: Input | null = null;
    try {
      input = new Input({
        source: new FilePathSource(sourcePath),
        formats: ALL_FORMATS
      });

      const output = new Output({
        format: new Mp4OutputFormat({
          fastStart: false
        }),
        target: new FilePathTarget(tmpOutPath)
      });

      const conversion = await Conversion.init({
        input,
        output,
        copy: {
          mode: 'forced',
          shiftTolerance: Infinity
        },
        showWarnings: false
      });

      const hasVideoTrack = conversion.utilizedTracks.some((t) => t.type === 'video');
      if (!conversion.isValid || !hasVideoTrack) {
        await conversion.cancel().catch(() => undefined);
        await fs.promises.rm(tmpOutPath, { force: true }).catch(() => undefined);
        return null;
      }

      await conversion.execute();
      await fs.promises.rename(tmpOutPath, targetPath);

      const stat = await fs.promises.stat(targetPath);
      return {
        mp4FilePath: targetPath,
        sizeBytes: stat.size
      };
    } catch {
      await fs.promises.rm(tmpOutPath, { force: true }).catch(() => undefined);
      return null;
    } finally {
      if (input) {
        input[Symbol.dispose]?.();
      }
    }
  }

  public async cleanup(): Promise<void> {
    this.inFlight.clear();
    await fs.promises.rm(this.cacheDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
