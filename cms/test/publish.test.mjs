import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fixture } from "./fixture.mjs";
import { Publisher } from "../publish.mjs";

test("deleting unpublished drafts skips build and retains the public snapshot", async () => {
  const { store } = await fixture();
  await writeFile(
    path.join(store.root, "src/content/posts/draft.md"),
    "---\ntitle: Draft\ndescription: Hidden\ndraft: true\npubDatetime: 2026-01-01\n---\nHidden"
  );
  let builds = 0;
  const publisher = new Publisher(store, async stage => {
    builds++;
    await mkdir(path.join(stage, "dist"), { recursive: true });
    await writeFile(path.join(stage, "dist/index.html"), "public snapshot");
  });
  await publisher.publish();
  const draft = await store.get("draft.md");
  await publisher.publish(draft.id, draft.revision, { remove: true });
  assert.equal(publisher.job.status, "success");
  assert.equal(builds, 1);
  assert.equal(
    await readFile(
      path.join(await store.sourceRoot(), "dist/index.html"),
      "utf8"
    ),
    "public snapshot"
  );
  await assert.rejects(store.get("draft.md"), { status: 404 });
  const privateDraft = await store.save({
    id: "private.md",
    title: "Private",
    description: "Hidden",
    body: "Private content",
  });
  await publisher.publish(privateDraft.id, privateDraft.revision, {
    remove: true,
  });
  assert.equal(publisher.job.status, "success");
  assert.equal(builds, 1);
  await assert.rejects(store.get("private.md"), { status: 404 });
  // An unpublished edit of a live article still requires a full rebuild.
  const edit = await store.save({
    ...(await store.get("hello.md")),
    body: "new draft body",
  });
  await publisher.publish(edit.id, edit.revision, { remove: true });
  assert.equal(builds, 2);
});

test("home introduction migrates into older releases, publishes and survives article publishing", async () => {
  const { store } = await fixture();
  const homeFile = path.join(store.root, "src/content/pages/home.md");
  await writeFile(
    homeFile,
    "---\ntitle: Welcome\ndescription: Intro\nsocials: []\n---\n\nOriginal introduction"
  );
  const publisher = new Publisher(store, async stage => {
    await mkdir(path.join(stage, "dist"), { recursive: true });
    await writeFile(path.join(stage, "dist/index.html"), "ok");
  });
  await publisher.publish();
  const { unlink } = await import("node:fs/promises");
  await unlink(
    path.join(await store.sourceRoot(), "src/content/pages/home.md")
  );
  const home = await store.get("home:page");
  assert.equal(home.kind, "page");
  const saved = await store.save({
    ...home,
    title: "My home",
    description: "",
    body: "New welcome",
    socials: [{ name: "github", url: "https://github.com/example" }],
  });
  assert.equal((await store.list()).length, 1);
  await assert.rejects(
    store.save({
      ...saved,
      socials: [{ name: "github", url: "javascript:alert(1)" }],
    }),
    { status: 400 }
  );
  await publisher.publish(saved.id, saved.revision);
  assert.equal(publisher.job.status, "success");
  await publisher.publish();
  const published = await store.get("home:page");
  assert.equal(published.body, "New welcome");
  assert.equal(published.socials[0].url, "https://github.com/example");
  await publisher.publish(published.id, published.revision, { remove: true });
  assert.equal(publisher.job.status, "failed");
});

test("deletion is atomic and failed deletion keeps article and draft", async () => {
  const { store } = await fixture();
  const draft = await store.save({
    ...(await store.get("hello.md")),
    body: "Draft edit",
  });
  const failed = new Publisher(store, async () => {
    throw new Error("failed");
  });
  await failed.publish(draft.id, draft.revision, { remove: true });
  assert.equal(failed.job.status, "failed");
  assert.equal((await store.get(draft.id)).body, "Draft edit");
  const publisher = new Publisher(store, async stage => {
    await mkdir(path.join(stage, "dist"), { recursive: true });
    await writeFile(path.join(stage, "dist/index.html"), "ok");
  });
  await publisher.publish(draft.id, draft.revision, { remove: true });
  assert.equal(publisher.job.status, "success");
  await assert.rejects(store.get(draft.id), e => e.status === 404);
  assert.equal((await store.list()).length, 0);
  // A leftover draft after a crash must not resurrect a deleted post.
  await writeFile(store.draftFile(draft.id), JSON.stringify(draft));
  assert.equal((await store.list()).length, 0);
  await publisher.publish();
  assert.equal((await store.list()).length, 0);
  const about = await store.get("about:page");
  await publisher.publish(about.id, about.revision, { remove: true });
  assert.equal(publisher.job.status, "failed");
  assert.equal((await store.get("about:page")).title, "关于");
});

test("about page drafts publish separately and survive later article releases", async () => {
  const { root, store } = await fixture();
  const about = await store.get("about:page");
  const draft = await store.save({
    ...about,
    body: "新的关于内容",
    description: "",
  });
  assert.match(
    await readFile(path.join(root, "src/content/pages/about.md"), "utf8"),
    /Original about/
  );
  assert.equal((await store.list()).length, 1);
  const publisher = new Publisher(store, async stage => {
    await mkdir(path.join(stage, "dist"), { recursive: true });
    await writeFile(path.join(stage, "dist/index.html"), "ok");
  });
  await publisher.publish(draft.id, draft.revision);
  assert.equal(publisher.job.status, "success");
  const published = await readFile(
    path.join(await store.sourceRoot(), "src/content/pages/about.md"),
    "utf8"
  );
  assert.match(published, /新的关于内容/);
  assert.doesNotMatch(published, /pubDatetime|tags:|draft:/);
  await publisher.publish();
  assert.equal((await store.get("about:page")).body, "新的关于内容");
});

test("failed build preserves current site and draft; successful build promotes snapshot", async () => {
  const { store } = await fixture();
  const original = await store.get("hello.md");
  const draft = await store.save({ ...original, title: "New title" });
  const failed = new Publisher(store, async () => {
    throw new Error("build failed");
  });
  await failed.publish(draft.id, draft.revision);
  assert.equal(failed.job.status, "failed");
  assert.equal(await store.current(), null);
  assert.equal((await store.get(draft.id)).revision, draft.revision);
  const publisher = new Publisher(store, async stage => {
    await mkdir(path.join(stage, "dist"), { recursive: true });
    await writeFile(path.join(stage, "dist/index.html"), "ok");
  });
  await publisher.publish(draft.id, draft.revision);
  assert.equal(publisher.job.status, "success");
  assert.match(
    await readFile(
      path.join(await store.sourceRoot(), "src/content/posts/hello.md"),
      "utf8"
    ),
    /New title/
  );
  assert.equal((await store.get(draft.id)).status, "published");
  // Simulate a crash after promotion but before draft cleanup.
  await writeFile(store.draftFile(draft.id), JSON.stringify(draft));
  assert.equal((await store.get(draft.id)).status, "published");
  await publisher.publish();
  assert.equal((await store.get(draft.id)).status, "published");
});

test("publishing blocks concurrent saves and other jobs", async () => {
  const { store } = await fixture();
  let release;
  const gate = new Promise(r => {
    release = r;
  });
  const publisher = new Publisher(store, async stage => {
    await gate;
    await mkdir(path.join(stage, "dist"));
    await writeFile(path.join(stage, "dist/index.html"), "ok");
  });
  const work = publisher.publish();
  await assert.rejects(store.save({ id: "new.md" }), /正在发布/);
  await assert.rejects(publisher.publish(), /正在发布/);
  release();
  await work;
  assert.equal(publisher.job.status, "success");
});
