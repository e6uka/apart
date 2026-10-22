import type { ExtRequestMethod, TabInfo } from "../shared/protocol";

export interface TabEvent {
  method: string;
  params: unknown;
  sessionId?: string;
}

export interface BrowserBackend {
  readonly connected: boolean;
  readonly headless?: boolean;
  request<T = unknown>(method: ExtRequestMethod, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  listTabs(): Promise<TabInfo[]>;
  onTab(tabId: number, listener: (event: TabEvent) => void): () => void;
}
