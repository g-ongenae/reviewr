import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { base, closing, merged, middle, mine, opening, theirs } from './fixtures';
import { ReconciliationView } from './ReconciliationView';

const setup = (texts: { base: string; mine: string; theirs: string } = { base, mine, theirs }) => {
  const onConfirm = vi.fn<(text: string) => void>();
  const onCancel = vi.fn<() => void>();
  const props = { ...texts, mineLabel: 'This device', theirsLabel: 'Other device', onConfirm, onCancel };
  const view = render(<ReconciliationView {...props} />);
  const rerender = (next: Partial<typeof texts>) => view.rerender(<ReconciliationView {...props} {...next} />);
  return { onConfirm, onCancel, rerender };
};

const conflict = (n: number) => screen.getByRole('region', { name: new RegExp(`^Conflict ${n} of `) });
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

  it('shows which side removed a passage, with the side’s own line style', () => {
    const { onConfirm } = setup({
      base: 'Avant. Un. Milieu. Deux. Centre. Trois. Après.',
      mine: 'Avant. Milieu. Deux. Centre. Après.',
      theirs: 'Avant. Un. Milieu. Centre. Après.',
    });

    const removals = [...document.querySelectorAll('.reconcile-text del')].map((del) => [
      del.parentElement?.className,
      del.textContent,
    ]);
    expect(removals).toEqual([
      ['by-mine', 'Removed by This device: Un. '],
      ['by-theirs', 'Removed by Other device: Deux. '],
      ['by-both', 'Removed by both sides: Trois. '],
    ]);
    // The legend shows the removal style of each side too.
    const legend = screen.getByRole('list', { name: 'Legend' });
    expect([...legend.querySelectorAll('li')].map((li) => [li.className, li.textContent])).toEqual([
      ['by-mine', 'This deviceaddedremoved'],
      ['by-theirs', 'Other deviceaddedremoved'],
      ['by-both', 'Bothaddedremoved'],
    ]);
    fireEvent.click(confirm());
    expect(onConfirm).toHaveBeenCalledWith('Avant. Milieu. Centre. Après.');
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
    expect(onConfirm).toHaveBeenCalledWith(merged(opening('la gardienne montait'), middle('le vert '), closing('')));
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
    expect(onConfirm).toHaveBeenCalledWith(
      merged(opening('Marthe gravissait'), middle('l’ardoise, le vert '), closing(', presque effacée par les embruns')),
    );
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
    expect(onConfirm).toHaveBeenCalledWith(
      merged(opening('la gardienne montait'), middle('le bleu-gris '), closing(', presque effacée par les embruns')),
    );
  });

  it('shows a hand edit whose passage disappeared, and blocks Confirm until the writer dismisses it', () => {
    const { onConfirm, rerender } = setup();
    keep(2, 'Edit by hand');
    fireEvent.change(within(conflict(2)).getByRole('textbox'), { target: { value: 'le bleu-gris ' } });

    rerender({ theirs: theirs.replace('le vert', 'le gris') });

    const orphan = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Your earlier hand-written text' });
    expect(orphan.value).toBe('le bleu-gris ');
    expect(screen.getAllByRole('region', { name: /^Conflict \d of 2/ })).toHaveLength(2);
    keep(1, 'Keep This device');
    keep(2, 'Keep Other device');
    screen.getByText('1 conflict left to resolve');
    expect(confirm().disabled).toBe(true);
    // Every conflict is resolved: the keyboard goes to the orphan, not to the disabled Confirm.
    expect(document.activeElement).toBe(orphan);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('textbox', { name: 'Your earlier hand-written text' })).toBeNull();
    expect(document.activeElement).toBe(confirm());
    fireEvent.click(confirm());
    expect(onConfirm).toHaveBeenCalledWith(
      merged(opening('la gardienne montait'), middle('l’ardoise '), closing(', presque effacée par les embruns')),
    );
  });

  it('brings the focus back to a conflict left behind, and to one marked “Changed again”', () => {
    const { rerender } = setup();
    keep(2, 'Keep This device');
    expect(document.activeElement).toBe(within(conflict(3)).getByRole('heading'));
    keep(3, 'Keep This device');
    expect(document.activeElement).toBe(within(conflict(1)).getByRole('heading'));
    keep(1, 'Keep Other device');
    expect(document.activeElement).toBe(confirm());

    rerender({ theirs: theirs.replace('Marthe gravissait', 'Marthe grimpait') });
    within(conflict(1)).getByText('Changed again');
    keep(3, 'Keep Other device');
    expect(document.activeElement).toBe(within(conflict(1)).getByRole('heading'));
    keep(1, 'Keep my earlier choice');
    expect(document.activeElement).toBe(confirm());
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
