import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useAskAiDrawer } from '../../contexts/AskAiDrawerContext';
import { parsePrRefFromPathname } from './parsePrRefFromPathname';

/**
 * Render-null component that closes the AskAi drawer when the user navigates
 * away from a PR Detail route. The drawer state itself lives in the provider;
 * this component owns the location-coupled effect so the provider stays
 * route-agnostic and testable in isolation.
 */
export function DrawerEffects() {
  const { isOpen, close } = useAskAiDrawer();
  const { pathname } = useLocation();
  const isOnPrDetail = parsePrRefFromPathname(pathname) !== null;

  useEffect(() => {
    if (!isOnPrDetail && isOpen) {
      close();
    }
  }, [isOnPrDetail, isOpen, close]);

  return null;
}
