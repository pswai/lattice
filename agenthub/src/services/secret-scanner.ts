export interface SecretMatch {
  pattern: string;
  preview: string;
}

export interface ScanResult {
  clean: boolean;
  matches: SecretMatch[];
}

const SECRET_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  // AWS
  { name: 'AWS Access Key ID', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'AWS Secret Access Key', regex: /(?:aws_secret_access_key|aws_secret|secret_access_key|secretaccesskey)\s*[:=]\s*['"]?([A-Za-z0-9/+=]{40})['"]?/i },

  // Stripe
  { name: 'Stripe Secret Key', regex: /\bsk_live_[0-9a-zA-Z]{24,}\b/ },
  { name: 'Stripe Test Key', regex: /\bsk_test_[0-9a-zA-Z]{24,}\b/ },
  { name: 'Stripe Restricted Key', regex: /\brk_live_[0-9a-zA-Z]{24,}\b/ },

  // Generic API keys / tokens
  { name: 'Generic Key Assignment', regex: /\b(?:api[_-]?key|apikey|api[_-]?secret|secret[_-]?key|access[_-]?key|auth[_-]?token)\s*[:=]\s*['"]?([A-Za-z0-9_\-]{16,})['"]?/i },
  { name: 'Password Assignment', regex: /\b(?:password|passwd|pwd)\s*[:=]\s*['"]?([^\s'"]{8,})['"]?/i },
  { name: 'Bearer Token (long)', regex: /\bBearer\s+[A-Za-z0-9_\-\.]{40,}\b/ },
  { name: 'Private Key Block', regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/ },

  // JWT
  { name: 'JWT Token', regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\b/ },

  // GitHub
  { name: 'GitHub Personal Access Token', regex: /\bghp_[A-Za-z0-9]{36}\b/ },
  { name: 'GitHub OAuth Token', regex: /\bgho_[A-Za-z0-9]{36}\b/ },
  { name: 'GitHub App Token', regex: /\bghs_[A-Za-z0-9]{36}\b/ },
  { name: 'GitHub Fine-grained Token', regex: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },

  // Slack
  { name: 'Slack Bot Token', regex: /\bxoxb-[0-9]{10,}-[0-9]{10,}-[A-Za-z0-9]{24,}\b/ },
  { name: 'Slack User Token', regex: /\bxoxp-[0-9]{10,}-[0-9]{10,}-[A-Za-z0-9]{24,}\b/ },
  { name: 'Slack Webhook URL', regex: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/ },

  // OpenAI / Anthropic
  { name: 'OpenAI API Key', regex: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { name: 'Anthropic API Key', regex: /\bsk-ant-[A-Za-z0-9_\-]{20,}\b/ },

  // Database URLs with credentials
  { name: 'Database Connection String', regex: /(?:postgresql|mysql|mongodb(?:\+srv)?):\/\/[^\s:]+:[^\s@]+@/ },

  // Google
  { name: 'Google API Key', regex: /\bAIza[A-Za-z0-9_\-]{35}\b/ },
];

export function scanForSecrets(text: string): ScanResult {
  const matches: SecretMatch[] = [];

  for (const { name, regex } of SECRET_PATTERNS) {
    const match = regex.exec(text);
    if (match) {
      const full = match[0];
      const preview = full.length > 12
        ? `${full.slice(0, 4)}...${full.slice(-4)}`
        : `${full.slice(0, 4)}...`;
      matches.push({ pattern: name, preview });
    }
  }

  return { clean: matches.length === 0, matches };
}
