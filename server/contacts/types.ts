export type RelationshipType = 'family' | 'friend' | 'colleague' | 'classmate' | 'mentor' | 'partner' | 'other';

export const RELATIONSHIP_LABELS: Record<RelationshipType, { zh: string; en: string }> = {
  family:    { zh: '家人', en: 'Family' },
  friend:    { zh: '朋友', en: 'Friend' },
  colleague: { zh: '同事', en: 'Colleague' },
  classmate: { zh: '同学', en: 'Classmate' },
  mentor:    { zh: '导师', en: 'Mentor' },
  partner:   { zh: '伴侣', en: 'Partner' },
  other:     { zh: '其他', en: 'Other' },
};

export interface Contact {
  id: string;
  userId: string;
  name: string;
  phone?: string;
  email?: string;
  company?: string;
  relationship: RelationshipType;
  tags: string[];
  notes: string;
  traits: string;
  preferences: string;
  lastContacted: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ContactInput = Omit<Contact, 'id' | 'userId' | 'lastContacted' | 'createdAt' | 'updatedAt'> & {
  lastContacted?: string | null;
};
