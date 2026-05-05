import { render } from '@testing-library/react';
import { App } from '../src/App';
import { describe, it, expect } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

describe('App', () => {
  it('renders without crashing', () => {
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );
    expect(document.body).toBeTruthy();
  });
});
