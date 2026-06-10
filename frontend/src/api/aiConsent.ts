import { apiClient } from './client';

export interface EgressDisclosure {
  recipient: string;
  dataCategories: string[];
  disclosureVersion: string;
  alreadyConsented: boolean;
}

export function getEgressDisclosure(): Promise<EgressDisclosure> {
  return apiClient.get<EgressDisclosure>('/api/ai/egress-disclosure');
}

export function postAiConsent(disclosureVersion: string): Promise<void> {
  return apiClient.post<void>('/api/ai/consent', { disclosureVersion });
}
