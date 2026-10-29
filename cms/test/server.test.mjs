import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fixture.mjs";
import { createApp } from "../server.mjs";
import { initializeAdmin } from "../auth.mjs";
import { URI } from "otpauth";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

test("remember-device cookie restores authenticated access after server restart", async t => {
  const { store } = await fixture();
  await initializeAdmin(store.data, "a-long-test-password");
  let server;
  const start = async () => {
    server = await createApp({
      store,
      origin: "https://localhost",
      secure: true,
    });
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${server.address().port}/admin/api/`;
  };
  let base = await start();
  t.after(() => server.close());
  const login = await fetch(base + "login", {
    method: "POST",
    headers: {
      origin: "https://localhost",
      "content-type": "application/json",
    },
    body: JSON.stringify({ password: "a-long-test-password", remember: true }),
  });
  const setCookie = login.headers.get("set-cookie");
  assert.match(setCookie, /Max-Age=259199[89]|Max-Age=2592000/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  const cookie = setCookie.split(";")[0];
  const { csrf } = await login.json();
  await new Promise(r => server.close(r));
  base = await start();
  assert.equal(
    (await fetch(base + "posts", { headers: { cookie } })).status,
    200
  );
  assert.equal(
    (
      await fetch(base + "logout", {
        method: "POST",
        headers: { cookie, origin: "https://localhost", "x-csrf-token": csrf },
      })
    ).status,
    200
  );
  await new Promise(r => server.close(r));
  base = await start();
  assert.equal(
    (await fetch(base + "posts", { headers: { cookie } })).status,
    401
  );
});

test("hashed assets cache permanently while HTML revalidates and admin stays private", async t => {
  const { store } = await fixture();
  await initializeAdmin(store.data, "a-long-test-password");
  await mkdir(path.join(store.root, "dist/_astro"), { recursive: true });
  await writeFile(path.join(store.root, "dist/index.html"), "first page");
  await writeFile(path.join(store.root, "dist/_astro/app.hash.js"), "asset");
  const server = await createApp({
    store,
    origin: "http://localhost",
    secure: false,
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const asset = await fetch(base + "/_astro/app.hash.js");
  assert.equal(
    asset.headers.get("cache-control"),
    "public, max-age=31536000, immutable"
  );
  const html = await fetch(base + "/");
  assert.equal(html.headers.get("cache-control"), "no-cache");
  assert.ok(html.headers.get("etag"));
  assert.equal(
    (
      await fetch(base + "/", {
        headers: { "if-none-match": html.headers.get("etag") },
      })
    ).status,
    304
  );
  await writeFile(
    path.join(store.root, "dist/index.html"),
    "updated longer page"
  );
  const changed = await fetch(base + "/", {
    headers: { "if-none-match": html.headers.get("etag") },
  });
  assert.equal(changed.status, 200);
  assert.equal(await changed.text(), "updated longer page");
  assert.equal(
    (await fetch(base + "/admin/")).headers.get("cache-control"),
    "no-store"
  );
  assert.equal(
    (await fetch(base + "/admin/api/posts")).headers.get("cache-control"),
    "no-store"
  );
});

test("TOTP API requires CSRF and revokes sessions after binding", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1800000000000 });
  const { store } = await fixture();
  const password = "a-long-test-password";
  await initializeAdmin(store.data, password);
  const server = await createApp({
    store,
    origin: "http://localhost",
    secure: false,
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/admin/api/`;
  const headers = {
    "content-type": "application/json",
    origin: "http://localhost",
  };
  const post = (route, value) =>
    fetch(base + route, {
      method: "POST",
      headers,
      body: JSON.stringify(value),
    });
  const login = await post("login", { password });
  headers.cookie = login.headers.get("set-cookie").split(";")[0];
  const { csrf } = await login.json();
  assert.equal((await post("security/setup", { password })).status, 403);
  headers["x-csrf-token"] = csrf;
  const setupResponse = await post("security/setup", { password });
  assert.equal(setupResponse.status, 200);
  const setup = await setupResponse.json();
  const qr = await fetch(base + "security/qr", { headers });
  assert.match(await qr.text(), /<svg/);
  const otp = URI.parse(setup.uri);
  assert.equal(
    (await post("security/confirm", { code: otp.generate() })).status,
    200
  );
  assert.equal((await fetch(base + "posts", { headers })).status, 401);
  const challenge = await post("login", { password });
  assert.equal(challenge.headers.get("set-cookie"), null);
  assert.deepEqual(await challenge.json(), { requiresTotp: true });
  assert.equal((await post("login", { password, code: "bad" })).status, 401);
  t.mock.timers.tick(30000);
  const next = await post("login", { password, code: otp.generate() });
  assert.equal(next.status, 200);
  assert.ok(next.headers.get("set-cookie"));
});

test("authentication, same-origin writes, private files and session logout", async t => {
  const { store } = await fixture();
  await initializeAdmin(store.data, "a-long-test-password");
  const server = await createApp({
    store,
    origin: "http://localhost",
    secure: false,
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + "/admin/api/posts")).status, 401);
  assert.equal((await fetch(base + "/.cms/admin.json")).status, 404);
  const login = await fetch(base + "/admin/api/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify({ password: "a-long-test-password" }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const { csrf } = await login.json();
  assert.equal(
    (await fetch(base + "/admin/api/posts", { headers: { cookie } })).status,
    200
  );
  const headers = {
    cookie,
    "content-type": "application/json",
    origin: "https://evil.test",
    "x-csrf-token": csrf,
  };
  assert.equal(
    (
      await fetch(base + "/admin/api/preview", {
        method: "POST",
        headers,
        body: '{"body":"test"}',
      })
    ).status,
    403
  );
  headers.origin = "http://localhost";
  delete headers["x-csrf-token"];
  assert.equal(
    (
      await fetch(base + "/admin/api/preview", {
        method: "POST",
        headers,
        body: "{}",
      })
    ).status,
    403
  );
  headers["x-csrf-token"] = csrf;
  const p = await fetch(base + "/admin/api/preview", {
    method: "POST",
    headers,
    body: '{"body":"**hello**"}',
  });
  assert.match((await p.json()).html, /<strong>hello<\/strong>/);
  assert.equal(
    (
      await fetch(base + "/admin/api/logout", {
        method: "POST",
        headers,
        body: "{}",
      })
    ).status,
    200
  );
  assert.equal(
    (await fetch(base + "/admin/api/posts", { headers: { cookie } })).status,
    401
  );
});
