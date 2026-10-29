import { test } from "node:test";
import assert from "node:assert/strict";
import * as OTPAuth from "otpauth";
import { fixture } from "./fixture.mjs";
import { Auth, initializeAdmin, resetTotp } from "../auth.mjs";
import { readFile } from "node:fs/promises";
import path from "node:path";

test("remembered devices survive restart, expire and can be revoked", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1800000000000 });
  const { store } = await fixture();
  await initializeAdmin(store.data, "a-long-test-password");
  let auth = new Auth(store.data);
  const session = await auth.login("a-long-test-password", undefined, true);
  const req = { headers: { cookie: `wenying_session=${session.token}` } };
  assert.equal(session.expires - Date.now(), 30 * 24 * 60 * 60 * 1000);
  const disk = await readFile(path.join(store.data, "sessions.json"), "utf8");
  assert.ok(!disk.includes(session.token));
  auth = new Auth(store.data);
  await auth.load();
  assert.equal(auth.get(req).csrf, session.csrf);
  await auth.logout(auth.get(req));
  auth = new Auth(store.data);
  await auth.load();
  assert.throws(() => auth.get(req), { status: 401 });
  const again = await auth.login("a-long-test-password", undefined, true);
  t.mock.timers.tick(30 * 24 * 60 * 60 * 1000);
  assert.throws(
    () => auth.get({ headers: { cookie: `wenying_session=${again.token}` } }),
    { status: 401 }
  );
});

test("password and authenticator resets revoke saved sessions; non-remembered sessions stay temporary", async () => {
  const { store } = await fixture();
  const password = "a-long-test-password";
  await initializeAdmin(store.data, password);
  let auth = new Auth(store.data);
  const temporary = await auth.login(password);
  auth = new Auth(store.data);
  await auth.load();
  assert.throws(
    () =>
      auth.get({ headers: { cookie: `wenying_session=${temporary.token}` } }),
    { status: 401 }
  );
  const remembered = await auth.login(password, undefined, true);
  await initializeAdmin(store.data, password);
  auth = new Auth(store.data);
  await auth.load();
  assert.throws(
    () =>
      auth.get({ headers: { cookie: `wenying_session=${remembered.token}` } }),
    { status: 401 }
  );
  const another = await auth.login(password, undefined, true);
  await resetTotp(store.data);
  auth = new Auth(store.data);
  await auth.load();
  assert.throws(
    () => auth.get({ headers: { cookie: `wenying_session=${another.token}` } }),
    { status: 401 }
  );
});

const password = "a-long-test-password";
test("TOTP enrollment, concurrent replay, persisted replay and password reset", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1800000000000 });
  const { store } = await fixture();
  await initializeAdmin(store.data, password);
  const auth = new Auth(store.data);
  const session = await auth.login(password, undefined, true);
  assert.deepEqual(await auth.status(), { enabled: false });
  await assert.rejects(auth.beginSetup(session, "bad"), { status: 400 });
  const setup = await auth.beginSetup(session, password);
  const otp = OTPAuth.URI.parse(setup.uri);
  await assert.rejects(auth.confirmSetup(session, "wrong"), { status: 400 });
  await auth.confirmSetup(session, otp.generate());
  assert.equal(auth.sessions.size, 0);
  const afterBinding = new Auth(store.data);
  await afterBinding.load();
  assert.throws(
    () =>
      afterBinding.get({
        headers: { cookie: `wenying_session=${session.token}` },
      }),
    { status: 401 }
  );
  assert.deepEqual(await auth.login(password), { requiresTotp: true });
  await assert.rejects(auth.login(password, otp.generate()), { status: 401 });
  t.mock.timers.tick(30000);
  const results = await Promise.allSettled([
    auth.login(password, otp.generate()),
    auth.login(password, otp.generate()),
  ]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const restarted = new Auth(store.data);
  await assert.rejects(restarted.login(password, otp.generate()), {
    status: 401,
  });
  await initializeAdmin(store.data, password);
  assert.deepEqual(await restarted.status(), { enabled: true });
  t.mock.timers.tick(30000);
  await assert.rejects(restarted.disable(password, "bad"), { status: 400 });
  await restarted.disable(password, otp.generate());
  assert.equal(restarted.sessions.size, 0);
  assert.ok((await restarted.login(password)).token);
});

test("setup expires and failed codes are rate limited", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1800000000000 });
  const { store } = await fixture();
  await initializeAdmin(store.data, password);
  const auth = new Auth(store.data);
  const session = await auth.login(password);
  const setup = await auth.beginSetup(session, password);
  t.mock.timers.tick(11 * 60000);
  await assert.rejects(
    auth.confirmSetup(session, OTPAuth.URI.parse(setup.uri).generate()),
    { status: 400 }
  );
  for (let i = 0; i < 10; i++) await auth.login("wrong").catch(() => {});
  await assert.rejects(auth.login(password), { status: 429 });
});

test("expired and future codes fail; offline reset retains password", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1800000000000 });
  const { store } = await fixture();
  await initializeAdmin(store.data, password);
  const auth = new Auth(store.data);
  const session = await auth.login(password);
  const setup = await auth.beginSetup(session, password);
  const otp = OTPAuth.URI.parse(setup.uri);
  await auth.confirmSetup(session, otp.generate());
  t.mock.timers.tick(120000);
  await assert.rejects(
    auth.login(password, otp.generate({ timestamp: Date.now() - 90000 })),
    { status: 401 }
  );
  await assert.rejects(
    auth.login(password, otp.generate({ timestamp: Date.now() + 90000 })),
    { status: 401 }
  );
  await assert.rejects(auth.beginSetup(session, password), { status: 401 });
  await resetTotp(store.data);
  const restarted = new Auth(store.data);
  assert.deepEqual(await restarted.status(), { enabled: false });
  assert.ok((await restarted.login(password)).token);
});
