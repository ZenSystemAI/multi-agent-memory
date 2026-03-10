// Credential scrubbing — redacts secrets before storing memories

const PATTERNS = [
  // API keys and tokens
  { regex: /(?:api[_-]?key|token|secret|password|bearer)\s*[:=]\s*['"]?[\w\-./]{20,}['"]?/gi, replace: '[CREDENTIAL_REDACTED]' },
  // JWT tokens
  { regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, replace: '[JWT_REDACTED]' },
  // Base64 long strings that look like secrets
  { regex: /(?:key|secret|token|password)\s*[:=]\s*['"]?[A-Za-z0-9+/]{40,}={0,2}['"]?/gi, replace: '[SECRET_REDACTED]' },
  // Email passwords
  { regex: /(?:smtp|email|mail).*?(?:pass|password)\s*[:=]\s*['"]?[^\s'"]{8,}['"]?/gi, replace: '[EMAIL_CRED_REDACTED]' },
  // SSH private keys
  { regex: /-----BEGIN [\w\s]+ PRIVATE KEY-----[\s\S]*?-----END [\w\s]+ PRIVATE KEY-----/g, replace: '[PRIVATE_KEY_REDACTED]' },
];

export function scrubCredentials(text) {
  if (!text || typeof text !== 'string') return text;
  let scrubbed = text;
  for (const { regex, replace } of PATTERNS) {
    scrubbed = scrubbed.replace(regex, replace);
  }
  return scrubbed;
}
