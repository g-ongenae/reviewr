import { randomUUID as newId } from 'node:crypto';
import { ApiError, NetworkError, revisionNameMaxLength } from '@reviewr/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDrafts } from './drafts';
import { FakeApi } from './fakeApi';
import { createVersionName, versionNameToSend } from './versionName';

const debounceMs = 1000;

/** An editor on a fake server, its text changed since revision 1 and saved as a draft, and its name field. */
const setup = async () => {
  const server = new FakeApi('base');
  const drafts = createDrafts({
    api: server,
    report: { reportSuccess: () => undefined, reportError: () => undefined },
    onDraft: () => undefined,
    onDocument: () => undefined,
    debounceMs,
    now: () => new Date('2026-11-20T10:00:00Z'),
    newId,
  });
  const entry = drafts.open(server.read());
  drafts.hold('doc');
  entry.autosave.edit('base and more');
  await vi.advanceTimersByTimeAsync(debounceMs);
  const field = createVersionName();
  const save = () => field.save((name) => drafts.saveVersion('doc', server.document.revision, name));
  return { server, entry, field, save };
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('versionNameToSend', () => {
  it('trims the name, and a blank one is no name', () => {
    expect(versionNameToSend('  The gull arrives ')).toBe('The gull arrives');
    expect(versionNameToSend('')).toBeUndefined();
    expect(versionNameToSend(' \n\t ')).toBeUndefined();
  });

  it('cuts a name past the server’s limit', () => {
    expect(versionNameToSend('a'.repeat(revisionNameMaxLength + 10))).toHaveLength(revisionNameMaxLength);
  });
});

describe('createVersionName', () => {
  it('saves without a name while the field is closed: one tap, as before', async () => {
    const { server, field, save } = await setup();
    expect(field.getSnapshot()).toEqual({ open: false, value: '', saving: false });
    await save();
    expect(server.revisions.at(-1)).toMatchObject({ revision: 2, content: 'base and more', name: undefined });
  });

  it('saves with the name typed, then closes and empties the field for the next version', async () => {
    const { server, entry, field, save } = await setup();
    field.toggle();
    field.edit('  The gull arrives ');
    const saving = save();
    expect(field.getSnapshot()).toMatchObject({ open: true, value: '  The gull arrives ', saving: true });
    await saving;
    expect(server.revisions.at(-1)).toMatchObject({ revision: 2, name: 'The gull arrives' });
    expect(field.getSnapshot()).toEqual({ open: false, value: '', saving: false });

    // The next version has no name, unless the writer gives one.
    entry.autosave.edit('base and more again');
    await vi.advanceTimersByTimeAsync(debounceMs);
    await save();
    expect(server.revisions.at(-1)).toMatchObject({ revision: 3, name: undefined });
  });

  it('saves a blank name as no name', async () => {
    const { server, field, save } = await setup();
    field.toggle();
    field.edit('   ');
    await save();
    expect(server.revisions.at(-1)).toMatchObject({ revision: 2, name: undefined });
    expect(field.getSnapshot().open).toBe(false);
  });

  it('keeps the name typed when the version is refused, to save again with one tap', async () => {
    const { server, field, save } = await setup();
    field.toggle();
    field.edit('The gull arrives');
    server.failing = new ApiError(500, { statusCode: 500, message: 'Internal Server Error' });
    await expect(save()).rejects.toBeInstanceOf(ApiError);
    expect(field.getSnapshot()).toEqual({ open: true, value: 'The gull arrives', saving: false });
    expect(server.revisions).toHaveLength(1);

    server.failing = undefined;
    await save();
    expect(server.revisions.at(-1)).toMatchObject({ revision: 2, name: 'The gull arrives' });
  });

  it('keeps the name typed when the server is unreachable and the draft cannot be saved', async () => {
    const { server, entry, field, save } = await setup();
    field.toggle();
    field.edit('The gull arrives');
    entry.autosave.edit('base and more, offline');
    server.failing = new NetworkError(new TypeError('Network request failed'));
    expect(await save()).toBeUndefined();
    expect(field.getSnapshot()).toEqual({ open: true, value: 'The gull arrives', saving: false });
  });

  it('keeps the field as it is while a version is saved', async () => {
    const { server, field, save } = await setup();
    field.toggle();
    field.edit('The gull arrives');
    server.paused = true;
    const saving = save();
    await vi.advanceTimersByTimeAsync(0);
    field.edit('Something else');
    field.toggle();
    expect(field.getSnapshot()).toEqual({ open: true, value: 'The gull arrives', saving: true });
    server.release();
    await saving;
    expect(server.revisions.at(-1)).toMatchObject({ name: 'The gull arrives' });
  });

  it('forgets the name when the writer closes the field', () => {
    const field = createVersionName();
    const listener = vi.fn();
    field.subscribe(listener);
    field.toggle();
    field.edit('The gull arrives');
    field.toggle();
    expect(field.getSnapshot()).toEqual({ open: false, value: '', saving: false });
    field.toggle();
    expect(field.getSnapshot()).toEqual({ open: true, value: '', saving: false });
    expect(listener).toHaveBeenCalledTimes(4);
  });
});
