import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scrubCredentials } from '../src/services/scrub.js';

// ---------------------------------------------------------------------------
// 1. Each pattern type is correctly redacted
// ---------------------------------------------------------------------------

describe('API keys and tokens → [CREDENTIAL_REDACTED]', () => {
  it('redacts api_key=...', () => {
    const input = 'config: api_key=abcdefghij1234567890xxxx';
    const result = scrubCredentials(input);
    assert.ok(result.includes('[CREDENTIAL_REDACTED]'));
    assert.ok(!result.includes('abcdefghij1234567890xxxx'));
  });

  it('redacts api-key=...', () => {
    const input = 'set api-key=abcdefghijklmnopqrstuvwx';
    const result = scrubCredentials(input);
    assert.ok(result.includes('[CREDENTIAL_REDACTED]'));
  });

  it('redacts apikey=...', () => {
    const input = 'apikey=ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const result = scrubCredentials(input);
    assert.ok(result.includes('[CREDENTIAL_REDACTED]'));
  });

  it('redacts token=...', () => {
    const input = 'token=xoxb-abc123def456ghi789jkl';
    const result = scrubCredentials(input);
    assert.ok(result.includes('[CREDENTIAL_REDACTED]'));
  });

  it('redacts secret=...', () => {
    const input = 'secret = "sk_live_abcdefghijklmnop1234"';
    const result = scrubCredentials(input);
    assert.ok(result.includes('[CREDENTIAL_REDACTED]'));
  });

  it('redacts password=...', () => {
    const input = "password=MyS3cretPassw0rdLongEnough1234";
    const result = scrubCredentials(input);
    assert.ok(result.includes('[CREDENTIAL_REDACTED]'));
  });

  it('redacts bearer tokens', () => {
    const input = 'bearer: ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ123456';
    const result = scrubCredentials(input);
    assert.ok(result.includes('[CREDENTIAL_REDACTED]'));
  });

  it('is case-insensitive', () => {
    const input = 'API_KEY=abcdefghijklmnopqrstuvwx';
    const result = scrubCredentials(input);
    assert.ok(result.includes('[CREDENTIAL_REDACTED]'));
  });

  it('handles colon separator', () => {
    const input = 'Token: abcdefghijklmnopqrstuvwx';
    const result = scrubCredentials(input);
    assert.ok(result.includes('[CREDENTIAL_REDACTED]'));
  });
});

describe('JWT tokens → [JWT_REDACTED]', () => {
  it('redacts a typical JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const input = `Authorization header: ${jwt}`;
    const result = scrubCredentials(input);
    assert.ok(result.includes('[JWT_REDACTED]'));
    assert.ok(!result.includes('eyJhbGciOiJ'));
  });

  it('does not match partial JWT (missing segment)', () => {
    // Only two segments -- should not match the JWT pattern
    const input = 'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0';
    const result = scrubCredentials(input);
    assert.ok(!result.includes('[JWT_REDACTED]'));
  });
});

describe('Base64 secrets → [SECRET_REDACTED]', () => {
  it('redacts key=<long base64>', () => {
    const b64 = 'QUJDREVGRkhJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xt';
    const input = `key=${b64}`;
    const result = scrubCredentials(input);
    // This may first match pattern 1 (CREDENTIAL) since "key" is not one of
    // the pattern-1 keywords -- actually, pattern 1 only matches:
    //   api[_-]?key | token | secret | password | bearer
    // "key" alone does NOT match pattern 1, so pattern 3 should apply.
    assert.ok(
      result.includes('[SECRET_REDACTED]'),
      `Expected [SECRET_REDACTED] but got: ${result}`
    );
    assert.ok(!result.includes(b64));
  });

  it('redacts secret=<long base64> (may be caught by pattern 1 first)', () => {
    // "secret" matches pattern 1, which runs first; that is fine — the value
    // is still redacted, just with a different marker.
    const b64 = 'QUJDREVGRkhJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xt';
    const input = `secret=${b64}`;
    const result = scrubCredentials(input);
    // Either CREDENTIAL_REDACTED (pattern 1) or SECRET_REDACTED (pattern 3)
    assert.ok(
      result.includes('[CREDENTIAL_REDACTED]') || result.includes('[SECRET_REDACTED]'),
      `Expected some redaction but got: ${result}`
    );
    assert.ok(!result.includes(b64));
  });

  it('handles base64 with trailing padding', () => {
    const b64 = 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY3ODk=';
    const input = `token = "${b64}"`;
    const result = scrubCredentials(input);
    // "token" matches pattern 1 first
    assert.ok(
      result.includes('[CREDENTIAL_REDACTED]') || result.includes('[SECRET_REDACTED]'),
      `Expected some redaction but got: ${result}`
    );
  });
});

describe('Email passwords → [EMAIL_CRED_REDACTED]', () => {
  it('redacts smtp password', () => {
    const input = 'smtp password=SuperSecret123!';
    const result = scrubCredentials(input);
    assert.ok(
      result.includes('[EMAIL_CRED_REDACTED]'),
      `Expected [EMAIL_CRED_REDACTED] but got: ${result}`
    );
  });

  it('redacts email pass', () => {
    const input = 'email account pass=MyP@ssw0rd!';
    const result = scrubCredentials(input);
    assert.ok(
      result.includes('[EMAIL_CRED_REDACTED]'),
      `Expected [EMAIL_CRED_REDACTED] but got: ${result}`
    );
  });

  it('redacts mail password with colon', () => {
    const input = 'mail server password: longpassword99';
    const result = scrubCredentials(input);
    assert.ok(
      result.includes('[EMAIL_CRED_REDACTED]'),
      `Expected [EMAIL_CRED_REDACTED] but got: ${result}`
    );
  });

  it('is case-insensitive', () => {
    const input = 'SMTP PASSWORD=MySecretPW1';
    const result = scrubCredentials(input);
    assert.ok(
      result.includes('[EMAIL_CRED_REDACTED]'),
      `Expected [EMAIL_CRED_REDACTED] but got: ${result}`
    );
  });
});

describe('SSH private keys → [PRIVATE_KEY_REDACTED]', () => {
  it('redacts RSA private key', () => {
    const key = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MhgHcTz6sE2I2yPB',
      'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789aBcDeFgHiJkLmNoPqRsT',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const input = `Credentials:\n${key}\nEnd`;
    const result = scrubCredentials(input);
    assert.ok(result.includes('[PRIVATE_KEY_REDACTED]'));
    assert.ok(!result.includes('BEGIN RSA PRIVATE KEY'));
    assert.ok(!result.includes('END RSA PRIVATE KEY'));
  });

  it('redacts EC private key', () => {
    const key = [
      '-----BEGIN EC PRIVATE KEY-----',
      'MHQCAQEEIKmK+operation/fake+base64data+here+for+testing==',
      '-----END EC PRIVATE KEY-----',
    ].join('\n');
    const result = scrubCredentials(key);
    assert.ok(result.includes('[PRIVATE_KEY_REDACTED]'));
  });

  it('redacts DSA private key block', () => {
    const key = [
      '-----BEGIN DSA PRIVATE KEY-----',
      'MIIEvgIBADANBgkqhkiG9w0BAQEFAASC...',
      '-----END DSA PRIVATE KEY-----',
    ].join('\n');
    const result = scrubCredentials(key);
    assert.ok(result.includes('[PRIVATE_KEY_REDACTED]'));
  });
});

// ---------------------------------------------------------------------------
// 2. Normal text passes through unchanged
// ---------------------------------------------------------------------------

describe('passthrough — normal text is not altered', () => {
  it('returns plain sentences unchanged', () => {
    const input = 'The deployment succeeded and all services are running normally.';
    assert.equal(scrubCredentials(input), input);
  });

  it('returns short code snippets unchanged', () => {
    const input = 'const x = 42; console.log(x);';
    assert.equal(scrubCredentials(input), input);
  });

  it('does not redact the word "token" on its own', () => {
    const input = 'Please pass a valid token to the API.';
    assert.equal(scrubCredentials(input), input);
  });

  it('does not redact short values that are not credentials', () => {
    const input = 'api_key=short';
    // value "short" is only 5 chars — below the 20-char minimum
    assert.equal(scrubCredentials(input), input);
  });

  it('returns empty string unchanged', () => {
    assert.equal(scrubCredentials(''), '');
  });
});

// ---------------------------------------------------------------------------
// 3. Null / undefined / non-string inputs return as-is
// ---------------------------------------------------------------------------

describe('non-string inputs are returned as-is', () => {
  it('returns null', () => {
    assert.equal(scrubCredentials(null), null);
  });

  it('returns undefined', () => {
    assert.equal(scrubCredentials(undefined), undefined);
  });

  it('returns a number', () => {
    assert.equal(scrubCredentials(42), 42);
  });

  it('returns an object reference', () => {
    const obj = { a: 1 };
    assert.equal(scrubCredentials(obj), obj);
  });

  it('returns false', () => {
    assert.equal(scrubCredentials(false), false);
  });

  it('returns 0 (falsy but not null/undefined)', () => {
    assert.equal(scrubCredentials(0), 0);
  });
});

// ---------------------------------------------------------------------------
// 4. Multiple credentials in one string are all caught
// ---------------------------------------------------------------------------

describe('multiple credentials in a single string', () => {
  it('redacts two different API keys', () => {
    const input =
      'First: api_key=aaaaaaaaaabbbbbbbbbbcccccccccc ' +
      'Second: token=xxxxxxxxxxyyyyyyyyyyyyzzzzzzzzzz';
    const result = scrubCredentials(input);
    const count = (result.match(/\[CREDENTIAL_REDACTED\]/g) || []).length;
    assert.ok(count >= 2, `Expected at least 2 redactions, got ${count}: ${result}`);
  });

  it('redacts a JWT and an API key together', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const input = `auth: ${jwt} and api_key=abcdefghij1234567890xxxx`;
    const result = scrubCredentials(input);
    assert.ok(result.includes('[JWT_REDACTED]'));
    assert.ok(result.includes('[CREDENTIAL_REDACTED]'));
  });

  it('redacts an email password and an SSH key together', () => {
    const sshKey = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIBogIBAAJBALRiMLAHudeSA/x3hB2f6+this+is+fake+key+data',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const input = `smtp password=MyMailP@ss1 and here is the key:\n${sshKey}`;
    const result = scrubCredentials(input);
    assert.ok(
      result.includes('[EMAIL_CRED_REDACTED]'),
      `Expected [EMAIL_CRED_REDACTED] in: ${result}`
    );
    assert.ok(
      result.includes('[PRIVATE_KEY_REDACTED]'),
      `Expected [PRIVATE_KEY_REDACTED] in: ${result}`
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Content around credentials is preserved
// ---------------------------------------------------------------------------

describe('surrounding content is preserved', () => {
  it('preserves text before the credential', () => {
    const input = 'Server config: api_key=abcdefghijklmnopqrstuvwx';
    const result = scrubCredentials(input);
    assert.ok(result.startsWith('Server config: '));
  });

  it('preserves text after the credential', () => {
    const input = 'api_key=abcdefghijklmnopqrstuvwx is now rotated.';
    const result = scrubCredentials(input);
    assert.ok(
      result.includes('[CREDENTIAL_REDACTED]'),
      `Expected credential to be redacted in: ${result}`
    );
    // The regex consumes through the value, but " is now rotated." should remain
    assert.ok(
      result.includes('rotated.'),
      `Expected trailing text to be preserved in: ${result}`
    );
  });

  it('preserves text around a JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const input = `[INFO] Token: ${jwt} | Expires: 3600s`;
    const result = scrubCredentials(input);
    assert.ok(result.startsWith('[INFO] '));
    assert.ok(result.includes('| Expires: 3600s') || result.includes('Expires: 3600s'));
  });

  it('preserves text around an SSH key', () => {
    const key = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'fakedata1234567890',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const input = `BEFORE\n${key}\nAFTER`;
    const result = scrubCredentials(input);
    assert.ok(result.includes('BEFORE'));
    assert.ok(result.includes('AFTER'));
    assert.ok(result.includes('[PRIVATE_KEY_REDACTED]'));
  });

  it('preserves multiline surrounding content with email cred', () => {
    const input = 'Line one\nsmtp password=LongEnoughPW here\nLine three';
    const result = scrubCredentials(input);
    assert.ok(result.includes('Line one'));
    assert.ok(result.includes('[EMAIL_CRED_REDACTED]'));
    // "Line three" should survive
    assert.ok(result.includes('Line three'));
  });
});
