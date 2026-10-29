import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { ContentStore, safeId, preview } from "../content.mjs";
import { fixture } from "./fixture.mjs";

test("draft is isolated, preserves metadata and rejects stale edits", async () => {
  const { root, store } = await fixture();
  const post = await store.get("hello.md");
  const saved = await store.save({ ...post, title: "修改", body: "New text" });
  assert.equal(saved.metadata.custom, "keep-me");
  assert.match(
    await readFile(path.join(root, "src/content/posts/hello.md"), "utf8"),
    /Original/
  );
  assert.equal((await store.list())[0].status, "modified");
  await assert.rejects(store.save({ ...post, body: "stale" }), /其他窗口/);
  assert.equal((await store.get("hello.md")).body, "New text");
});

test("paths and markdown preview are safe", () => {
  for (const id of [
    "../x.md",
    "/a.md",
    "a\\b.md",
    ".hidden.md",
    "a/../b.md",
    "a.txt",
  ])
    assert.throws(() => safeId(id));
  assert.equal(safeId("notes/你好.md"), "notes/你好.md");
  assert.equal(
    safeId("_color-schemes/example.mdx"),
    "_color-schemes/example.mdx"
  );
  const html = preview("<script>alert(1)</script>\n[x](javascript:alert(1))");
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes('href="javascript:'));
});

test("rejects invalid metadata and fake image content", async () => {
  const { store } = await fixture();
  await assert.rejects(
    store.save({
      id: "new.md",
      revision: null,
      title: "",
      description: "x",
      body: "test",
    })
  );
  await assert.rejects(store.upload(Buffer.from("<svg>bad</svg>")), /图片/);
});

test("existing underscore directories remain editable", async () => {
  const { root, store } = await fixture();
  await mkdir(path.join(root, "src/content/posts/_examples"));
  await writeFile(
    path.join(root, "src/content/posts/_examples/demo.mdx"),
    await readFile(path.join(root, "src/content/posts/hello.md"))
  );
  assert.equal((await store.list()).length, 2);
  assert.equal((await store.get("_examples/demo.mdx")).format, "mdx");
});

test("private storage cannot be configured inside public output", () => {
  assert.throws(
    () => new ContentStore("/project", "/project/public/admin-data"),
    /私有/
  );
  assert.throws(
    () => new ContentStore("/project", "/project/dist/data"),
    /私有/
  );
});
