import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { UpdateAsset } from '@intentra/contracts';
import { HttpError } from '../errors.js';

export interface ArtifactSource {
  open(url: string, signal: AbortSignal): Promise<Readable>;
}

export interface ReleaseArtifacts {
  ensureCached(asset: UpdateAsset): Promise<string>;
}

export interface ReleaseArtifactsInput {
  readonly cacheDir: string;
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly source: ArtifactSource;
}

const isMissingFile = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';

const upstreamFailure = (error: unknown): HttpError => {
  if (error instanceof HttpError) return error;
  if (error instanceof Error && error.name === 'AbortError') {
    return new HttpError('UPSTREAM_FAILED', 'artifact download timed out');
  }
  return new HttpError('UPSTREAM_FAILED', 'artifact download failed');
};

export function createGitHubArtifactSource(token: string | null): ArtifactSource {
  return {
    async open(url, signal) {
      const headers: Record<string, string> = {};
      if (token !== null && new URL(url).hostname === 'github.com') headers.authorization = `Bearer ${token}`;
      const response = await fetch(url, { signal, headers });
      if (!response.ok || response.body === null) {
        throw new Error(`artifact source responded with ${response.status}`);
      }
      return Readable.fromWeb(response.body);
    },
  };
}

export function createReleaseArtifacts(input: ReleaseArtifactsInput): ReleaseArtifacts {
  const inFlight = new Map<string, Promise<string>>();
  const pathFor = (sha256: string): string => join(input.cacheDir, sha256);

  const hashFile = async (path: string): Promise<string | null> => {
    const hash = createHash('sha256');
    try {
      for await (const chunk of createReadStream(path)) hash.update(chunk);
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
    return hash.digest('hex');
  };

  const cachedPath = async (asset: UpdateAsset): Promise<string | null> => {
    const path = pathFor(asset.sha256);
    const digest = await hashFile(path);
    if (digest === null) return null;
    if (digest === asset.sha256) return path;
    await rm(path, { force: true });
    return null;
  };

  const download = async (asset: UpdateAsset): Promise<string> => {
    await mkdir(input.cacheDir, { recursive: true });
    const tmp = join(input.cacheDir, `.tmp-${randomUUID()}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs);
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      const source = await input.source.open(asset.url, controller.signal);
      await pipeline(
        source,
        async function* (stream) {
          for await (const chunk of stream) {
            const buffer = Buffer.from(chunk);
            bytes += buffer.length;
            if (bytes > input.maxBytes) {
              throw new HttpError('UPSTREAM_FAILED', 'artifact exceeds the size limit');
            }
            hash.update(buffer);
            yield buffer;
          }
        },
        createWriteStream(tmp),
        { signal: controller.signal },
      );
      if (hash.digest('hex') !== asset.sha256) {
        throw new HttpError('UPSTREAM_FAILED', 'artifact sha256 does not match the manifest');
      }
      const target = pathFor(asset.sha256);
      await rename(tmp, target);
      return target;
    } catch (error) {
      await rm(tmp, { force: true });
      throw upstreamFailure(error);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    ensureCached(asset) {
      const pending = inFlight.get(asset.sha256);
      if (pending !== undefined) return pending;
      const started = (async () => (await cachedPath(asset)) ?? (await download(asset)))().finally(() => {
        inFlight.delete(asset.sha256);
      });
      inFlight.set(asset.sha256, started);
      return started;
    },
  };
}
