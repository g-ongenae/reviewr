import type { Document, Revision, RevisionSummary } from '@reviewr/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../queryClient';
import { Composer } from './Composer';
import { Editor } from './Editor';

const fetchMock = vi.mocked(fetch);

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

const lastWeek = '2026-11-01T10:00:00.000Z';
const now = new Date().toISOString();

const yesterdayVersion: Revision = {
  documentId: 'doc-1',
  revision: 1,
  title: 'The lighthouse keeper',
  content: 'Once upon a tide, the keeper slept.',
  createdAt: lastWeek,
};
const savedToday: Document = {
  id: 'doc-1',
  title: 'The lighthouse keeper',
  revision: 2,
  content: 'Once upon a tide. The end.',
  createdAt: lastWeek,
  updatedAt: now,
};
const revisions: RevisionSummary[] = [
  { documentId: 'doc-1', revision: 2, title: savedToday.title, createdAt: now },
  { documentId: 'doc-1', revision: 1, title: savedToday.title, createdAt: lastWeek },
];

const renderWithQueries = (ui: ReactNode) => {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { refetchOnWindowFocus: false, retry: false } });
  render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
};

/** Value shown next to `label` in the panel's `section` group. */
const stat = (section: string, label: 'Total' | 'Today') => {
  const group = screen.getByRole('heading', { name: section }).closest('section');
  const term = within(group as HTMLElement).getByText(label);
  return term.nextElementSibling?.textContent;
};

beforeEach(() => {
  window.localStorage.clear();
  fetchMock.mockImplementation((input) => {
    const path = new URL(input instanceof Request ? input.url : input.toString(), 'http://localhost').pathname;
    if (path.endsWith('/revisions')) return Promise.resolve(json(revisions));
    if (path.endsWith('/revisions/1')) return Promise.resolve(json(yesterdayVersion));
    return Promise.resolve(new Response('', { status: 404 }));
  });
});

afterEach(() => fetchMock.mockReset());

describe('WritingStatsPanel', () => {
  it("measures today's writing against the last version saved before today, including unsaved edits", async () => {
    renderWithQueries(<Editor document={savedToday} onDeleted={() => {}} />);

    expect(stat('Words', 'Total')).toBe('6');
    expect(stat('Characters', 'Total')).toBe('26');
    expect(stat('Words', 'Today')).toBe('…');

    // Yesterday: "Once upon a tide, the keeper slept." (7 words).
    expect(await screen.findByText('−1')).toBeTruthy();
    // "," → ".", "the" → "The" (one letter), "keeper slept" → "end".
    expect(stat('Characters', 'Today')).toBe('+5−14');

    fireEvent.change(screen.getByPlaceholderText('Start writing…'), {
      target: { value: 'Once upon a tide. The end. Or was it?' },
    });
    expect(stat('Words', 'Total')).toBe('9');
    expect(stat('Words', 'Today')).toBe('+2');
  });

  it('can be hidden, and stays hidden on the next document', () => {
    renderWithQueries(<Composer onCreated={() => {}} />);
    fireEvent.change(screen.getByLabelText('New document'), { target: { value: 'A first line' } });
    expect(stat('Words', 'Today')).toBe('+3');
    expect(stat('Characters', 'Today')).toBe('+12−0');

    fireEvent.click(screen.getByRole('button', { name: 'Hide writing stats' }));
    expect(screen.queryByRole('complementary', { name: 'Writing stats' })).toBeNull();
    expect(window.localStorage.getItem('reviewr.writingStatsOpen')).toBe('false');

    screen.getByRole('button', { name: 'Show writing stats' });
  });
});
