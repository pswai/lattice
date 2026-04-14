// Sender identity gating for inbound bus messages surfaced as <channel> tags.
// Policy decisions are pure; config parsing fails closed.

export type SenderPolicy = 'workspace-trust' | 'allowlist' | 'denylist';

export type GatingConfig = {
  policy: SenderPolicy;
  allowlist: readonly string[];
  denylist: readonly string[];
};

const VALID_POLICIES: readonly SenderPolicy[] = ['workspace-trust', 'allowlist', 'denylist'];

export function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export function loadGatingConfig(env: NodeJS.ProcessEnv): GatingConfig {
  const raw = env.LATTICE_CHANNEL_SENDER_POLICY?.trim();
  const policy: SenderPolicy = raw && raw.length > 0 ? (raw as SenderPolicy) : 'workspace-trust';
  if (!VALID_POLICIES.includes(policy)) {
    throw new Error(
      `LATTICE_CHANNEL_SENDER_POLICY=${raw!}: must be one of ${VALID_POLICIES.join(', ')}`,
    );
  }
  return {
    policy,
    allowlist: parseList(env.LATTICE_CHANNEL_SENDER_ALLOWLIST),
    denylist: parseList(env.LATTICE_CHANNEL_SENDER_DENYLIST),
  };
}

export type GateDecision = { allow: true } | { allow: false; reason: string };

export function shouldEmit(cfg: GatingConfig, from: string): GateDecision {
  switch (cfg.policy) {
    case 'workspace-trust':
      return { allow: true };
    case 'allowlist':
      return cfg.allowlist.includes(from)
        ? { allow: true }
        : { allow: false, reason: 'not_in_allowlist' };
    case 'denylist':
      return cfg.denylist.includes(from)
        ? { allow: false, reason: 'in_denylist' }
        : { allow: true };
  }
}
