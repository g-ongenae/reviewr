import type { Document, DocumentSummary } from '@reviewr/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reachability } from '../api';
import { createQueryClient } from '../queryClient';
import { Composer } from './Composer';
import { DocumentList } from './DocumentList';
import { RevisionHistory } from './RevisionHistory';
import { ServerStatus } from './ServerStatus';

const fetchMock = vi.mocked(fetch);

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const badGateway = () => new Response('<html>502 Bad Gateway</html>', { status: 502 });

/** Answers every request through `handler`, given the request path without the `/api` prefix. */
const serve = (handler: (path: string) => Response) =>
  fetchMock.mockImplementation((input) => {
    const url = input instanceof Request ? input.url : input.toString();
    return Promise.resolve(handler(new URL(url, 'http://localhost').pathname.replace(/^\/api/, '')));
  });

const summary: DocumentSummary = {
  id: 'doc-1',
  title: 'The lighthouse keeper',
  revision: 2,
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-02T10:00:00.000Z',
};
const openDocument: Document = { ...summary, content: 'Once upon a tide…' };

const healthy = (path: string): Response => {
  if (path === '/health') return json(200, { status: 'ok' });
  if (path === '/documents') return json(200, [summary]);
  if (path.endsWith('/revisions')) return json(200, []);
  return json(404, { statusCode: 404, message: 'Not found' });
};

const renderWithServerStatus = (ui: ReactNode) => {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { refetchOnWindowFocus: false, retry: false } });
  render(
    <QueryClientProvider client={queryClient}>
      {ui}
      <ServerStatus probeInterval={20} />
    </QueryClientProvider>,
  );
};

afterEach(() => {
  reachability.reportSuccess();
  fetchMock.mockReset();
});

describe('ServerStatus', () => {
  it('shows a single "Server unreachable" toast instead of raw statuses, then hides it once the server is back', async () => {
    serve(badGateway);
    renderWithServerStatus(
      <>
        <DocumentList selectedId={undefined} onSelect={() => {}} />
        <RevisionHistory document={openDocument} onRestore={() => {}} />
      </>,
    );

    expect(await screen.findByText('Server unreachable')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
    expect(screen.getAllByText('Server unreachable')).toHaveLength(1);
    expect(screen.queryByText(/status|502|Could not load/)).toBeNull();

    serve(healthy);

    await waitFor(() => expect(screen.queryByText('Server unreachable')).toBeNull());
    // What failed while the server was down loads again.
    expect(await screen.findByText('The lighthouse keeper')).toBeTruthy();
  });

  it('treats a network failure as the server being unreachable', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    renderWithServerStatus(<DocumentList selectedId={undefined} onSelect={() => {}} />);

    expect(await screen.findByText('Server unreachable')).toBeTruthy();
    expect(screen.queryByText(/Failed to fetch|Could not load/)).toBeNull();
  });

  it('keeps a readable inline message for errors the API answers itself, without the toast', async () => {
    serve((path) => (path === '/documents' ? new Response('', { status: 500 }) : healthy(path)));
    renderWithServerStatus(<DocumentList selectedId={undefined} onSelect={() => {}} />);

    expect(
      await screen.findByText('Could not load documents: The server ran into a problem. Please try again.'),
    ).toBeTruthy();
    expect(screen.queryByText('Server unreachable')).toBeNull();
    expect(screen.queryByText(/status 500/)).toBeNull();
  });

  it('lets the writer keep their text when saving fails because the server is unreachable', async () => {
    serve(badGateway);
    renderWithServerStatus(<Composer onCreated={() => {}} />);

    const textarea = screen.getByLabelText<HTMLTextAreaElement>('New document');
    fireEvent.change(textarea, { target: { value: 'A first line' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Server unreachable')).toBeTruthy();
    expect(textarea.value).toBe('A first line');
    expect(textarea.disabled).toBe(false);
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    expect(document.querySelector('.banner')).toBeNull();
  });
});
