import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { base, mine, theirs } from './fixtures';
import { ReconciliationView } from './ReconciliationView';

const setup = (texts: { base: string; mine: string; theirs: string } = { base, mine, theirs }) => {
  const onConfirm = vi.fn<(text: string) => void>();
  const onCancel = vi.fn<() => void>();
  const props = { ...texts, mineLabel: 'This device', theirsLabel: 'Other device', onConfirm, onCancel };
  const view = render(<ReconciliationView {...props} />);
  const rerender = (next: Partial<typeof texts>) => view.rerender(<ReconciliationView {...props} {...next} />);
  return { onConfirm, onCancel, rerender };
};

const conflict = (n: number) => screen.getByRole('region', { name: new RegExp(`^Conflict ${n} of 3`) });
const confirm = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Confirm' });
const keep = (n: number, name: string) => fireEvent.click(within(conflict(n)).getByRole('button', { name }));

describe('ReconciliationView', () => {
  it('confirms at once when nothing overlaps', () => {
    const { onConfirm } = setup({
      base: 'Il pleuvait sur la ville.',
      mine: 'Il pleuvait fort sur la ville.',
      theirs: 'Il pleuvait sur la vieille ville.',
    });

    expect(screen.getByRole('status')?.textContent).toContain('Everything is resolved.');
    expect(screen.queryByRole('region')).toBeNull();
    fireEvent.click(confirm());
    expect(onConfirm).toHaveBeenCalledWith('Il pleuvait fort sur la vieille ville.');
  });

  it('attributes every applied change to its side, in words and not only in colour', () => {
    setup();

    const text = document.querySelector('.reconcile-text');
    expect(text?.textContent).toContain('Added by Other device: vieux');
    expect(text?.textContent).toContain('Removed by This device: seulAdded by This device: solitaire');
    // The deletion on this device's side of the third conflict.
    expect(text?.textContent).toContain('Removed by This device: , presque effacée par le sel');
  });

  it('counts the conflicts left and enables Confirm only once all are resolved', () => {
    const { onConfirm } = setup();

    screen.getByText('3 conflicts left to resolve');
    expect(confirm().disabled).toBe(true);
    keep(1, 'Keep This device');
    keep(2, 'Keep Other device');
    screen.getByText('1 conflict left to resolve');
    expect(confirm().disabled).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();

    keep(3, 'Keep This device');
    screen.getByText('Everything is resolved.');
    fireEvent.click(confirm());
    expect(onConfirm).toHaveBeenCalledOnce();
    const text = onConfirm.mock.calls[0]?.[0];
    expect(text).toContain('Chaque soir, la gardienne montait');
    expect(text).toContain('entre le vert et le bleu');
    expect(text).toContain('L’écriture était fine.');
  });

  it('puts both texts, joined as written, in the edit field, so a separator can be added', () => {
    const { onConfirm } = setup();
    keep(1, 'Keep Other device');
    keep(3, 'Keep Other device');
    keep(2, 'Keep both');

    const field = within(conflict(2)).getByRole<HTMLTextAreaElement>('textbox', { name: /joined exactly as written/ });
    expect(field.value).toBe('l’ardoise le vert ');
    expect(within(conflict(2)).getByRole('button', { name: 'Keep both' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.change(field, { target: { value: 'l’ardoise, le vert ' } });
    expect(within(conflict(2)).getByRole('button', { name: 'Edit by hand' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(confirm());
    expect(onConfirm.mock.calls[0]?.[0]).toContain('entre l’ardoise, le vert et le bleu');
  });

  it('edits by hand from this device’s text, and brings the edit back after another choice', () => {
    setup();
    keep(2, 'Edit by hand');
    const field = within(conflict(2)).getByRole<HTMLTextAreaElement>('textbox', { name: 'Your text for this passage' });
    expect(field.value).toBe('l’ardoise ');
    fireEvent.change(field, { target: { value: 'l’ardoise verte ' } });

    keep(2, 'Keep Other device');
    expect(within(conflict(2)).queryByRole('textbox')).toBeNull();
    keep(2, 'Edit by hand');
    expect(within(conflict(2)).getByRole<HTMLTextAreaElement>('textbox').value).toBe('l’ardoise verte ');
  });

  it('keeps a hand edit when the other device changes the text again, and asks to check it', () => {
    const { onConfirm, rerender } = setup();
    keep(1, 'Keep This device');
    keep(3, 'Keep Other device');
    keep(2, 'Edit by hand');
    fireEvent.change(within(conflict(2)).getByRole('textbox'), { target: { value: 'le bleu-gris ' } });

    rerender({ theirs: theirs.replace('le vert', 'le vert pâle') });

    screen.getByText(/changed the text again while this view was open/);
    within(conflict(2)).getByText('Changed again');
    expect(within(conflict(2)).getByRole<HTMLTextAreaElement>('textbox').value).toBe('le bleu-gris ');
    screen.getByText('1 conflict left to resolve');
    expect(confirm().disabled).toBe(true);

    keep(2, 'Keep my earlier choice');
    fireEvent.click(confirm());
    expect(onConfirm.mock.calls[0]?.[0]).toContain('entre le bleu-gris et le bleu');
  });

  it('shows a hand edit whose passage disappeared until the writer dismisses it', () => {
    const { rerender } = setup();
    keep(2, 'Edit by hand');
    fireEvent.change(within(conflict(2)).getByRole('textbox'), { target: { value: 'le bleu-gris ' } });

    rerender({ theirs: theirs.replace('le vert', 'le gris') });

    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Your earlier hand-written text' }).value).toBe(
      'le bleu-gris ',
    );
    expect(screen.getAllByRole('region', { name: /^Conflict \d of 2/ })).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('textbox', { name: 'Your earlier hand-written text' })).toBeNull();
  });

  it('moves the focus on after each choice, for keyboard use', () => {
    const { onCancel } = setup();

    const buttons = within(conflict(1)).getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual([
      'Keep This device',
      'Keep Other device',
      'Keep both',
      'Edit by hand',
    ]);
    keep(1, 'Keep This device');
    expect(document.activeElement).toBe(within(conflict(2)).getByRole('heading', { name: /Conflict 2 of 3/ }));
    keep(2, 'Edit by hand');
    expect(document.activeElement).toBe(within(conflict(2)).getByRole('textbox'));
    keep(3, 'Keep Other device');
    expect(document.activeElement).toBe(confirm());

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
