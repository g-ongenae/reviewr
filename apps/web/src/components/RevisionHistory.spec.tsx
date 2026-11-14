import type { Document, Revision, RevisionSummary } from '@reviewr/shared';
import { revisionNameMaxLength } from '@reviewr/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reachability } from '../api';
import { createQueryClient } from '../queryClient';
import { RevisionHistory } from './RevisionHistory';

const fetchMock = vi.mocked(fetch);

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const openDocument: Document = {
  id: 'doc-1',
  title: 'Le gardien du phare',
  revision: 3,
  content: 'La marée monte.',
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-13T10:00:00.000Z',
};

const summary = (revision: number, name: string | null): RevisionSummary => ({
  documentId: 'doc-1',
  revision,
  title: 'Le gardien du phare',
  name,
  createdAt: `2026-11-1${revision}T10:00:00.000Z`,
});

const contents: Record<number, string> = { 1: 'Il était une fois.', 2: 'La mer.', 3: 'La marée monte.' };

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/**
 * A fake API holding three revisions; `onName` answers `PATCH /documents/:id/revisions/:n` (by default it
 * stores the trimmed name, or null when blank, as the API does).
 */
const serve = (onName?: (revision: number, name: string | null) => Response | Promise<Response>) => {
  const revisions = [summary(3, null), summary(2, 'Relu par Claire'), summary(1, null)];
  const calls: Call[] = [];
  fetchMock.mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    const path = new URL(url, 'http://localhost').pathname.replace(/^\/api/, '');
    const method = init?.method ?? 'GET';
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    if (path === '/documents/doc-1/revisions') return json(200, revisions);
    const match = /^\/documents\/doc-1\/revisions\/(\d+)$/.exec(path);
    const item = match ? revisions.find((r) => r.revision === Number(match[1])) : undefined;
    if (!item) return json(404, { statusCode: 404, message: 'Not found' });
    if (method === 'PATCH') {
      const raw = (body as { name: string | null }).name;
      if (onName) return onName(item.revision, raw);
      const name = raw === null || raw.trim() === '' ? null : raw.trim();
      Object.assign(item, { name });
      return json(200, item);
    }
    const full: Revision = { ...item, content: contents[item.revision] ?? '' };
    return json(200, full);
  });
  return calls;
};

const renderHistory = (onRestore: (revision: Revision) => void = () => {}) => {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { refetchOnWindowFocus: false, retry: false } });
  render(
    <QueryClientProvider client={queryClient}>
      <RevisionHistory document={openDocument} onRestore={onRestore} />
    </QueryClientProvider>,
  );
};

const nameField = (revision: number) => screen.findByRole('textbox', { name: `Name of revision ${revision}` });

afterEach(() => {
  reachability.reportSuccess();
  fetchMock.mockReset();
});

describe('RevisionHistory names', () => {
  it('shows a named version by its name, with its number, and an unnamed one by its number', async () => {
    serve();
    renderHistory();

    const named = await screen.findByRole('button', { name: /Relu par Claire/ });
    expect(named.textContent).toContain('Revision 2');
    expect(screen.getByRole('button', { name: /^Revision 1/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Revision 3\s*current/ })).toBeTruthy();
    // Each row has its own labelled pencil.
    expect(screen.getByRole('button', { name: 'Name revision 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Rename revision 2' })).toBeTruthy();
  });

  it('names an unnamed version with Enter and shows the name the server answered', async () => {
    const calls = serve();
    renderHistory();

    fireEvent.click(await screen.findByRole('button', { name: 'Name revision 1' }));
    const field = await nameField(1);
    expect(document.activeElement).toBe(field);
    expect(field.getAttribute('maxlength')).toBe(String(revisionNameMaxLength));
    fireEvent.change(field, { target: { value: '  Première version  ' } });
    fireEvent.submit(field);

    expect(await screen.findByRole('button', { name: /Première version/ })).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(calls.filter((c) => c.method === 'PATCH')).toEqual([
      { method: 'PATCH', path: '/documents/doc-1/revisions/1', body: { name: '  Première version  ' } },
    ]);
    // Focus goes back to the pencil of that row, now a rename.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Rename revision 1' })));
  });

  it('renames a named version with the Save button', async () => {
    serve();
    renderHistory();

    fireEvent.click(await screen.findByRole('button', { name: 'Rename revision 2' }));
    const field = await nameField(2);
    expect((field as HTMLInputElement).value).toBe('Relu par Claire');
    fireEvent.change(field, { target: { value: 'Relu par Claire et Hugo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('button', { name: /Relu par Claire et Hugo/ })).toBeTruthy();
  });

  it('clears a name when the field is saved empty', async () => {
    const calls = serve();
    renderHistory();

    fireEvent.click(await screen.findByRole('button', { name: 'Rename revision 2' }));
    const field = await nameField(2);
    fireEvent.change(field, { target: { value: '   ' } });
    fireEvent.submit(field);

    expect(await screen.findByRole('button', { name: 'Name revision 2' })).toBeTruthy();
    expect(screen.queryByText('Relu par Claire')).toBeNull();
    expect(screen.getByRole('button', { name: /^Revision 2/ })).toBeTruthy();
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ name: null });
  });

  it('cancels with Escape without sending anything', async () => {
    const calls = serve();
    renderHistory();

    fireEvent.click(await screen.findByRole('button', { name: 'Rename revision 2' }));
    const field = await nameField(2);
    fireEvent.change(field, { target: { value: 'Autre chose' } });
    fireEvent.keyDown(field, { key: 'Escape' });

    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('button', { name: /Relu par Claire/ })).toBeTruthy();
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Rename revision 2' })));
  });

  it('cancels with the Cancel button', async () => {
    serve();
    renderHistory();

    fireEvent.click(await screen.findByRole('button', { name: 'Name revision 1' }));
    fireEvent.change(await nameField(1), { target: { value: 'Brouillon' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByText('Brouillon')).toBeNull();
  });

  it('keeps the typed name and shows the error next to it when the request fails', async () => {
    serve(() => json(400, { statusCode: 400, message: 'name must be shorter than or equal to 200 characters' }));
    renderHistory();

    fireEvent.click(await screen.findByRole('button', { name: 'Name revision 1' }));
    const field = await nameField(1);
    fireEvent.change(field, { target: { value: 'Version du soir' } });
    fireEvent.submit(field);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('name must be shorter than or equal to 200 characters');
    expect((field as HTMLInputElement).value).toBe('Version du soir');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.getAttribute('aria-describedby')).toBe(alert.id);
  });

  it('keeps the typed name without an inline error when the server is unreachable', async () => {
    serve(() => new Response('<html>502 Bad Gateway</html>', { status: 502 }));
    renderHistory();

    fireEvent.click(await screen.findByRole('button', { name: 'Name revision 1' }));
    const field = await nameField(1);
    fireEvent.change(field, { target: { value: 'Version du soir' } });
    fireEvent.submit(field);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(false));
    expect(screen.queryByRole('alert')).toBeNull();
    expect((field as HTMLInputElement).value).toBe('Version du soir');
  });

  it('shows a long name in full in its tooltip', async () => {
    const long = 'Version relue après la discussion avec l’éditrice sur la fin du deuxième chapitre et le phare';
    serve();
    renderHistory();

    fireEvent.click(await screen.findByRole('button', { name: 'Name revision 1' }));
    const field = await nameField(1);
    fireEvent.change(field, { target: { value: long } });
    fireEvent.submit(field);

    const name = await screen.findByText(long);
    expect(name.getAttribute('title')).toBe(long);
  });

  it('still restores a version into the editor, and naming one leaves its text alone', async () => {
    const onRestore = vi.fn();
    serve();
    renderHistory(onRestore);

    fireEvent.click(await screen.findByRole('button', { name: /Relu par Claire/ }));
    expect(await screen.findByText('La mer.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Rename revision 2' }));
    fireEvent.change(await nameField(2), { target: { value: 'La mer, relue' } });
    fireEvent.submit(await nameField(2));
    await screen.findByRole('button', { name: /La mer, relue/ });

    expect(onRestore).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Restore into editor' }));
    expect(onRestore).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 2, content: 'La mer.', name: 'La mer, relue' }),
    );
    const list = screen.getByRole('list');
    expect(within(list).queryByText('La mer.')).toBeNull();
  });
});
