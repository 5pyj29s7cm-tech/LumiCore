// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('motion/react', () => ({ motion: {
  div: ({ children, initial, animate, transition, ...props }: any) => <div {...props}>{children}</div>,
  button: ({ children, initial, animate, transition, ...props }: any) => <button {...props}>{children}</button>,
} }));
import { FoundersSanctuary } from '../src/components/FoundersSanctuary';

afterEach(cleanup);

describe('founder presentation surface (not archive acceptance)', () => {
  it('returns to its owning surface exactly once per back click', () => {
    const onBack = vi.fn();
    render(<FoundersSanctuary t={{}} onBack={onBack} />);
    expect(onBack).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Back to Hub' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('uses supplied presentation labels and preserves the back action after rerender', () => {
    const oldBack = vi.fn(), currentBack = vi.fn();
    const view = render(<FoundersSanctuary t={{ returnToHub: 'Return to workspace' }} onBack={oldBack} />);
    view.rerender(<FoundersSanctuary t={{ returnToHub: 'Return to parent' }} onBack={currentBack} />);
    fireEvent.click(screen.getByRole('button', { name: 'Return to parent' }));
    expect(currentBack).toHaveBeenCalledTimes(1);
    expect(oldBack).not.toHaveBeenCalled();
  });

  it('renders supplied presentation text without interpreting it as markup', () => {
    const literal = '<img src=x onerror=alert(1)>';
    const view = render(<FoundersSanctuary t={{ sanctuaryHeroDesc: literal }} onBack={vi.fn()} />);
    expect(screen.getByText(literal)).toBeTruthy();
    expect(view.container.querySelector('img')).toBeNull();
  });
});
