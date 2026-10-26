import { z } from 'zod';
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info';

// 小型显式线协议：参数与返回均严格为字符串，JSON 业务字段由 Host 和 Core 校验。
const stringCodec = name => ({ mode: 'strict', typeSymbol: `dsh-game-translate#${name}`,
  create: () => z.string(), jsonSchema: { type: 'string' } });
export const REMOTE_INFO = createTypertRemoteInfo({ package: 'dsh-game-translate', methods: {
  'translationUi/request': { service: 'translationUi', invocation: { kind: 'direct' },
    description: 'Read translation state and perform user directory/settings actions without resuming an Agent.',
    parameters: ['sessionId', 'request'].map(name => ({ name, source: 'json', codec: stringCodec(name), strictCodec: stringCodec(name) })),
    cancellation: { parameter: 'signal' }, result: stringCodec('result') },
  'translationUi/openNative': { service: 'translationUi', invocation: { kind: 'direct' },
    description: 'Open or focus the local owner native translation window; no model request.',
    parameters: ['sessionId', 'appearance'].map(name => ({ name, source: 'json', codec: stringCodec(name), strictCodec: stringCodec(name) })),
    cancellation: { parameter: 'signal' }, result: stringCodec('native-result') },
} }, z);
export default REMOTE_INFO;
