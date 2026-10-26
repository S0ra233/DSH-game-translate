import { REMOTE_INFO } from './remote-info.js';
export const TYPERT = { package: 'dsh-game-translate', face: 'host', schemas: [],
  get invocations() { return REMOTE_INFO.descriptors; },
  model: { services: [{ key: 'translationUi', exportName: 'TranslationUi', tags: [], types: [],
    members: [{ kind: 'method', name: 'request', signature: 'request(sessionId: string, request: string, signal: AbortSignal): Promise<string>' },
      { kind: 'method', name: 'openNative', signature: 'openNative(sessionId: string, appearance: string, signal: AbortSignal): Promise<string>' }] }], events: [], objects: [] } };
