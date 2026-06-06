import { Link, type LinkProps } from 'react-router-dom';
import { useEffectiveLocation } from '../../hooks/useEffectiveLocation';

// A <Link> for navigation *inside* the Settings modal. react-router's
// location.state is per-history-entry, so a plain <Link> between panes would
// drop backgroundLocation and the chrome behind the scrim would snap to the
// /settings URL. SettingsLink re-attaches the effective background on every hop.
export function SettingsLink({ state, ...rest }: LinkProps) {
  const background = useEffectiveLocation();
  return <Link state={{ ...(state as object | undefined), backgroundLocation: background }} {...rest} />;
}
