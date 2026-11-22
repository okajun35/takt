import { callKiro, type KiroCallOptions } from '../kiro/index.js';
import { resolveKiroApiKey, resolveKiroCliPath } from '../config/index.js';
import { createLogger } from '../../shared/utils/index.js';
import type { AgentResponse } from '../../core/models/index.js';
import type { AgentSetup, Provider, ProviderAgent, ProviderCallOptions } from './types.js';

const log = createLogger('kiro-provider');

function toKiroOptions(options: ProviderCallOptions, systemPrompt?: string): KiroCallOptions {
  if (options.allowedTools && options.allowedTools.length > 0) {
    log.info('Kiro provider does not support allowedTools; ignoring');
  }
  if (options.maxTurns !== undefined) {
    log.info('Kiro provider does not support maxTurns; ignoring');
  }
  if (options.outputSchema) {
    log.info('Kiro provider does not support outputSchema; ignoring');
  }
  if (options.imageAttachments && options.imageAttachments.length > 0) {
    log.info('Kiro provider does not support imageAttachments; ignoring');
  }

  return {
    cwd: options.cwd,
    abortSignal: options.abortSignal,
    sessionId: options.sessionId,
    model: options.model,
    systemPrompt,
    permissionMode: options.permissionMode,
    onStream: options.onStream,
    onActivity: options.onActivity,
    kiroApiKey: options.kiroApiKey ?? resolveKiroApiKey(),
    kiroCliPath: resolveKiroCliPath(),
    agent: options.providerOptions?.kiro?.agent,
    effort: options.providerOptions?.kiro?.effort,
    mode: options.providerOptions?.kiro?.mode,
    trustWorkspace: options.providerOptions?.kiro?.trustWorkspace,
    childProcessEnv: options.childProcessEnv,
    preparedMcp: options.preparedMcp,
  };
}

export class KiroProvider implements Provider {
  readonly supportsStructuredOutput = false;
  readonly supportsNativeImageInput = false;
  // kiro-cli には MCP 設定を実行時に注入する CLI フラグが無い。V3 は `--trust-workspace`
  // で cwd の `.kiro` 配下（agents / MCP）を読み込むが、takt が任意の MCP 設定を実行時
  // 指定する手段は依然ないため、runtime MCP 割り当ては非対応と宣言する。
  // 対話モードは MCP 利用不可の通知を出して継続し、workflow の割り当ては fail-fast する。
  readonly supportedMcpTransports: ReadonlySet<'stdio' | 'sse' | 'http'> = new Set();

  getRuntimeInstructions(_allowedTools?: string[]): string | null {
    return null;
  }

  keepsAllowedToolWithoutEdit(_tool: string): boolean {
    return true;
  }

  setup(config: AgentSetup): ProviderAgent {
    const { name, systemPrompt } = config;

    return {
      call: async (prompt: string, options: ProviderCallOptions): Promise<AgentResponse> => {
        return callKiro(name, prompt, toKiroOptions(options, systemPrompt));
      },
    };
  }

}
