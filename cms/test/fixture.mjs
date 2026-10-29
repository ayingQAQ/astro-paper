import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ContentStore } from "../content.mjs";

export async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "wenying-test-"));
  await mkdir(path.join(root, "src/content/posts"), { recursive: true });
  await mkdir(path.join(root, "public"), { recursive: true });
  await mkdir(path.join(root, "src/content/pages"), { recursive: true });
  await writeFile(
    path.join(root, "src/content/pages/about.md"),
    "---\ntitle: 关于\ndescription: 关于我\n---\n\nOriginal about"
  );
  await writeFile(
    path.join(root, "src/content/posts/hello.md"),
    "---\ntitle: Hello\ndescription: Summary\npubDatetime: 2026-01-01T00:00:00Z\ncustom: keep-me\n---\n\nOriginal"
  );
  const store = new ContentStore(root, path.join(root, ".cms"));
  await store.init();
  return { root, store };
}
