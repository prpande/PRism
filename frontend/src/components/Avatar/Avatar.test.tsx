import { describe, it, expect } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { Avatar } from './Avatar';

const HTTPS = 'https://avatars.githubusercontent.com/u/1?v=4';

describe('Avatar', () => {
  it('always renders the initial as the base layer, uppercased', () => {
    const { getByText } = render(<Avatar login="alice" />);
    expect(getByText('A')).toBeInTheDocument();
  });

  it('renders an <img> over the initials when src is an https URL', () => {
    const { container } = render(<Avatar src={HTTPS} login="alice" />);
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe(HTTPS);
    expect(img!.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(img!.getAttribute('loading')).toBe('eager'); // md default
  });

  it('uses lazy loading at the sm size', () => {
    const { container } = render(<Avatar src={HTTPS} login="alice" size="sm" />);
    expect(container.querySelector('img')!.getAttribute('loading')).toBe('lazy');
  });

  it('drops the <img> and shows initials when the image errors', () => {
    const { container, getByText } = render(<Avatar src={HTTPS} login="alice" />);
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
    expect(getByText('A')).toBeInTheDocument();
  });

  it('recovers on a new src after a prior error (instance reused)', () => {
    const { container, rerender } = render(<Avatar src={HTTPS} login="alice" />);
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
    rerender(<Avatar src="https://avatars.githubusercontent.com/u/2?v=4" login="alice" />);
    expect(container.querySelector('img')!.getAttribute('src')).toBe(
      'https://avatars.githubusercontent.com/u/2?v=4',
    );
  });

  it('strips a [bot] suffix before deriving the initial', () => {
    const { getByText } = render(<Avatar login="dependabot[bot]" />);
    expect(getByText('D')).toBeInTheDocument();
  });

  it('uses a digit initial for digit-leading logins and tolerates empty login', () => {
    const { getByText, getByTestId, rerender } = render(<Avatar login="42user" />);
    expect(getByText('4')).toBeInTheDocument();
    rerender(<Avatar login="" />);
    // empty login: no throw, no initial character
    expect(getByTestId('avatar')).toBeInTheDocument();
  });

  it('does not render an <img> for a non-https src (falls back to initials)', () => {
    const { container, getByText } = render(
      <Avatar src="data:image/svg+xml,<svg/>" login="alice" />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(getByText('A')).toBeInTheDocument();
  });
});
