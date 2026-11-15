import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanupCheckout, runGit } from "./release-cleanup-checkout.mjs";

function git(root, args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return String(result.stdout || "").trim();
}

function createCheckout() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "s3sk-cleanup-"));
  const checkout = path.join(scratch, "checkout");
  const origin = path.join(scratch, "origin.git");
  const author = path.join(scratch, "author");
  fs.mkdirSync(checkout);
  git(checkout, ["-c", "init.templateDir=", "init", "-q", "-b", "main"]);
  git(checkout, ["config", "user.email", "test@example.com"]);
  git(checkout, ["config", "user.name", "test"]);
  fs.writeFileSync(path.join(checkout, "app.txt"), "one\n");
  fs.writeFileSync(path.join(checkout, ".gitignore"), "coverage/\n");
  git(checkout, ["add", "."]);
  git(checkout, ["commit", "-qm", "init"]);

  git(scratch, ["-c", "init.templateDir=", "init", "-q", "--bare", origin]);
  git(checkout, ["remote", "add", "origin", origin]);
  git(checkout, ["push", "-qu", "origin", "main"]);

  fs.mkdirSync(author);
  git(scratch, ["clone", "-q", "-b", "main", origin, author]);
  git(author, ["config", "user.email", "test@example.com"]);
  git(author, ["config", "user.name", "test"]);
  fs.writeFileSync(path.join(author, "app.txt"), "two\n");
  git(author, ["add", "."]);
  git(author, ["commit", "-qm", "advance"]);
  git(author, ["push", "-q", "origin", "main"]);

  return { scratch, checkout, origin };
}

function head(root) {
  return git(root, ["rev-parse", "HEAD"]);
}

function originHead(origin) {
  return git(origin, ["rev-parse", "refs/heads/main"]);
}

function trackedClean(root) {
  return (
    git(root, ["status", "--porcelain=v1", "--untracked-files=all"]) === ""
  );
}

test("release cleanup refuses a dirty checkout before stashing or merging", () => {
  const { scratch, checkout, origin } = createCheckout();
  try {
    fs.appendFileSync(path.join(checkout, "app.txt"), "local\n");
    const before = head(checkout);
    const calls = [];
    assert.throws(
      () =>
        cleanupCheckout({
          root: checkout,
          environment: {},
          git: (args, options) => {
            calls.push(args);
            return runGit(checkout, args, options);
          },
        }),
      /refuses a dirty checkout/,
    );
    assert.equal(head(checkout), before);
    assert.match(
      fs.readFileSync(path.join(checkout, "app.txt"), "utf8"),
      /local/,
    );
    assert.equal(
      calls.some((args) => args[0] === "stash"),
      false,
    );
    assert.equal(
      calls.some((args) => args[0] === "merge"),
      false,
    );
    assert.notEqual(head(checkout), originHead(origin));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("release cleanup stashes local work, then fast-forwards to upstream", () => {
  const { scratch, checkout, origin } = createCheckout();
  try {
    fs.appendFileSync(path.join(checkout, "app.txt"), "local\n");
    fs.writeFileSync(path.join(checkout, "untracked.txt"), "keep\n");
    const calls = [];
    cleanupCheckout({
      root: checkout,
      environment: { ALLOW_RELEASE_CLEANUP_STASH: "1" },
      git: (args, options) => {
        calls.push(args);
        return runGit(checkout, args, options);
      },
    });

    assert.equal(head(checkout), originHead(origin));
    assert.equal(trackedClean(checkout), true);
    assert.equal(fs.existsSync(path.join(checkout, "untracked.txt")), false);
    assert.match(git(checkout, ["stash", "list"]), /release-cleanup-backup-/);
    assert.equal(
      calls.some((args) => args[0] === "merge" && args.includes("--ff-only")),
      true,
    );
    for (const args of calls) {
      assert.notEqual(args[0], "reset", `unexpected destructive call: ${args}`);
      assert.notEqual(
        args[0],
        "checkout",
        `unexpected destructive call: ${args}`,
      );
      assert.equal(args.includes("--hard"), false);
      assert.notEqual(args[0], "clean");
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
