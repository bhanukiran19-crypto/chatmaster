import { describe, expect, it, vi } from 'vitest';
import type { Redis as IORedis } from 'ioredis';
import {
  RedisCooldownService,
  cooldownKey,
  ioredisCooldownStore,
} from '../src/cooldown/cooldown-service.js';

function fakeStore(acquired: boolean) {
  const setIfAbsent = vi.fn<(key: string, ttl: number) => Promise<boolean>>(() =>
    Promise.resolve(acquired),
  );
  const remove = vi.fn<(key: string) => Promise<void>>(() => Promise.resolve());
  return { setIfAbsent, remove, store: { setIfAbsent, delete: remove } };
}

describe('RedisCooldownService', () => {
  it('claims the window atomically with the workflow cooldown as TTL', async () => {
    const { store, setIfAbsent } = fakeStore(true);
    await expect(new RedisCooldownService(store).tryAcquire('wf-1', '42', 30)).resolves.toBe(true);
    expect(setIfAbsent).toHaveBeenCalledWith(cooldownKey('wf-1', '42'), 30);
  });

  it('reports an active window when the key already exists', async () => {
    const { store } = fakeStore(false);
    await expect(new RedisCooldownService(store).tryAcquire('wf-1', '42', 30)).resolves.toBe(false);
  });

  it.each([0, -5, 1.5, Number.NaN])(
    'treats cooldown %s as disabled without touching Redis',
    async (seconds) => {
      const { store, setIfAbsent } = fakeStore(false);
      await expect(new RedisCooldownService(store).tryAcquire('wf-1', '42', seconds)).resolves.toBe(
        true,
      );
      expect(setIfAbsent).not.toHaveBeenCalled();
    },
  );

  it('releases by deleting the key', async () => {
    const { store, remove } = fakeStore(true);
    await new RedisCooldownService(store).release('wf-1', '42');
    expect(remove).toHaveBeenCalledWith(cooldownKey('wf-1', '42'));
  });

  it('keys are distinct per workflow and per chat', () => {
    expect(cooldownKey('wf-1', '1')).not.toBe(cooldownKey('wf-1', '2'));
    expect(cooldownKey('wf-1', '1')).not.toBe(cooldownKey('wf-2', '1'));
  });

  it('ioredis adapter issues SET key 1 EX ttl NX', async () => {
    const set = vi.fn<(...args: unknown[]) => Promise<'OK' | null>>(() => Promise.resolve('OK'));
    const del = vi.fn<(key: string) => Promise<number>>(() => Promise.resolve(1));
    const store = ioredisCooldownStore({ set, del } as unknown as IORedis);

    await expect(store.setIfAbsent('k', 9)).resolves.toBe(true);
    expect(set).toHaveBeenCalledWith('k', '1', 'EX', 9, 'NX');

    set.mockResolvedValueOnce(null);
    await expect(store.setIfAbsent('k', 9)).resolves.toBe(false);

    await store.delete('k');
    expect(del).toHaveBeenCalledWith('k');
  });
});
