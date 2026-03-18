import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateMemoryInput,
  validateType,
  validateContent,
  validateSourceAgent,
  validateImportance,
  validateMetadata,
  validateStringField,
} from '../src/middleware/validate.js';

// ---------------------------------------------------------------------------
// 1. Type validation
// ---------------------------------------------------------------------------

describe('validateType', () => {
  it('accepts valid types', () => {
    for (const type of ['event', 'fact', 'decision', 'status']) {
      assert.equal(validateType(type), null);
    }
  });

  it('rejects invalid types', () => {
    assert.ok(validateType('invalid'));
    assert.ok(validateType(''));
    assert.ok(validateType(null));
    assert.ok(validateType(undefined));
  });
});

// ---------------------------------------------------------------------------
// 2. Content validation
// ---------------------------------------------------------------------------

describe('validateContent', () => {
  it('accepts valid content', () => {
    assert.equal(validateContent('Hello world'), null);
    assert.equal(validateContent('a'.repeat(10000)), null);
  });

  it('rejects empty content', () => {
    assert.ok(validateContent(''));
    assert.ok(validateContent(null));
    assert.ok(validateContent(undefined));
  });

  it('rejects non-string content', () => {
    assert.ok(validateContent(123));
    assert.ok(validateContent({}));
  });

  it('rejects content exceeding max length', () => {
    const err = validateContent('a'.repeat(10001));
    assert.ok(err);
    assert.ok(err.includes('10000'));
  });
});

// ---------------------------------------------------------------------------
// 3. Source agent validation
// ---------------------------------------------------------------------------

describe('validateSourceAgent', () => {
  it('accepts valid agent names', () => {
    assert.equal(validateSourceAgent('claude-code'), null);
    assert.equal(validateSourceAgent('n8n'), null);
    assert.equal(validateSourceAgent('my_agent_123'), null);
    assert.equal(validateSourceAgent('a'), null);
  });

  it('rejects invalid agent names', () => {
    assert.ok(validateSourceAgent(''));
    assert.ok(validateSourceAgent(null));
    assert.ok(validateSourceAgent('has spaces'));
    assert.ok(validateSourceAgent('special!chars'));
    assert.ok(validateSourceAgent('a'.repeat(65)));
  });
});

// ---------------------------------------------------------------------------
// 4. Importance validation
// ---------------------------------------------------------------------------

describe('validateImportance', () => {
  it('accepts valid importance levels', () => {
    for (const imp of ['critical', 'high', 'medium', 'low']) {
      assert.equal(validateImportance(imp), null);
    }
  });

  it('allows null/undefined (optional field)', () => {
    assert.equal(validateImportance(null), null);
    assert.equal(validateImportance(undefined), null);
  });

  it('rejects invalid importance', () => {
    assert.ok(validateImportance('urgent'));
    assert.ok(validateImportance('HIGH'));
  });
});

// ---------------------------------------------------------------------------
// 5. Metadata validation
// ---------------------------------------------------------------------------

describe('validateMetadata', () => {
  it('accepts valid metadata', () => {
    assert.equal(validateMetadata({ key: 'value' }), null);
    assert.equal(validateMetadata({ nested: { deep: true } }), null);
    assert.equal(validateMetadata(null), null);
    assert.equal(validateMetadata(undefined), null);
  });

  it('rejects arrays', () => {
    assert.ok(validateMetadata([1, 2, 3]));
  });

  it('rejects oversized metadata', () => {
    const big = { data: 'x'.repeat(11000) };
    assert.ok(validateMetadata(big));
  });

  it('rejects deeply nested metadata', () => {
    const deep = { a: { b: { c: { d: 'too deep' } } } };
    assert.ok(validateMetadata(deep));
  });
});

// ---------------------------------------------------------------------------
// 6. String field validation
// ---------------------------------------------------------------------------

describe('validateStringField', () => {
  it('accepts valid strings', () => {
    assert.equal(validateStringField('hello', 'field'), null);
    assert.equal(validateStringField(null, 'field'), null);
    assert.equal(validateStringField(undefined, 'field'), null);
  });

  it('rejects non-strings', () => {
    assert.ok(validateStringField(123, 'field'));
    assert.ok(validateStringField({}, 'field'));
  });

  it('rejects strings exceeding max length', () => {
    assert.ok(validateStringField('a'.repeat(257), 'field'));
    assert.equal(validateStringField('a'.repeat(256), 'field'), null);
  });

  it('respects custom max length', () => {
    assert.ok(validateStringField('a'.repeat(65), 'field', 64));
    assert.equal(validateStringField('a'.repeat(64), 'field', 64), null);
  });
});

// ---------------------------------------------------------------------------
// 7. Full memory input validation
// ---------------------------------------------------------------------------

describe('validateMemoryInput — composite', () => {
  const valid = {
    type: 'event',
    content: 'Something happened',
    source_agent: 'claude-code',
  };

  it('accepts minimal valid input', () => {
    assert.equal(validateMemoryInput(valid), null);
  });

  it('accepts full valid input', () => {
    assert.equal(validateMemoryInput({
      ...valid,
      importance: 'high',
      client_id: 'acme',
      metadata: { extra: true },
      key: 'my-key',
      subject: 'my-subject',
      status_value: 'active',
    }), null);
  });

  it('returns first error found', () => {
    const err = validateMemoryInput({ type: 'invalid', content: '', source_agent: '' });
    assert.ok(err);
    assert.ok(err.includes('type') || err.includes('Invalid'));
  });

  it('catches bad metadata even if other fields are valid', () => {
    const err = validateMemoryInput({ ...valid, metadata: [1, 2, 3] });
    assert.ok(err);
    assert.ok(err.includes('metadata'));
  });
});
