import type React from "react";
import type { LegalCaseFile } from "../../../lib/legalCaseStore";

export type LegalView = 'workspace' | 'packet' | 'external-research' | 'data-sources' | 'bid' | 'case-search' | 'asset-trace' | 'contract-review' | 'strategy' | 'verify' | 'import' | 'knowledge-sync';

export interface NavItem {
  id: LegalView;
  label: string;
  icon: React.ReactNode;
}

export type LegalCaseCreateInput = Pick<LegalCaseFile, 'title' | 'caseNumber' | 'party' | 'cause' | 'stage' | 'notes'>;

export interface LegalCaseReadinessItem {
  key: string;
  label: string;
  detail: string;
  status: 'done' | 'ready' | 'missing' | 'blocked' | 'manual';
  nextStep: string;
  done: boolean;
  view?: LegalView;
  tool?: string;
}
