export type Role = 'user' | 'assistant';

export interface UiAttachment {
  id: string;
  kind: 'image' | 'file';
  name: string;
  previewUrl?: string;
}

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  attachments?: UiAttachment[];
}

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  updatedAt: number;
}

export interface ApiChatMessage {
  role: Role;
  content: string;
}
