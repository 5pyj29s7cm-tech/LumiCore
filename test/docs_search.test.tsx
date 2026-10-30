// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enCatalog } from '../src/i18n/locales/catalog_en';
import { zhCatalog } from '../src/i18n/locales/catalog_zh';

const state = vi.hoisted(() => ({ data: undefined as any, loading: false }));
vi.mock('../src/hooks/useModuleData', () => ({ useModuleData: () => state }));
vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: any) => children,
  motion: { div: ({ children, className }: any) => <div className={className}>{children}</div> },
}));
import { Docs } from '../src/components/Docs';

beforeEach(() => {
  state.loading = false;
  state.data = { title: 'Documentation fixture', sections: [
    { id: 10, title: 'Alpha document', content: 'A synthetic nucleus reference.' },
    { id: 11, title: 'Beta document', content: 'Independent instructions.' },
  ] };
});
afterEach(cleanup);
function search(value: string) {
  fireEvent.change(screen.getByRole('textbox'), { target: { value } });
}

describe('documentation search', () => {
  it('matches fetched title or body without case or spacing sensitivity and restores all sections when cleared', () => {
    render(<Docs t={enCatalog} />);
    search('  SYNTHETIC   nucleus  ');
    expect(screen.getByRole('heading', { name: 'Alpha document' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Beta document' })).toBeNull();
    search('bETA document');
    expect(screen.getByRole('heading', { name: 'Beta document' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Alpha document' })).toBeNull();
    search('   ');
    expect(screen.getByRole('heading', { name: 'Alpha document' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Beta document' })).toBeTruthy();
  });

  it('searches hidden tab card content and restores the selected tab after clearing', () => {
    render(<Docs t={enCatalog} />);
    search(enCatalog.authDoc.toUpperCase());
    expect(screen.getByRole('heading', { name: enCatalog.apiReference })).toBeTruthy();
    expect(screen.getByText(enCatalog.authDoc)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: enCatalog.corePhilosophy })).toBeNull();
    search('');
    expect(screen.getByRole('heading', { name: enCatalog.corePhilosophy })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: enCatalog.apiReference })).toBeNull();
    search('not-a-document');
    fireEvent.click(screen.getByRole('button', { name: enCatalog.apiReference }));
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('heading', { name: enCatalog.apiReference })).toBeTruthy();
  });

  it('searches local fallback documentation when no server sections exist', () => {
    state.data = { title: 'Offline docs' };
    render(<Docs t={enCatalog} />);
    search(enCatalog.localFirstProcessing);
    expect(screen.getByRole('heading', { name: enCatalog.securityPrivacy })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: enCatalog.smartHostProgram })).toBeNull();
  });

  it('reports no matches in the current locale and treats regex punctuation as literal text', () => {
    render(<Docs t={zhCatalog} />);
    search('[unmatched-query(');
    expect(screen.getByRole('status').textContent).toBe(zhCatalog.noMatchesFound);
    expect(screen.queryByRole('heading', { name: 'Alpha document' })).toBeNull();
    expect(screen.queryByRole('heading', { name: zhCatalog.corePhilosophy })).toBeNull();
    search('');
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('heading', { name: zhCatalog.corePhilosophy })).toBeTruthy();
  });

  it('renders matched server content as text rather than markup', () => {
    state.data.sections = [{ id: 12, title: 'Markup example', content: '<script>example-only</script>' }];
    const { container } = render(<Docs t={enCatalog} />);
    search('<script>');
    expect(screen.getByText('<script>example-only</script>')).toBeTruthy();
    expect(container.querySelector('script')).toBeNull();
  });
});
