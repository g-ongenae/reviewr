import type { CreateRevisionInput, Document, RenameDocumentInput, Revision, SaveDraftInput } from '@reviewr/shared';
import type { QueryClient } from '@tanstack/react-query';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys, reachability } from '../api';
import { createQueryClient } from '../queryClient';
import { beforeRestoreName } from '../restore';
import { DocumentView } from './DocumentView';

/** "Restore into editor" from the history, through the editor and a fake API: the text it replaces is kept first. */

const fetchMock = vi.mocked(fetch);

interface Call {
  method: string;
  path: string;
  body: unknown;
}

const reply = (status: number, body?: unknown) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: () => (body === undefined ? Promise.reject(new Error('No body')) : Promise.resolve(structuredClone(body))),
  }) as unknown as Response;

const conflict = (body: object) => reply(409, { statusCode: 409, message: 'Conflict', ...body });

let document: Document | undefined;
let revisions: Revision[];
let calls: Call[];
/** Answers a request instead of the fake API, when it returns a response. */
let intercept: (call: Call) => Response | undefined;
/** Requests matching `hold` wait until `releaseHeld`, then get the API's answer at that time. */
let hold: (call: Call) => boolean;
/** Requests matching `delay` are answered by the API at once, but the answer arrives only at `releaseHeld`. */
let delay: (call: Call) => boolean;
let held: (() => void)[];

const server = (): Document => {
  if (document === undefined) throw new Error('The document was deleted');
  return document;
};

/** The API's rules for the requests the editor and its history send. */
const fakeApi = ({ method, path, body }: Call): Response => {
  const [, , , sub, number] = path.split('/');
  if (document?.draft === undefined) return reply(404, { statusCode: 404, message: 'Not found' });
  const { draft } = document;
  if (method === 'GET' && sub === undefined) return reply(200, document);
  if (method === 'GET' && sub === 'revisions') {
    if (number === undefined)
      return reply(
        200,
        revisions
          .map(({ documentId, revision, title, name, createdAt }) => ({ documentId, revision, title, name, createdAt }))
          .reverse(),
      );
    return reply(
      200,
      revisions.find((revision) => revision.revision === Number(number)),
    );
  }
  if (method === 'PUT' && sub === 'draft') {
    const input = body as SaveDraftInput;
    if (draft.content === input.content) return reply(200, draft);
    if (draft.draftVersion !== input.draftVersion) return conflict({ code: 'draft_conflict', draft });
    document = { ...document, draft: { ...draft, content: input.content, draftVersion: draft.draftVersion + 1 } };
    return reply(200, document.draft);
  }
  if (method === 'POST' && sub === 'revisions') {
    const input = body as CreateRevisionInput;
    if (draft.draftVersion !== input.draftVersion) return conflict({ code: 'draft_conflict', draft });
    if (draft.content === document.content) return reply(200, document);
    if (document.revision !== (input.baseRevision ?? 0)) {
      return conflict({ code: 'stale_revision', revision: document.revision });
    }
    const revision = document.revision + 1;
    document = { ...document, revision, content: draft.content, draft: { ...draft, baseRevision: revision } };
    revisions.push({
      documentId: document.id,
      revision,
      title: document.title,
      name: input.name ?? null,
      content: draft.content,
      createdAt: '2026-11-18T10:00:00.000Z',
    });
    return reply(200, document);
  }
  if (method === 'PATCH' && sub === undefined) {
    const { title } = body as RenameDocumentInput;
    document = { ...document, title: title?.trim() ? title : null };
    return reply(200, document);
  }
  return reply(404, { statusCode: 404, message: 'Not found' });
};

let queryClient: QueryClient;

const open = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <DocumentView id="doc-1" onDeleted={() => {}} onGoBack={() => {}} onOpen={() => {}} />
    </QueryClientProvider>,
  );

/** The cached document, which the editor shows. */
const cached = () => queryClient.getQueryData<Document>(queryKeys.document('doc-1'));

const elapse = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));
const releaseHeld = async () => {
  hold = () => false;
  delay = () => false;
  for (const answer of held.splice(0)) answer();
  await elapse();
};

const textarea = () => screen.getByPlaceholderText<HTMLTextAreaElement>('Start writing…');
const titleField = () => screen.getByPlaceholderText<HTMLInputElement>(/^Untitled/);
const type = (value: string) => fireEvent.change(textarea(), { target: { value } });
const versionsMade = () => calls.filter((call) => call.method === 'POST' && call.path.endsWith('/revisions'));

/** Opens the history on revision 1 ("An old title", "An old text."); the restore button is then on screen. */
const openRevision1 = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'History' }));
  await elapse();
  fireEvent.click(screen.getByRole('button', { name: /Revision 1/ }));
  await elapse();
};
const restoreButton = () => screen.getByRole('button', { name: /^(Restore into editor|Restoring…)$/ });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  window.localStorage.clear();
  revisions = [
    {
      documentId: 'doc-1',
      revision: 1,
      title: 'An old title',
      name: null,
      content: 'An old text.',
      createdAt: '2026-11-01T10:00:00.000Z',
    },
    {
      documentId: 'doc-1',
      revision: 2,
      title: 'The lighthouse keeper',
      name: null,
      content: 'Once upon a tide.',
      createdAt: '2026-11-02T10:00:00.000Z',
    },
  ];
  document = {
    id: 'doc-1',
    title: 'The lighthouse keeper',
    revision: 2,
    content: 'Once upon a tide.',
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-02T10:00:00.000Z',
    draft: { content: 'Once upon a tide.', draftVersion: 3, baseRevision: 2 },
  };
  calls = [];
  intercept = () => undefined;
  hold = () => false;
  delay = () => false;
  held = [];
  queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { refetchOnWindowFocus: false, retry: false, staleTime: Infinity } });
  queryClient.setQueryData(queryKeys.document('doc-1'), document);

  fetchMock.mockImplementation((input, init) => {
    const call = {
      method: init?.method ?? 'GET',
      path: new URL(input instanceof Request ? input.url : input.toString(), 'http://localhost').pathname.replace(
        /^\/api/,
        '',
      ),
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    };
    calls.push(call);
    const answer = () => intercept(call) ?? fakeApi(call);
    if (hold(call)) return new Promise<Response>((resolve) => held.push(() => resolve(answer())));
    if (delay(call)) {
      const response = answer();
      return new Promise<Response>((resolve) => held.push(() => resolve(response)));
    }
    return Promise.resolve(answer());
  });
});

afterEach(async () => {
  cleanup();
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
  reachability.reportSuccess();
  fetchMock.mockReset();
});

describe('Restore into editor', () => {
  it('keeps a draft in no version as "Before restore", then restores the old title and text', async () => {
    open();
    type('A draft never saved as a version.');
    await openRevision1();
    hold = (call) => call.method === 'POST';
    fireEvent.click(restoreButton());
    await elapse();
    // The version is being saved: nothing is replaced yet, and the button says so.
    expect(restoreButton().textContent).toBe('Restoring…');
    expect(restoreButton()).toHaveProperty('disabled', true);
    expect(textarea().value).toBe('A draft never saved as a version.');

    await releaseHeld();
    expect(revisions.at(-1)).toMatchObject({
      revision: 3,
      name: beforeRestoreName(new Date()),
      content: 'A draft never saved as a version.',
    });
    expect(textarea().value).toBe('An old text.');
    expect(titleField().value).toBe('An old title');
    expect(screen.queryByRole('alert')).toBeNull();
    // The history lists the version kept.
    await elapse();
    expect(screen.getByText(beforeRestoreName(new Date()))).toBeTruthy();

    await elapse(1000);
    expect(server().draft?.content).toBe('An old text.');
    expect(server().title).toBe('An old title');
    expect(server().revision).toBe(3);
  });

  it('restores at once, with no version, when the text on screen is the head’s', async () => {
    open();
    await openRevision1();
    fireEvent.click(restoreButton());
    expect(textarea().value).toBe('An old text.');
    await elapse(1000);
    expect(versionsMade()).toEqual([]);
    expect(server().draft?.content).toBe('An old text.');
  });

  it('restores nothing while the server is unreachable, and says why', async () => {
    open();
    type('A draft never saved as a version.');
    intercept = (call) => (call.method === 'GET' ? undefined : reply(503));
    await openRevision1();
    fireEvent.click(restoreButton());
    await elapse();
    expect(screen.getByRole('alert').textContent).toBe(
      'Not restored: your current text could not be kept as a version first (the server is unreachable). It is still in the editor.',
    );
    expect(textarea().value).toBe('A draft never saved as a version.');
    expect(titleField().value).toBe('The lighthouse keeper');
    expect(versionsMade()).toEqual([]);

    // Back online: the draft is saved as usual, and a second restore goes through.
    intercept = () => undefined;
    await elapse(1000);
    expect(server().draft?.content).toBe('A draft never saved as a version.');
    fireEvent.click(restoreButton());
    await elapse();
    expect(textarea().value).toBe('An old text.');
    expect(revisions.at(-1)?.content).toBe('A draft never saved as a version.');
  });

  it('restores nothing when the version is refused, and the draft stays saved', async () => {
    open();
    type('A draft never saved as a version.');
    intercept = (call) => (call.method === 'POST' ? reply(500, { statusCode: 500, message: 'Boom' }) : undefined);
    await openRevision1();
    fireEvent.click(restoreButton());
    await elapse();
    expect(screen.getByRole('alert').textContent).toContain('could not be kept as a version first (Boom)');
    expect(textarea().value).toBe('A draft never saved as a version.');
    expect(server().draft?.content).toBe('A draft never saved as a version.');
  });

  it('never replaces a text typed during the restore', async () => {
    open();
    type('A draft never saved as a version.');
    await openRevision1();
    hold = (call) => call.method === 'POST';
    fireEvent.click(restoreButton());
    await elapse();
    type('A draft never saved as a version. And a new line.');
    await releaseHeld();

    expect(textarea().value).toBe('A draft never saved as a version. And a new line.');
    expect(titleField().value).toBe('The lighthouse keeper');
    expect(screen.getByRole('alert').textContent).toBe(
      'Not restored: your text or title changed during the restore. It is kept as it is: restore again to replace it.',
    );
    await elapse(1000);
    expect(server().draft?.content).toBe('A draft never saved as a version. And a new line.');
    // The text the restore was asked over is kept too.
    expect(revisions.at(-1)?.content).toBe('A draft never saved as a version.');
  });

  it('is refused while the text is in conflict with another device', async () => {
    open();
    document = { ...server(), draft: { content: 'Theirs.', draftVersion: 4, baseRevision: 2 } };
    type('Mine.');
    await elapse(1000);
    expect(screen.getByText('This text was also changed on another device.')).toBeTruthy();
    await openRevision1();
    fireEvent.click(restoreButton());
    await elapse();
    expect(screen.getByText(/^Not restored: this text was also changed on another device/)).toBeTruthy();
    expect(textarea().value).toBe('Mine.');
    expect(versionsMade()).toEqual([]);
  });

  it('is refused for a document deleted elsewhere, whose text stays on screen', async () => {
    open();
    document = undefined;
    type('A last text.');
    await elapse(1000);
    revisions.splice(0);
    // The history was read before the deletion.
    queryClient.setQueryData(queryKeys.revisions('doc-1'), [
      { documentId: 'doc-1', revision: 1, title: 'An old title', name: null, createdAt: '2026-11-01T10:00:00.000Z' },
    ]);
    queryClient.setQueryData(queryKeys.revision('doc-1', 1), {
      documentId: 'doc-1',
      revision: 1,
      title: 'An old title',
      name: null,
      content: 'An old text.',
      createdAt: '2026-11-01T10:00:00.000Z',
    });
    await openRevision1();
    fireEvent.click(restoreButton());
    await elapse();
    expect(
      screen.getByText('Not restored: this document was deleted elsewhere. Your text is kept as it is.'),
    ).toBeTruthy();
    expect(textarea().value).toBe('A last text.');
    expect(versionsMade()).toEqual([]);
  });

  it('never replaces a title typed during the restore, which is then saved', async () => {
    open();
    type('A draft never saved as a version.');
    await openRevision1();
    hold = (call) => call.method === 'POST';
    fireEvent.click(restoreButton());
    await elapse();
    fireEvent.change(titleField(), { target: { value: 'A new title' } });
    await releaseHeld();

    expect(titleField().value).toBe('A new title');
    expect(textarea().value).toBe('A draft never saved as a version.');
    expect(screen.getByRole('alert').textContent).toContain('your text or title changed during the restore');
    // The text was kept all the same, and the new title is saved.
    expect(revisions.at(-1)?.content).toBe('A draft never saved as a version.');
    await elapse(1000);
    expect(server().title).toBe('A new title');
    expect(server().draft?.content).toBe('A draft never saved as a version.');
  });

  it('keeps an empty draft first when the editor’s head is a stale revision 0', async () => {
    // The editor opened a draft-only document; another device then saved its text as revision 1.
    const draftOnly: Document = {
      ...server(),
      revision: 0,
      content: '',
      draft: { content: 'Once upon a tide.', draftVersion: 3, baseRevision: null },
    };
    queryClient.setQueryData(queryKeys.document('doc-1'), draftOnly);
    revisions.splice(1);
    revisions[0] = { ...revisions[0]!, content: 'Once upon a tide.' };
    document = { ...server(), revision: 1, content: 'Once upon a tide.' };
    open();
    type('');
    await elapse(1000);
    expect(server().draft?.content).toBe('');
    await openRevision1();
    fireEvent.click(restoreButton());
    await elapse();

    expect(revisions.at(-1)).toMatchObject({ revision: 2, content: '', name: beforeRestoreName(new Date()) });
    expect(textarea().value).toBe('Once upon a tide.');
  });

  it('runs one restore at a time, even when the history is hidden and shown again', async () => {
    open();
    type('A draft never saved as a version.');
    await openRevision1();
    hold = (call) => call.method === 'POST';
    fireEvent.click(restoreButton());
    await elapse();
    fireEvent.click(screen.getByRole('button', { name: 'Hide history' }));
    await openRevision1();
    expect(restoreButton().textContent).toBe('Restoring…');
    expect(restoreButton()).toHaveProperty('disabled', true);
    fireEvent.click(restoreButton());
    await releaseHeld();

    expect(versionsMade()).toHaveLength(1);
    expect(textarea().value).toBe('An old text.');
  });

  it('restores nothing into a document left and opened again during the restore, and still keeps the version', async () => {
    const view = open();
    type('A draft never saved as a version.');
    await openRevision1();
    hold = (call) => call.method === 'POST';
    fireEvent.click(restoreButton());
    await elapse();
    // The writer leaves the document and opens it again at once: the new editor shows the same autosave.
    view.rerender(<QueryClientProvider client={queryClient}>{null}</QueryClientProvider>);
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <DocumentView id="doc-1" onDeleted={() => {}} onGoBack={() => {}} onOpen={() => {}} />
      </QueryClientProvider>,
    );
    await releaseHeld();
    await elapse(5000);

    // The old editor's restore applies nothing, to the new editor or in the background, and says nothing.
    expect(textarea().value).toBe('A draft never saved as a version.');
    expect(titleField().value).toBe('The lighthouse keeper');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(server().draft?.content).toBe('A draft never saved as a version.');
    expect(server().title).toBe('The lighthouse keeper');
    // The version it kept is published all the same.
    expect(revisions.at(-1)?.content).toBe('A draft never saved as a version.');
    expect(cached()?.revision).toBe(3);
  });

  it('is not undone by a read of the document sent before the version was kept', async () => {
    open();
    type('A draft never saved as a version.');
    await elapse(1000);
    await openRevision1();
    // A read of revision 2 is answered now, but arrives only after the version is kept.
    let first = true;
    delay = (call) => {
      const match = first && call.method === 'GET' && call.path === '/documents/doc-1';
      if (match) first = false;
      return match;
    };
    act(() => void queryClient.invalidateQueries({ queryKey: queryKeys.document('doc-1'), exact: true }));
    await elapse();
    expect(held).toHaveLength(1);
    fireEvent.click(restoreButton());
    await elapse();
    expect(textarea().value).toBe('An old text.');
    await releaseHeld();

    expect(cached()?.revision).toBe(3);
    expect(cached()?.content).toBe('A draft never saved as a version.');
    expect(screen.getAllByRole('status')[0]?.textContent).toBe('Unsaved changes');
    await elapse(1000);
    expect(screen.getAllByRole('status')[0]?.textContent).toBe('Draft saved · changed since revision 3');
  });

  it('shows why a restore failed under the revision it was asked for only', async () => {
    open();
    type('A draft never saved as a version.');
    await openRevision1();
    hold = (call) => call.method === 'POST';
    intercept = (call) => (call.method === 'POST' ? reply(500, { statusCode: 500, message: 'Boom' }) : undefined);
    fireEvent.click(restoreButton());
    await elapse();
    // Another revision is selected while the restore waits.
    fireEvent.click(screen.getByRole('button', { name: /Revision 2/ }));
    await elapse();
    await releaseHeld();
    expect(screen.queryByRole('alert')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Revision 1/ }));
    await elapse();
    expect(screen.getByRole('alert').textContent).toContain('could not be kept as a version first (Boom)');
    expect(textarea().value).toBe('A draft never saved as a version.');
  });
});
