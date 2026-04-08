import { describe, it, expect, beforeEach } from 'vitest';
import { scanForSecrets } from '../src/services/secret-scanner.js';
import { createTestContext, createTestDb, setupWorkspace, authHeaders, request, type TestContext } from './helpers.js';
import { createTask } from '../src/models/task.js';
import { definePlaybook } from '../src/models/playbook.js';
import { defineProfile } from '../src/models/profile.js';

describe('Secret Scanner', () => {
  describe('AWS keys', () => {
    it('should detect AWS Access Key ID', () => {
      const result = scanForSecrets('my key is AKIAIOSFODNN7EXAMPLE');
      expect(result.clean).toBe(false);
      expect(result.matches[0].pattern).toBe('AWS Access Key ID');
    });

    it('should detect AWS Secret Access Key with context', () => {
      // The regex requires a contextual prefix like aws_secret_access_key= to avoid false positives
      const key40 = 'wJalrXUtnFEMIzK7MDENGbPxRfiCYEXAMPLEKEYa';
      const result = scanForSecrets(`aws_secret_access_key=${key40}`);
      expect(result.clean).toBe(false);
      expect(result.matches[0].pattern).toBe('AWS Secret Access Key');
    });

    it('should not false-positive on bare 40-char strings', () => {
      // SHA-1 hashes, git commits, etc. should not trigger
      const hash = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';
      const result = scanForSecrets(`commit ${hash}`);
      // Should be clean (no AWS secret pattern without context)
      const awsMatch = result.matches.find(m => m.pattern === 'AWS Secret Access Key');
      expect(awsMatch).toBeUndefined();
    });
  });

  describe('Stripe keys', () => {
    it('should detect Stripe live secret key', () => {
      const result = scanForSecrets('sk_live_abcdefghijklmnopqrstuvwx');
      expect(result.clean).toBe(false);
      expect(result.matches[0].pattern).toBe('Stripe Secret Key');
    });

    it('should detect sk_test_ keys (test secrets can still leak)', () => {
      const result = scanForSecrets('sk_test_abcdefghijklmnopqrstuvwxyz1234');
      expect(result.clean).toBe(false);
      expect(result.matches[0].pattern).toBe('Stripe Test Key');
    });

    it('should detect Stripe restricted key', () => {
      const result = scanForSecrets('rk_live_abcdefghijklmnopqrstuvwx');
      expect(result.clean).toBe(false);
      expect(result.matches[0].pattern).toBe('Stripe Restricted Key');
    });
  });

  describe('Generic API keys', () => {
    it('should detect api_key=value pattern', () => {
      const result = scanForSecrets('api_key=abcdefghij1234567890klmnop');
      expect(result.clean).toBe(false);
      expect(result.matches[0].pattern).toBe('Generic Key Assignment');
    });

    it('should detect api-secret: value pattern', () => {
      const result = scanForSecrets('api-secret: "abcdefghij1234567890klmnop"');
      expect(result.clean).toBe(false);
      expect(result.matches[0].pattern).toBe('Generic Key Assignment');
    });

    it('should detect Bearer tokens (long)', () => {
      const token = 'Bearer ' + 'a'.repeat(50);
      const result = scanForSecrets(token);
      expect(result.clean).toBe(false);
      expect(result.matches[0].pattern).toBe('Bearer Token (long)');
    });
  });

  describe('Private keys', () => {
    it('should detect RSA private key block', () => {
      const result = scanForSecrets('-----BEGIN RSA PRIVATE KEY-----\nMIIEow...');
      expect(result.clean).toBe(false);
      expect(result.matches[0].pattern).toBe('Private Key Block');
    });

    it('should detect generic private key block', () => {
      const result = scanForSecrets('-----BEGIN PRIVATE KEY-----');
      expect(result.clean).toBe(false);
      expect(result.matches[0].pattern).toBe('Private Key Block');
    });
  });

  describe('GitHub tokens', () => {
    it('should detect GitHub PAT', () => {
      const result = scanForSecrets('ghp_' + 'a'.repeat(36));
      expect(result.clean).toBe(false);
      expect(result.matches[0].pattern).toBe('GitHub Personal Access Token');
    });

    it('should detect GitHub OAuth token', () => {
      const result = scanForSecrets('gho_' + 'A'.repeat(36));
      expect(result.clean).toBe(false);
      expect(result.matches[0].pattern).toBe('GitHub OAuth Token');
    });

    it('should detect GitHub App token', () => {
      const result = scanForSecrets('ghs_' + 'B'.repeat(36));
      expect(result.clean).toBe(false);
      expect(result.matches[0].pattern).toBe('GitHub App Token');
    });
  });

  describe('Slack tokens', () => {
    it('should detect Slack bot token', () => {
      const result = scanForSecrets('xoxb-1234567890-1234567890-abcdefghijklmnopqrstuvwx');
      expect(result.clean).toBe(false);
      expect(result.matches[0].pattern).toBe('Slack Bot Token');
    });

    it('should detect Slack webhook URL', () => {
      const result = scanForSecrets(
        'https://hooks.slack.com/services/T12345678/B12345678/abc123def456',
      );
      expect(result.clean).toBe(false);
      expect(result.matches[0].pattern).toBe('Slack Webhook URL');
    });
  });

  describe('AI provider keys', () => {
    it('should detect OpenAI API key', () => {
      const result = scanForSecrets('sk-' + 'a'.repeat(48));
      expect(result.clean).toBe(false);
      expect(result.matches[0].pattern).toBe('OpenAI API Key');
    });

    it('should detect Anthropic API key', () => {
      const result = scanForSecrets('sk-ant-' + 'a'.repeat(50));
      expect(result.clean).toBe(false);
      expect(result.matches[0].pattern).toBe('Anthropic API Key');
    });
  });

  describe('Database connection strings', () => {
    it('should detect PostgreSQL connection string', () => {
      const result = scanForSecrets('postgresql://user:password@host:5432/db');
      expect(result.clean).toBe(false);
      expect(result.matches[0].pattern).toBe('Database Connection String');
    });

    it('should detect MongoDB connection string', () => {
      const result = scanForSecrets('mongodb+srv://admin:secret@cluster.example.com');
      expect(result.clean).toBe(false);
      expect(result.matches[0].pattern).toBe('Database Connection String');
    });
  });

  describe('Clean content', () => {
    it('should allow plain text', () => {
      const result = scanForSecrets('This is a normal context entry about stripe webhooks');
      expect(result.clean).toBe(true);
      expect(result.matches).toHaveLength(0);
    });

    it('should allow code snippets without secrets', () => {
      const result = scanForSecrets('const handler = async (req, res) => { res.json({ ok: true }); }');
      expect(result.clean).toBe(true);
    });

    it('should allow short tokens that are not secrets', () => {
      const result = scanForSecrets('sk-short');
      expect(result.clean).toBe(true);
    });
  });

  describe('Secrets embedded in larger text', () => {
    it('should detect AWS key in a paragraph', () => {
      const text = `Here is how to configure the service.
        The access key is AKIAIOSFODNN7EXAMPLE and you should
        keep it safe. Never commit it to git.`;
      const result = scanForSecrets(text);
      expect(result.clean).toBe(false);
      expect(result.matches[0].pattern).toBe('AWS Access Key ID');
    });

    it('should detect private key in multiline content', () => {
      const text = `Configuration file:
-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA...
-----END RSA PRIVATE KEY-----
Make sure to use this for authentication.`;
      const result = scanForSecrets(text);
      expect(result.clean).toBe(false);
    });

    it('should provide a preview with masked middle', () => {
      const result = scanForSecrets('AKIAIOSFODNN7EXAMPLE');
      expect(result.clean).toBe(false);
      const preview = result.matches[0].preview;
      expect(preview).toContain('...');
      expect(preview.startsWith('AKIA')).toBe(true);
    });
  });

  describe('False positives resilience', () => {
    it('does not flag normal text that happens to contain common words', () => {
      const benign = [
        'My secret ingredient is love and kindness.',
        'The API documentation is available at /docs',
        'Use Bearer tokens for authentication (see RFC 6750)',
        'My password policy requires 12 characters',
        'Set the AWS_REGION environment variable to us-east-1',
      ];

      for (const text of benign) {
        const result = scanForSecrets(text);
        expect(result.clean).toBe(true);
      }
    });

    it('correctly flags real secret patterns', () => {
      const secrets = [
        'AKIAIOSFODNN7EXAMPLE',
        'sk_live_4eC39HqLyjWDarjtT1zdp7dc',
        'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234',
        '-----BEGIN RSA PRIVATE KEY-----',
      ];

      for (const text of secrets) {
        const result = scanForSecrets(text);
        expect(result.clean).toBe(false);
      }
    });

    it('handles empty and whitespace-only input', () => {
      expect(scanForSecrets('').clean).toBe(true);
      expect(scanForSecrets('   \n\t  ').clean).toBe(true);
    });
  });
});

// ─── Model-layer secret scanning (from round5-fixes) ──────────────────

describe('Model-layer secret scanning (protects both REST and model)', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  describe('createTask — model layer', () => {
    it('should reject task with secret in description at model layer', async () => {
      await expect(
        createTask(ctx.db, ctx.workspaceId, 'agent', {
          description: 'Deploy with AKIAIOSFODNN7EXAMPLE',
          status: 'open',
        }),
      ).rejects.toThrow(/secret/i);
    });

    it('should allow clean descriptions at model layer', async () => {
      const result = await createTask(ctx.db, ctx.workspaceId, 'agent', {
        description: 'Normal deployment task',
        status: 'open',
      });
      expect(result.task_id).toBeGreaterThan(0);
    });
  });

  describe('createTask — REST route', () => {
    it('should reject task with secret via REST POST /tasks', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/tasks', {
        headers: authHeaders(ctx.apiKey),
        body: { description: 'Use key AKIAIOSFODNN7EXAMPLE' },
      });
      expect(res.status).toBe(422);
      const data = await res.json();
      expect(data.error).toBe('SECRET_DETECTED');
    });
  });

  describe('definePlaybook — model layer', () => {
    it('should reject playbook with secret in task description at model layer', async () => {
      await expect(
        definePlaybook(ctx.db, ctx.workspaceId, 'agent', {
          name: 'bad-pb',
          description: 'Test',
          tasks: [{ description: 'Use sk_live_1234567890abcdefghijklmn' }],
        }),
      ).rejects.toThrow(/secret/i);
    });

    it('should reject playbook with secret in description at model layer', async () => {
      await expect(
        definePlaybook(ctx.db, ctx.workspaceId, 'agent', {
          name: 'bad-pb-desc',
          description: 'Deploy with AKIAIOSFODNN7EXAMPLE',
          tasks: [{ description: 'Clean step' }],
        }),
      ).rejects.toThrow(/secret/i);
    });
  });

  describe('definePlaybook — REST route', () => {
    it('should reject playbook with secret via REST', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/playbooks', {
        headers: authHeaders(ctx.apiKey),
        body: {
          name: 'rest-bad-pb',
          description: 'safe',
          tasks: [{ description: 'Deploy with AKIAIOSFODNN7EXAMPLE' }],
        },
      });
      expect(res.status).toBe(422);
    });
  });

  describe('defineProfile — model layer', () => {
    it('should reject profile with secret in system_prompt at model layer', async () => {
      await expect(
        defineProfile(ctx.db, ctx.workspaceId, 'agent', {
          name: 'bad-prof',
          description: 'Test profile',
          system_prompt: 'Use api_key=SuperSecretKey12345678 for everything',
        }),
      ).rejects.toThrow(/secret/i);
    });
  });

  describe('defineProfile — REST route', () => {
    it('should reject profile with secret via REST', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/profiles', {
        headers: authHeaders(ctx.apiKey),
        body: {
          name: 'rest-bad-prof',
          description: 'safe',
          system_prompt: 'Use AKIAIOSFODNN7EXAMPLE to auth',
        },
      });
      expect(res.status).toBe(422);
    });
  });
});
