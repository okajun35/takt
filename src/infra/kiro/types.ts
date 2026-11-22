import type { PermissionMode } from '../../core/models/index.js';
import type { KiroEffort, KiroMode } from '../../core/models/workflow-types.js';
import type { ProviderActivityCallback, StreamCallback } from '../../shared/types/provider.js';

export interface KiroCallOptions {
  cwd: string;
  abortSignal?: AbortSignal;
  sessionId?: string;
  model?: string;
  /** kiro-cli `--effort` value. Config schema already restricts it to the levels kiro-cli accepts. */
  effort?: KiroEffort;
  /** kiro-cli `--mode` value (V3 agent mode). `--agent` overrides the mode. */
  mode?: KiroMode;
  /**
   * kiro-cli `--trust-workspace` (V3). The flag is sent only when this is
   * explicitly `true` outside readonly mode — the flag trusts workspace-defined
   * hooks/MCP servers, which start external processes, so it is opt-in rather
   * than default. A `true` counts only when it comes from user-managed config
   * (global config or an env/CLI override); `true` in project config or any
   * workflow layer cannot grant it, while `false` refuses from any layer.
   * Omission only controls the flag: a folder the user previously trusted in
   * Kiro CLI keeps its persisted trust and may still load `.kiro`.
   */
  trustWorkspace?: boolean;
  systemPrompt?: string;
  permissionMode?: PermissionMode;
  onStream?: StreamCallback;
  onActivity?: ProviderActivityCallback;
  kiroApiKey?: string;
  kiroCliPath?: string;
  agent?: string;
  childProcessEnv?: Readonly<Record<string, string>>;
  /** Provider-prepared MCP material (issue #1137). */
  preparedMcp?: import('../providers/mcp/types.js').PreparedProviderMcp;
}
