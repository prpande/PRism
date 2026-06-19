import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EgressDisclosureBody } from './EgressDisclosureBody';
import type { EgressDisclosure } from '../../api/aiConsent';

const disclosure: EgressDisclosure = {
  recipient: 'Anthropic, via the Claude Code CLI',
  dataCategories: ['Pull request diff (changed files and their contents)', 'Title', 'Description'],
  disclosureVersion: '1',
  alreadyConsented: false,
};

describe('EgressDisclosureBody', () => {
  it('renders the recipient and every data category', () => {
    render(<EgressDisclosureBody disclosure={disclosure} />);
    expect(screen.getByText('Anthropic, via the Claude Code CLI')).toBeInTheDocument();
    for (const c of disclosure.dataCategories) {
      expect(screen.getByText(c)).toBeInTheDocument();
    }
  });
});
