import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { createTestDb } from './helpers/d1-sqlite.mjs';
import { first, run } from '../src/server/db.js';

import {
  SESSION_TTL_SECONDS,
  THROTTLE_MAX_ATTEMPTS,
  THROTTLE_WINDOW_MS,
  PBKDF2_MAX_ITERATIONS,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  AUTH_MESSAGES,
  sha256Hex,
  constantTimeEqual,
  verifyPassword,
  hashPassword,
  needsRehash,
  validateNewPassword,
  createSession,
  requireSession,
  revokeSession,
  login,
  getSession,
  logout,
} from '../src/server/auth.js';

const PEPPER = 'test-secret-pepper-32chars-min!!';
const DEFAULT_ENV = {
  PASSWORD_PEPPER: PEPPER,
  PASSWORD_HASH_ALGO: 'sha256',
};

// Independent reference for legacy hash
function legacyHashReference(salt, password, pepper) {
  const hex = createHash('sha256').update(salt + password + pepper, 'utf8').digest('hex');
  return `sha256$${salt}$${hex}`;
}

// Deep scanner to ensure no password or hash is leaked in responses
function assertNoPasswordOrHash(obj, path = 'root') {
  if (obj == null) return;
  if (typeof obj === 'string') {
    assert.ok(!obj.startsWith('sha256$'), `Found sha256 hash at ${path}: ${obj}`);
    assert.ok(!obj.startsWith('pbkdf2_sha256$'), `Found pbkdf2 hash at ${path}: ${obj}`);
    return;
  }
  if (typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj)) {
      const currentPath = `${path}.${key}`;
      assert.notEqual(key, 'password_hash', `Disallowed key "${key}" found at ${currentPath}`);
      assert.notEqual(key, 'password', `Disallowed key "${key}" found at ${currentPath}`);
      assertNoPasswordOrHash(value, currentPath);
    }
  }
}

// Helper to seed a user in the test database
async function seedUser(db, { username, password = 'Password123!', role = 'pengelola', namaLengkap = 'Nama User', sessionVersion = 1, hash } = {}) {
  const passwordHash = hash || await hashPassword(password, DEFAULT_ENV);
  return first(
    db,
    `INSERT INTO users (username, password_hash, nama_lengkap, role, session_version)
     VALUES (?1, ?2, ?3, ?4, ?5)
     RETURNING id, username, nama_lengkap, role, session_version`,
    username,
    passwordHash,
    namaLengkap,
    role,
    sessionVersion,
  );
}

/** Proxy yang melempar error D1 untuk SQL yang cocok `match` (pola sama dengan server-users.test.mjs). */
function failing(db, message, match = /./) {
  return {
    prepare(sql) {
      if (!match.test(sql)) return db.prepare(sql);
      const fail = async () => {
        throw new Error(message, { cause: new Error(message.replace(/^D1_ERROR: /, '')) });
      };
      const stmt = { bind: () => stmt, all: fail, first: fail, run: fail, raw: fail };
      return stmt;
    },
    batch(stmts) {
      return db.batch(stmts);
    },
  };
}

/** Menghitung pemanggilan `crypto.subtle[method]` selama `fn` berjalan. */
async function countSubtle(method, fn) {
  const proto = Object.getPrototypeOf(globalThis.crypto.subtle);
  const original = proto[method];
  let calls = 0;
  proto[method] = function counted(...args) {
    calls += 1;
    return original.apply(this, args);
  };
  try {
    await fn();
  } finally {
    proto[method] = original;
  }
  return calls;
}

// ─── 1. Crypto & Password Tests ─────────────────────────────────────────────

test('auth: sha256Hex produces correct digest for ASCII and UTF-8 strings', async () => {
  const ascii = 'hello world';
  const expectedAscii = createHash('sha256').update(ascii, 'utf8').digest('hex');
  assert.equal(await sha256Hex(ascii), expectedAscii);

  const utf8 = 'Kopi ☕ & Teh 🍵 123';
  const expectedUtf8 = createHash('sha256').update(utf8, 'utf8').digest('hex');
  assert.equal(await sha256Hex(utf8), expectedUtf8);
});

test('auth: constantTimeEqual compares strings in constant time', () => {
  assert.equal(constantTimeEqual('hello', 'hello'), true);
  assert.equal(constantTimeEqual('', ''), true);
  assert.equal(constantTimeEqual('☕', '☕'), true);
  assert.equal(constantTimeEqual(null, ''), true);
  assert.equal(constantTimeEqual('', undefined), true);

  assert.equal(constantTimeEqual('hello', 'hell'), false);
  assert.equal(constantTimeEqual('hell', 'hello'), false);
  assert.equal(constantTimeEqual('hello', 'world'), false);
  assert.equal(constantTimeEqual('a', null), false);
  assert.equal(constantTimeEqual('☕', '🍵'), false);
});

test('auth: verifyPassword verifies legacy sha256 hash from independent reference', async () => {
  const salt = '0123456789abcdef0123456789abcdef';
  const passwordAscii = 'AdminKgb2026!';
  const hashAscii = legacyHashReference(salt, passwordAscii, PEPPER);

  // Correct password + correct pepper
  assert.equal(await verifyPassword(passwordAscii, hashAscii, DEFAULT_ENV), true);

  // Non-ASCII password
  const passwordUtf8 = 'KopiPagi☕#2026';
  const hashUtf8 = legacyHashReference(salt, passwordUtf8, PEPPER);
  assert.equal(await verifyPassword(passwordUtf8, hashUtf8, DEFAULT_ENV), true);

  // Wrong password
  assert.equal(await verifyPassword('WrongPassword!', hashAscii, DEFAULT_ENV), false);

  // Wrong pepper
  assert.equal(await verifyPassword(passwordAscii, hashAscii, { PASSWORD_PEPPER: 'wrong-pepper' }), false);

  // Missing pepper -> CONFIG_ERROR
  await assert.rejects(
    async () => verifyPassword(passwordAscii, hashAscii, {}),
    (err) => err.code === 'CONFIG_ERROR' && err.message === AUTH_MESSAGES.PEPPER_MISSING_VERIFY,
  );
  await assert.rejects(
    async () => verifyPassword(passwordAscii, hashAscii, { PASSWORD_PEPPER: '' }),
    (err) => err.code === 'CONFIG_ERROR',
  );
  await assert.rejects(
    async () => verifyPassword(passwordAscii, hashAscii, null),
    (err) => err.code === 'CONFIG_ERROR',
  );
});

test('auth: hashPassword default sha256 format and verification', async () => {
  const password = 'VerySecurePassword123!';
  const hash = await hashPassword(password, DEFAULT_ENV);

  // Format: sha256$<32 hex salt>$<64 hex digest>
  assert.match(hash, /^sha256\$[0-9a-f]{32}\$[0-9a-f]{64}$/);

  // Verifies
  assert.equal(await verifyPassword(password, hash, DEFAULT_ENV), true);
  assert.equal(await verifyPassword('Wrong!', hash, DEFAULT_ENV), false);

  // Missing pepper for sha256 -> CONFIG_ERROR
  await assert.rejects(
    async () => hashPassword(password, {}),
    (err) => err.code === 'CONFIG_ERROR' && err.message === AUTH_MESSAGES.PEPPER_MISSING_HASH,
  );
});

test('auth: pbkdf2_sha256 roundtrip and iteration limits', async () => {
  const env = { PASSWORD_HASH_ALGO: 'pbkdf2_sha256', PBKDF2_ITERATIONS: 1000 };
  const password = 'Pbkdf2UserPassword1!';
  const hash = await hashPassword(password, env);

  // Format: pbkdf2_sha256$<iterations>$<saltBase64>$<hashBase64>
  assert.match(hash, /^pbkdf2_sha256\$1000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);

  // Verifies
  assert.equal(await verifyPassword(password, hash, env), true);
  assert.equal(await verifyPassword('WrongPass', hash, env), false);

  // Iterations > 100000 in env is capped at 100000
  const envHigh = { PASSWORD_HASH_ALGO: 'pbkdf2_sha256', PBKDF2_ITERATIONS: 150000 };
  // Note: we test that capping logic operates; to avoid slow test, test pbkdf2Iterations directly via needsRehash
  assert.equal(needsRehash(`pbkdf2_sha256$100000$c2FsdA==$aGFzaA==`, envHigh), false);

  // Stored hash with iterations > 100000 is rejected by verifyPassword (returns false)
  const invalidIterHash = `pbkdf2_sha256$100001$c2FsdA==$aGFzaA==`;
  assert.equal(await verifyPassword('any', invalidIterHash, env), false);

  // Unknown hash format returns false
  assert.equal(await verifyPassword('any', 'bcrypt$12$something', env), false);
  assert.equal(await verifyPassword('any', 'plaintext_password', env), false);
  assert.equal(await verifyPassword('any', '', env), false);
  assert.equal(await verifyPassword('any', null, env), false);
});

test('auth: validateNewPassword enforces min/max length with exact Code.js messages', () => {
  // Too short (< 8)
  assert.throws(
    () => validateNewPassword('1234567'),
    (err) => err.code === 'VALIDATION_ERROR' && err.message === 'Password minimal 8 karakter.',
  );
  assert.throws(
    () => validateNewPassword(''),
    (err) => err.code === 'VALIDATION_ERROR' && err.message === 'Password minimal 8 karakter.',
  );
  assert.throws(
    () => validateNewPassword(null),
    (err) => err.code === 'VALIDATION_ERROR' && err.message === 'Password minimal 8 karakter.',
  );

  // Too long (> 200)
  assert.throws(
    () => validateNewPassword('x'.repeat(201)),
    (err) => err.code === 'VALIDATION_ERROR' && err.message === 'Password terlalu panjang (maks 200 karakter).',
  );

  // Valid boundaries
  assert.equal(validateNewPassword('12345678'), '12345678');
  const maxPass = 'x'.repeat(200);
  assert.equal(validateNewPassword(maxPass), maxPass);

  // Does not trim spaces
  const passWithSpaces = '  spaces123  ';
  assert.equal(validateNewPassword(passWithSpaces), passWithSpaces);
});

// ─── 2. Sessions Tests ──────────────────────────────────────────────────────

test('auth: createSession stores only sha256 of token (assert raw token not in sessions)', async () => {
  const db = createTestDb();
  const user = await seedUser(db, { username: 'testuser' });

  const session = await createSession(db, user);
  assert.equal(typeof session.token, 'string');
  assert.equal(session.token.length, 43); // 32 bytes base64url without padding
  assert.equal(session.expiresIn, SESSION_TTL_SECONDS);

  // Check database
  const tokenHash = await sha256Hex(session.token);
  const row = await first(db, 'SELECT * FROM sessions WHERE token_hash = ?1', tokenHash);
  assert.ok(row, 'Session row must exist by token_hash');
  assert.equal(row.user_id, user.id);
  assert.equal(row.session_version, user.session_version);
  assert.equal(row.revoked_at, null);

  // Raw token must NEVER exist in sessions table
  const rawMatch = await first(db, 'SELECT * FROM sessions WHERE token_hash = ?1', session.token);
  assert.equal(rawMatch, null, 'Raw token must not be in token_hash column');
});

test('auth: requireSession valid session returns live identity', async () => {
  const db = createTestDb();
  const user = await seedUser(db, { username: 'alice', namaLengkap: 'Alice Wonder', role: 'admin' });
  const { token } = await createSession(db, user);

  const active = await requireSession(db, token);
  assert.deepEqual(active, {
    userId: user.id,
    username: 'alice',
    namaLengkap: 'Alice Wonder',
    hakAkses: 'admin',
    sessionVersion: 1,
  });
});

test('auth: requireSession expired session throws SESSION_EXPIRED', async () => {
  const db = createTestDb();
  const user = await seedUser(db, { username: 'bob' });
  const t0 = new Date('2026-10-15T00:00:00Z');
  const { token } = await createSession(db, user, t0);

  // 9 hours later (SESSION_TTL_SECONDS = 8 hours)
  const tLater = new Date('2026-10-15T09:00:01Z');
  await assert.rejects(
    async () => requireSession(db, token, { now: tLater }),
    (err) => err.code === 'SESSION_EXPIRED' && err.message === AUTH_MESSAGES.SESSION_EXPIRED,
  );
});

test('auth: requireSession revoked session throws AUTH_REQUIRED', async () => {
  const db = createTestDb();
  const user = await seedUser(db, { username: 'charlie' });
  const { token } = await createSession(db, user);

  await revokeSession(db, token);

  await assert.rejects(
    async () => requireSession(db, token),
    (err) => err.code === 'AUTH_REQUIRED' && err.message === AUTH_MESSAGES.SESSION_INVALID,
  );
});

test('auth: requireSession with session_version bumped via SQL throws AUTH_REQUIRED', async () => {
  const db = createTestDb();
  const user = await seedUser(db, { username: 'david' });
  const { token } = await createSession(db, user);

  // Bump user session_version directly in SQL
  await run(db, 'UPDATE users SET session_version = session_version + 1 WHERE id = ?1', user.id);

  await assert.rejects(
    async () => requireSession(db, token),
    (err) => err.code === 'AUTH_REQUIRED' && err.message === AUTH_MESSAGES.SESSION_STALE,
  );
});

test('auth: requireSession with deleted user (cascade) throws AUTH_REQUIRED', async () => {
  const db = createTestDb();
  const user = await seedUser(db, { username: 'eve' });
  const { token } = await createSession(db, user);

  // Delete user (FOREIGN KEY cascade removes session)
  await run(db, 'DELETE FROM users WHERE id = ?1', user.id);

  await assert.rejects(
    async () => requireSession(db, token),
    (err) => err.code === 'AUTH_REQUIRED' && err.message === AUTH_MESSAGES.SESSION_INVALID,
  );
});

test('auth: requireSession admin check throws FORBIDDEN for non-admin and supports custom message', async () => {
  const db = createTestDb();
  const user = await seedUser(db, { username: 'frank', role: 'pengelola' });
  const { token } = await createSession(db, user);

  // Normal requireSession passes
  const nonAdmin = await requireSession(db, token);
  assert.equal(nonAdmin.hakAkses, 'pengelola');

  // requireSession with admin: true throws FORBIDDEN
  await assert.rejects(
    async () => requireSession(db, token, { admin: true }),
    (err) => err.code === 'FORBIDDEN' && err.message === AUTH_MESSAGES.FORBIDDEN_ADMIN,
  );

  // Custom forbidden message
  await assert.rejects(
    async () => requireSession(db, token, { admin: true, forbiddenMessage: 'Hanya admin super!' }),
    (err) => err.code === 'FORBIDDEN' && err.message === 'Hanya admin super!',
  );
});

test('auth: requireSession returns LIVE role and nama', async () => {
  const db = createTestDb();
  const user = await seedUser(db, { username: 'grace', namaLengkap: 'Nama Lama', role: 'pengelola' });
  const { token } = await createSession(db, user);

  // Update nama without bumping session_version
  await run(db, 'UPDATE users SET nama_lengkap = ?1 WHERE id = ?2', 'Nama Baru Terkini', user.id);

  const active = await requireSession(db, token);
  assert.equal(active.namaLengkap, 'Nama Baru Terkini');
});

test('auth: requireSession with malformed token throws AUTH_REQUIRED with zero queries', async () => {
  const dummyDb = {
    prepare() {
      throw new Error('Database query must not be executed for malformed token!');
    },
  };

  const malformedTokens = ['', 'short', 'abc!', 'x'.repeat(42), 'x'.repeat(44), null, undefined, 12345];
  for (const token of malformedTokens) {
    await assert.rejects(
      async () => requireSession(dummyDb, token),
      (err) => err.code === 'AUTH_REQUIRED' && err.message === AUTH_MESSAGES.SESSION_INVALID,
    );
  }
});

// ─── 3. Login Tests ─────────────────────────────────────────────────────────

test('auth: login success shape, stored-case username, and deep scan for leaks', async () => {
  const db = createTestDb();
  await seedUser(db, {
    username: 'admin',
    password: 'Password123!',
    namaLengkap: 'Administrator Utama',
    role: 'admin',
  });

  const res = await login(db, DEFAULT_ENV, { username: 'admin', password: 'Password123!' });

  assert.equal(res.status, 'success');
  assert.equal(typeof res.sessionToken, 'string');
  assert.equal(res.sessionToken.length, 43);
  assert.equal(res.expiresIn, 28800);
  assert.deepEqual(res.user, {
    username: 'admin',
    namaLengkap: 'Administrator Utama',
    hakAkses: 'admin',
  });

  // Deep scan: no password_hash or password anywhere in returned object
  assertNoPasswordOrHash(res);
});

test('auth: login is case-insensitive and returns stored-case username', async () => {
  const db = createTestDb();
  await seedUser(db, {
    username: 'operator1',
    password: 'Password123!',
    namaLengkap: 'Operator Satu',
    role: 'pengelola',
  });

  // Login with uppercase variant
  const resUpper = await login(db, DEFAULT_ENV, { username: 'OPERATOR1', password: 'Password123!' });
  assert.equal(resUpper.status, 'success');
  assert.equal(resUpper.user.username, 'operator1');

  // Login with mixed case variant
  const resMixed = await login(db, DEFAULT_ENV, { username: 'Operator1', password: 'Password123!' });
  assert.equal(resMixed.status, 'success');
  assert.equal(resMixed.user.username, 'operator1');
});

test('auth: throttle blocks 6th attempt even with correct password after 5 failures', async () => {
  const db = createTestDb();
  await seedUser(db, {
    username: 'victim',
    password: 'CorrectPassword123!',
  });

  // 5 failed attempts with wrong password
  for (let i = 1; i <= 5; i += 1) {
    await assert.rejects(
      async () => login(db, DEFAULT_ENV, { username: 'victim', password: 'WrongPassword!' }),
      (err) => err.code === 'INVALID_CREDENTIALS',
    );
  }

  // 6th attempt with CORRECT password must be blocked with INVALID_CREDENTIALS
  await assert.rejects(
    async () => login(db, DEFAULT_ENV, { username: 'victim', password: 'CorrectPassword123!' }),
    (err) => err.code === 'INVALID_CREDENTIALS' && err.message === AUTH_MESSAGES.INVALID_CREDENTIALS,
  );
});

test('auth: unknown usernames share one bucket and do not block known accounts', async () => {
  const db = createTestDb();
  await seedUser(db, {
    username: 'knownuser',
    password: 'KnownPassword123!',
  });

  // 5 failed attempts with 5 different unknown usernames
  for (let i = 1; i <= 5; i += 1) {
    await assert.rejects(
      async () => login(db, DEFAULT_ENV, { username: `ghost_${i}`, password: 'some_password' }),
      (err) => err.code === 'INVALID_CREDENTIALS',
    );
  }

  // 6th attempt with another unknown username is throttled
  await assert.rejects(
    async () => login(db, DEFAULT_ENV, { username: 'ghost_6', password: 'some_password' }),
    (err) => err.code === 'INVALID_CREDENTIALS',
  );

  // Known account must NOT be blocked by the exhausted unknown bucket
  const knownLogin = await login(db, DEFAULT_ENV, { username: 'knownuser', password: 'KnownPassword123!' });
  assert.equal(knownLogin.status, 'success');
  assert.equal(knownLogin.user.username, 'knownuser');
});

test('auth: username variants share the same throttle bucket', async () => {
  const db = createTestDb();
  await seedUser(db, {
    username: 'petugas',
    password: 'PetugasPassword1!',
  });

  // 2 failed attempts on 'Petugas'
  for (let i = 0; i < 2; i += 1) {
    await assert.rejects(
      async () => login(db, DEFAULT_ENV, { username: 'Petugas', password: 'Wrong' }),
      (err) => err.code === 'INVALID_CREDENTIALS',
    );
  }

  // 3 failed attempts on 'petugas'
  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(
      async () => login(db, DEFAULT_ENV, { username: 'petugas', password: 'Wrong' }),
      (err) => err.code === 'INVALID_CREDENTIALS',
    );
  }

  // 6th attempt on 'PETUGAS' with correct password must be blocked
  await assert.rejects(
    async () => login(db, DEFAULT_ENV, { username: 'PETUGAS', password: 'PetugasPassword1!' }),
    (err) => err.code === 'INVALID_CREDENTIALS',
  );
});

test('auth: successful login clears throttle counter', async () => {
  const db = createTestDb();
  await seedUser(db, {
    username: 'resetme',
    password: 'PasswordReset123!',
  });

  // 4 failed attempts
  for (let i = 0; i < 4; i += 1) {
    await assert.rejects(
      async () => login(db, DEFAULT_ENV, { username: 'resetme', password: 'Wrong' }),
      (err) => err.code === 'INVALID_CREDENTIALS',
    );
  }

  // 5th attempt succeeds with correct password -> clears throttle
  const success = await login(db, DEFAULT_ENV, { username: 'resetme', password: 'PasswordReset123!' });
  assert.equal(success.status, 'success');

  // Can fail 5 more times before getting blocked on the 6th
  for (let i = 0; i < 5; i += 1) {
    await assert.rejects(
      async () => login(db, DEFAULT_ENV, { username: 'resetme', password: 'WrongAgain' }),
      (err) => err.code === 'INVALID_CREDENTIALS',
    );
  }

  // 6th is blocked
  await assert.rejects(
    async () => login(db, DEFAULT_ENV, { username: 'resetme', password: 'PasswordReset123!' }),
    (err) => err.code === 'INVALID_CREDENTIALS',
  );
});

test('auth: throttle window expiry resets attempt counter', async () => {
  const db = createTestDb();
  await seedUser(db, {
    username: 'timetravel',
    password: 'TimePassword123!',
  });

  const t0 = 1700000000000;

  // 5 failures at t0
  for (let i = 0; i < 5; i += 1) {
    await assert.rejects(
      async () => login(db, DEFAULT_ENV, { username: 'timetravel', password: 'Wrong' }, t0),
      (err) => err.code === 'INVALID_CREDENTIALS',
    );
  }

  // Blocked at t0 + 1000
  await assert.rejects(
    async () => login(db, DEFAULT_ENV, { username: 'timetravel', password: 'TimePassword123!' }, t0 + 1000),
    (err) => err.code === 'INVALID_CREDENTIALS',
  );

  // Allowed after THROTTLE_WINDOW_MS has passed (5 minutes)
  const tAfterWindow = t0 + THROTTLE_WINDOW_MS + 1000;
  const res = await login(db, DEFAULT_ENV, { username: 'timetravel', password: 'TimePassword123!' }, tAfterWindow);
  assert.equal(res.status, 'success');
});

test('auth: unknown user, wrong password, and throttled return byte-identical errorCode and message', async () => {
  const db = createTestDb();
  await seedUser(db, {
    username: 'targetuser',
    password: 'TargetPassword123!',
  });

  let errUnknown;
  try {
    await login(db, DEFAULT_ENV, { username: 'does_not_exist', password: 'any' });
  } catch (err) {
    errUnknown = err;
  }

  let errWrongPass;
  try {
    await login(db, DEFAULT_ENV, { username: 'targetuser', password: 'WrongPassword' });
  } catch (err) {
    errWrongPass = err;
  }

  // Exhaust target user throttle
  for (let i = 0; i < 4; i += 1) {
    try {
      await login(db, DEFAULT_ENV, { username: 'targetuser', password: 'WrongPassword' });
    } catch {
      // ignore
    }
  }

  let errThrottled;
  try {
    await login(db, DEFAULT_ENV, { username: 'targetuser', password: 'TargetPassword123!' });
  } catch (err) {
    errThrottled = err;
  }

  assert.ok(errUnknown && errWrongPass && errThrottled);
  assert.equal(errUnknown.code, 'INVALID_CREDENTIALS');
  assert.equal(errWrongPass.code, 'INVALID_CREDENTIALS');
  assert.equal(errThrottled.code, 'INVALID_CREDENTIALS');

  assert.equal(errUnknown.message, AUTH_MESSAGES.INVALID_CREDENTIALS);
  assert.equal(errWrongPass.message, AUTH_MESSAGES.INVALID_CREDENTIALS);
  assert.equal(errThrottled.message, AUTH_MESSAGES.INVALID_CREDENTIALS);
});

test('auth: throttled, unknown-user, and wrong-password paths each run exactly one password derivation', async () => {
  const pbkdf2Env = { PASSWORD_PEPPER: PEPPER, PASSWORD_HASH_ALGO: 'pbkdf2_sha256', PBKDF2_ITERATIONS: 1000 };
  const db = createTestDb();
  await seedUser(db, { username: 'timing', hash: await hashPassword('TimingPass123!', pbkdf2Env) });
  const attempt = (username, password) => login(db, pbkdf2Env, { username, password });
  const isInvalid = (err) => err.code === 'INVALID_CREDENTIALS' && err.message === AUTH_MESSAGES.INVALID_CREDENTIALS;

  const wrongPassword = await countSubtle('deriveBits', () => assert.rejects(attempt('timing', 'Wrong!'), isInvalid));
  const unknownUser = await countSubtle('deriveBits', () => assert.rejects(attempt('nobody', 'Wrong!'), isInvalid));
  for (let i = 0; i < THROTTLE_MAX_ATTEMPTS - 1; i += 1) await assert.rejects(attempt('timing', 'Wrong!'), isInvalid);
  // Percobaan ke-6 ditolak throttle walau password benar, tetapi derivasi tetap berjalan.
  const throttled = await countSubtle('deriveBits', () => assert.rejects(attempt('timing', 'TimingPass123!'), isInvalid));

  assert.deepEqual({ wrongPassword, unknownUser, throttled }, { wrongPassword: 1, unknownUser: 1, throttled: 1 });

  // Algoritme sha256 (default): jumlah digest identik di ketiga jalur (throttle key + verifikasi).
  const shaDb = createTestDb();
  await seedUser(shaDb, { username: 'timing', password: 'TimingPass123!' });
  const shaAttempt = (username, password) => login(shaDb, DEFAULT_ENV, { username, password });
  const shaWrong = await countSubtle('digest', () => assert.rejects(shaAttempt('timing', 'Wrong!'), isInvalid));
  const shaUnknown = await countSubtle('digest', () => assert.rejects(shaAttempt('nobody', 'Wrong!'), isInvalid));
  for (let i = 0; i < THROTTLE_MAX_ATTEMPTS - 1; i += 1) await assert.rejects(shaAttempt('timing', 'Wrong!'), isInvalid);
  const shaThrottled = await countSubtle('digest', () => assert.rejects(shaAttempt('timing', 'TimingPass123!'), isInvalid));
  assert.equal(shaWrong, 2);
  assert.equal(shaUnknown, shaWrong);
  assert.equal(shaThrottled, shaWrong);
});

test('auth: missing PASSWORD_PEPPER → CONFIG_ERROR for known and unknown users alike, before any query', async () => {
  const db = createTestDb();
  await seedUser(db, { username: 'known', password: 'KnownPassword123!' });
  const noQueries = {
    prepare() {
      throw new Error('no D1 query may run when PASSWORD_PEPPER is missing');
    },
    batch() {
      throw new Error('no D1 batch may run when PASSWORD_PEPPER is missing');
    },
  };

  for (const env of [{}, { PASSWORD_PEPPER: '' }, { PASSWORD_HASH_ALGO: 'pbkdf2_sha256' }, null]) {
    const errors = [];
    for (const [username, password] of [['known', 'KnownPassword123!'], ['known', 'Wrong!'], ['ghost', 'Whatever1!']]) {
      errors.push(await login(noQueries, env, { username, password }).then(() => null, (e) => e));
      errors.push(await login(db, env, { username, password }).then(() => null, (e) => e));
    }
    for (const error of errors) {
      assert.ok(error);
      assert.equal(error.code, 'CONFIG_ERROR');
      assert.equal(error.message, AUTH_MESSAGES.PEPPER_MISSING_VERIFY);
    }
  }
  // PASSWORD_HASH_ALGO tidak dikenal juga CONFIG_ERROR identik untuk akun dikenal dan tidak dikenal.
  const badAlgo = { PASSWORD_PEPPER: PEPPER, PASSWORD_HASH_ALGO: 'md5' };
  const algoErrors = [
    await login(db, badAlgo, { username: 'known', password: 'KnownPassword123!' }).then(() => null, (e) => e),
    await login(db, badAlgo, { username: 'ghost', password: 'Whatever1!' }).then(() => null, (e) => e),
  ];
  assert.equal(algoErrors[0].code, 'CONFIG_ERROR');
  assert.deepEqual([algoErrors[1].code, algoErrors[1].message], [algoErrors[0].code, algoErrors[0].message]);
  // Throttle tidak dikonsumsi sama sekali.
  assert.equal((await first(db, 'SELECT COUNT(*) AS n FROM login_throttle')).n, 0);
  // Input kosong tetap INVALID_CREDENTIALS (validasi input lebih dulu).
  await assert.rejects(login(noQueries, {}, { username: '', password: 'x' }), (err) => err.code === 'INVALID_CREDENTIALS');
});

test('auth: throttle upsert error is fail-closed → INVALID_CREDENTIALS even with the correct password', async () => {
  const db = createTestDb();
  await seedUser(db, { username: 'failclosed', password: 'FailClosed123!' });
  const broken = failing(db, 'D1_ERROR: Network connection lost.', /INSERT INTO login_throttle/);
  await assert.rejects(
    login(broken, DEFAULT_ENV, { username: 'failclosed', password: 'FailClosed123!' }),
    (err) => err.code === 'INVALID_CREDENTIALS' && err.message === AUTH_MESSAGES.INVALID_CREDENTIALS,
  );
  assert.equal((await first(db, 'SELECT COUNT(*) AS n FROM sessions')).n, 0);
});

test('auth: user lookup error consumes the unknown bucket; INVALID_CREDENTIALS once the bucket is full', async () => {
  const db = createTestDb();
  await seedUser(db, { username: 'lookup', password: 'LookupPass123!' });
  const broken = failing(db, 'D1_ERROR: Network connection lost.', /FROM users WHERE username/);
  const t0 = 1700000000000;

  for (let i = 0; i < THROTTLE_MAX_ATTEMPTS; i += 1) {
    await assert.rejects(login(broken, DEFAULT_ENV, { username: 'lookup', password: 'LookupPass123!' }, t0), (err) => {
      assert.equal(err.code, 'DATA_SERVICE_UNAVAILABLE');
      assert.doesNotMatch(err.message, /D1_ERROR|Network connection lost/);
      return true;
    });
  }
  const bucket = await first(db, 'SELECT count FROM login_throttle');
  assert.equal(bucket.count, THROTTLE_MAX_ATTEMPTS);

  await assert.rejects(
    login(broken, DEFAULT_ENV, { username: 'lookup', password: 'LookupPass123!' }, t0 + 1000),
    (err) => err.code === 'INVALID_CREDENTIALS' && err.message === AUTH_MESSAGES.INVALID_CREDENTIALS,
  );
  // Bucket yang sama dipakai username tidak dikenal; akun yang dikenal tetap bisa login lewat DB sehat.
  await assert.rejects(
    login(db, DEFAULT_ENV, { username: 'ghost', password: 'x' }, t0 + 2000),
    (err) => err.code === 'INVALID_CREDENTIALS',
  );
  const ok = await login(db, DEFAULT_ENV, { username: 'lookup', password: 'LookupPass123!' }, t0 + 3000);
  assert.equal(ok.status, 'success');
});

test('auth: rehash compare-and-swap loses to a concurrent password reset (new hash untouched)', async () => {
  const db = createTestDb();
  const legacyHash = legacyHashReference('0123456789abcdef0123456789abcdef', 'OldPassword123!', PEPPER);
  const user = await seedUser(db, { username: 'racer', hash: legacyHash });
  const rehashEnv = {
    PASSWORD_PEPPER: PEPPER,
    PASSWORD_HASH_ALGO: 'pbkdf2_sha256',
    PBKDF2_ITERATIONS: 1000,
    PASSWORD_REHASH_ON_LOGIN: 'true',
  };
  const resetHash = await hashPassword('ResetByAdmin123!', DEFAULT_ENV);

  // Reset admin terjadi di antara SELECT user dan batch login (mensimulasikan users.resetPassword).
  let batchStatements = 0;
  const racing = {
    prepare: (sql) => db.prepare(sql),
    async batch(stmts) {
      batchStatements = stmts.length;
      db.sqlite
        .prepare('UPDATE users SET password_hash = ?, session_version = session_version + 1, version = version + 1 WHERE id = ?')
        .run(resetHash, user.id);
      return db.batch(stmts);
    },
  };

  const res = await login(racing, rehashEnv, { username: 'racer', password: 'OldPassword123!' });
  assert.equal(res.status, 'success');
  assert.equal(batchStatements, 5, 'rehash UPDATE was part of the batch');

  const stored = await first(db, 'SELECT password_hash, session_version FROM users WHERE id = ?1', user.id);
  assert.equal(stored.password_hash, resetHash, 'reset hash must not be overwritten by the rehash');
  assert.equal(stored.session_version, 2);
  // Sesi dari login yang kalah balapan memakai session_version lama sehingga langsung basi.
  await assert.rejects(
    requireSession(db, res.sessionToken),
    (err) => err.code === 'AUTH_REQUIRED' && err.message === AUTH_MESSAGES.SESSION_STALE,
  );
  assert.equal(await verifyPassword('ResetByAdmin123!', stored.password_hash, rehashEnv), true);
  assert.equal(await verifyPassword('OldPassword123!', stored.password_hash, rehashEnv), false);
});

// ─── 4. Logout & getSession Tests ───────────────────────────────────────────

test('auth: logout revokes session and is idempotent', async () => {
  const db = createTestDb();
  await seedUser(db, { username: 'logoutuser', password: 'Password123!' });

  const { sessionToken } = await login(db, DEFAULT_ENV, { username: 'logoutuser', password: 'Password123!' });

  // First logout revokes
  const res1 = await logout(db, sessionToken);
  assert.deepEqual(res1, { status: 'success' });

  // Session is now revoked
  await assert.rejects(
    async () => requireSession(db, sessionToken),
    (err) => err.code === 'AUTH_REQUIRED',
  );

  // Second logout is idempotent
  const res2 = await logout(db, sessionToken);
  assert.deepEqual(res2, { status: 'success' });

  // Logout with malformed token is idempotent and does not throw
  const res3 = await logout(db, 'malformed-token');
  assert.deepEqual(res3, { status: 'success' });
});

test('auth: getSession shape and deep scan for leaks', async () => {
  const db = createTestDb();
  await seedUser(db, {
    username: 'sessionuser',
    namaLengkap: 'Pengguna Sesi',
    role: 'pengelola',
  });

  const { sessionToken } = await login(db, DEFAULT_ENV, { username: 'sessionuser', password: 'Password123!' });

  const sess = await getSession(db, sessionToken);
  assert.deepEqual(sess, {
    status: 'success',
    user: {
      username: 'sessionuser',
      namaLengkap: 'Pengguna Sesi',
      hakAkses: 'pengelola',
    },
  });

  assertNoPasswordOrHash(sess);
});

test('auth: opportunistic rehash on login when PASSWORD_REHASH_ON_LOGIN is true', async () => {
  const db = createTestDb();
  const legacyHash = legacyHashReference('0123456789abcdef0123456789abcdef', 'RehashPass123!', PEPPER);
  const user = await seedUser(db, {
    username: 'rehashuser',
    hash: legacyHash,
  });

  const rehashEnv = {
    PASSWORD_PEPPER: PEPPER,
    PASSWORD_HASH_ALGO: 'pbkdf2_sha256',
    PBKDF2_ITERATIONS: 1000,
    PASSWORD_REHASH_ON_LOGIN: 'true',
  };

  const loginRes = await login(db, rehashEnv, { username: 'rehashuser', password: 'RehashPass123!' });
  assert.equal(loginRes.status, 'success');

  // Verify the hash in users table was updated to pbkdf2_sha256
  const updatedUser = await first(db, 'SELECT password_hash FROM users WHERE id = ?1', user.id);
  assert.match(updatedUser.password_hash, /^pbkdf2_sha256\$1000\$/);

  // Can now log in with the new hash
  const loginAgain = await login(db, rehashEnv, { username: 'rehashuser', password: 'RehashPass123!' });
  assert.equal(loginAgain.status, 'success');
});
