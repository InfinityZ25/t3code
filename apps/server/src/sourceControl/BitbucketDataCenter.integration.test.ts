import { assert, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as BitbucketApi from "./BitbucketApi.ts";
import * as BitbucketPullRequestApi from "../pullRequest/BitbucketPullRequestApi.ts";
import * as BitbucketSourceControlProvider from "./BitbucketSourceControlProvider.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

const base = "https://git.company.test:8443/bitbucket";
const repository = {
  slug: "app",
  project: { key: "PROJ" },
  links: {
    self: [{ href: `${base}/projects/PROJ/repos/app/browse` }],
    clone: [
      { name: "http", href: `${base}/scm/proj/app.git` },
      { name: "ssh", href: "ssh://git@git.company.test:7999/PROJ/app.git" },
    ],
  },
};
const pr = {
  id: 42,
  version: 7,
  title: "Add support",
  description: "A change",
  state: "OPEN",
  createdDate: 1700000000000,
  updatedDate: 1700000001000,
  author: { user: { name: "author", slug: "author", displayName: "Author" } },
  reviewers: [{ user: { name: "alice", slug: "alice", displayName: "Alice" }, status: "APPROVED" }],
  fromRef: {
    id: "refs/heads/feature",
    displayId: "feature",
    latestCommit: "abc123def",
    repository,
  },
  toRef: { id: "refs/heads/main", displayId: "main", latestCommit: "def456abc", repository },
  links: { self: [{ href: `${base}/projects/PROJ/repos/app/pull-requests/42` }] },
};
const target = { repository: "PROJ/app", number: 42 };
const context = {
  provider: { kind: "bitbucket" as const, name: "Bitbucket Data Center", baseUrl: base },
  remoteName: "origin",
  remoteUrl: `${base}/scm/proj/app.git`,
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "x-ausername": "bob" },
  });
const page = (values: ReadonlyArray<unknown>, nextPageStart?: number) => ({
  values,
  isLastPage: nextPageStart === undefined,
  ...(nextPageStart === undefined ? {} : { nextPageStart }),
});
function body(request: HttpClientRequest.HttpClientRequest) {
  if (request.body._tag !== "Uint8Array") throw new Error("Expected a JSON request body");
  return JSON.parse(new TextDecoder().decode(request.body.body));
}
function setup(
  response: (request: HttpClientRequest.HttpClientRequest) => Response,
  serverUrl = base,
) {
  const execute = vi.fn((request: HttpClientRequest.HttpClientRequest) =>
    Effect.sync(() => HttpClientResponse.fromWeb(request, response(request))),
  );
  const git = {
    listLocalBranchNames: vi.fn(() => Effect.succeed([])),
    readConfigValue: vi.fn(() => Effect.succeed(`${base}/scm/proj/app.git`)),
    ensureRemote: vi.fn(() => Effect.succeed("source")),
    fetchRemoteBranch: vi.fn(() => Effect.void),
    fetchRemoteTrackingBranch: vi.fn(() => Effect.void),
    setBranchUpstream: vi.fn(() => Effect.void),
    switchRef: vi.fn(() => Effect.succeed({ refName: "feature" })),
  };
  const source = BitbucketApi.layer.pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => execute(request)),
      ),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)(git)),
    Layer.provide(Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({})),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: {
            T3CODE_BITBUCKET_SERVER_URL: serverUrl,
            T3CODE_BITBUCKET_ACCESS_TOKEN: "test-pat",
          },
        }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  return { execute, git, layer: BitbucketPullRequestApi.layer.pipe(Layer.provideMerge(source)) };
}

it.effect(
  "resolves 9.4 HTTP and SSH clone links on a company host with a port and context path",
  () => {
    const test = setup((request) => {
      assert.strictEqual(request.url, `${base}/rest/api/1.0/projects/PROJ/repos/app`);
      assert.strictEqual(request.headers.authorization, "Bearer test-pat");
      return json(repository);
    });
    return Effect.gen(function* () {
      const api = yield* BitbucketApi.BitbucketApi;
      const urls = yield* api.getRepositoryCloneUrls({
        cwd: "/repo",
        repository: `${base}/projects/PROJ/repos/app/browse`,
      });
      assert.deepStrictEqual(urls, {
        nameWithOwner: "PROJ/app",
        url: `${base}/scm/proj/app.git`,
        sshUrl: "ssh://git@git.company.test:7999/PROJ/app.git",
      });
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect("reads the default branch and normalizes Data Center PR timestamps and refs", () => {
  const test = setup((request) =>
    request.url.endsWith("/branches/default") ? json({ displayId: "develop" }) : json(pr),
  );
  return Effect.gen(function* () {
    const api = yield* BitbucketApi.BitbucketApi;
    assert.strictEqual(yield* api.getDefaultBranch({ cwd: "/repo", context }), "develop");
    const summary = yield* api.getPullRequest({ cwd: "/repo", context, reference: "#42" });
    assert.strictEqual(summary.url, pr.links.self[0]?.href);
    assert.strictEqual(summary.headRefName, "feature");
    assert.strictEqual(summary.state, "open");
    assert.ok(Option.isSome(summary.updatedAt));
  }).pipe(Effect.provide(test.layer));
});

it.effect(
  "finds a source branch after an unrelated page and honors the server's next offset",
  () => {
    const test = setup((request) => {
      const params = new URL(request.url).searchParams;
      assert.strictEqual(params.get("at"), null);
      return json(
        params.get("start") === "0"
          ? page([{ ...pr, fromRef: { ...pr.fromRef, displayId: "other" } }], 37)
          : page([pr]),
      );
    });
    return Effect.gen(function* () {
      const api = yield* BitbucketApi.BitbucketApi;
      const result = yield* api.listPullRequests({
        cwd: "/repo",
        context,
        headSelector: "feature",
        state: "open",
      });
      assert.strictEqual(result.length, 1);
      assert.strictEqual(test.execute.mock.calls.length, 2);
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect(
  "creates a pull request using native branch refs, including a personal-project fork",
  () => {
    const test = setup((request) => {
      assert.strictEqual(request.method, "POST");
      assert.strictEqual(request.url, `${base}/rest/api/1.0/projects/proj/repos/app/pull-requests`);
      assert.deepStrictEqual(body(request), {
        title: "A change",
        description: "Description",
        fromRef: {
          id: "refs/heads/feature",
          repository: { slug: "fork", project: { key: "~bob" } },
        },
        toRef: { id: "refs/heads/main", repository: { slug: "app", project: { key: "proj" } } },
      });
      return json(pr, 201);
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* fs.makeTempFileScoped();
        yield* fs.writeFileString(path, "Description");
        const api = yield* BitbucketApi.BitbucketApi;
        yield* api.createPullRequest({
          cwd: "/repo",
          context,
          headSelector: "feature",
          source: { refName: "feature", owner: "~bob", repository: "fork" },
          baseBranch: "main",
          title: "A change",
          bodyFile: path,
        });
      }),
    ).pipe(Effect.provide(test.layer));
  },
);

it.effect("publishes a private repository into an existing Data Center project", () => {
  const test = setup((request) => {
    assert.strictEqual(request.method, "POST");
    assert.strictEqual(request.url, `${base}/rest/api/1.0/projects/PROJ/repos`);
    assert.deepStrictEqual(body(request), { name: "app", scmId: "git", public: false });
    return json(repository, 201);
  });
  return Effect.gen(function* () {
    const api = yield* BitbucketApi.BitbucketApi;
    assert.strictEqual(
      (yield* api.createRepository({ cwd: "/repo", repository: "PROJ/app", visibility: "private" }))
        .nameWithOwner,
      "PROJ/app",
    );
  }).pipe(Effect.provide(test.layer));
});

it.effect("checks out a fork using the source repository's native SSH clone URL", () => {
  const test = setup((request) =>
    request.url.endsWith("/pull-requests/42")
      ? json({
          ...pr,
          fromRef: { ...pr.fromRef, repository: { ...repository, project: { key: "~bob" } } },
        })
      : json(repository),
  );
  return Effect.gen(function* () {
    const api = yield* BitbucketApi.BitbucketApi;
    yield* api.checkoutPullRequest({
      cwd: "/repo",
      context: { ...context, remoteUrl: "ssh://git@git.company.test:7999/PROJ/app.git" },
      reference: "42",
    });
    assert.deepStrictEqual(test.git.fetchRemoteBranch.mock.calls[0], [
      {
        cwd: "/repo",
        remoteName: "source",
        remoteBranch: "feature",
        localBranch: "t3code/pr-42/feature",
      },
    ]);
    assert.strictEqual(test.git.ensureRemote.mock.calls.length, 1);
  }).pipe(Effect.provide(test.layer));
});

it.effect(
  "uses native state and search filters and avoids an invalid updated-date listing cursor",
  () => {
    const test = setup((request) => {
      assert.strictEqual(
        new URL(request.url).pathname,
        "/bitbucket/rest/api/1.0/projects/PROJ/repos/app/pull-requests",
      );
      const params = new URL(request.url).searchParams;
      assert.strictEqual(params.get("state"), "DECLINED");
      assert.strictEqual(params.get("filterText"), 'a "quote" & space');
      return json(page([{ ...pr, state: "DECLINED" }]));
    });
    return Effect.gen(function* () {
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;
      const result = yield* api.listPullRequests({
        ...target,
        state: "closed",
        query: 'a "quote" & space',
        limit: 20,
      });
      assert.strictEqual(result.items[0]?.state, "closed");
      assert.strictEqual(result.continues, false);
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect("reads a plain patch for a pull request and a selected commit", () => {
  const patch = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n";
  const test = setup((request) => {
    assert.strictEqual(request.headers.accept, "text/plain");
    return new Response(patch);
  });
  return Effect.gen(function* () {
    const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;
    assert.strictEqual((yield* api.getPullRequestDiff(target)).patch, patch);
    yield* api.getPullRequestDiff({ ...target, commit: "abc123def" });
    assert.strictEqual(
      test.execute.mock.calls[0]?.[0].url,
      `${base}/rest/api/1.0/projects/PROJ/repos/app/pull-requests/42.diff`,
    );
    assert.strictEqual(
      test.execute.mock.calls[1]?.[0].url,
      `${base}/rest/api/1.0/projects/PROJ/repos/app/commits/abc123def/diff`,
    );
    assert.deepStrictEqual(yield* api.getDiffStat(target), {
      additions: 1,
      deletions: 1,
      changedFiles: 1,
    });
  }).pipe(Effect.provide(test.layer));
});

it.effect("updates and merges with the current PR version and native squash strategy", () => {
  const test = setup((request) => (request.method === "GET" ? json(pr) : json(pr)));
  return Effect.gen(function* () {
    const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;
    yield* api.updateChangeRequest({ ...target, title: "New title" });
    yield* api.runAction({ ...target, action: "merge", mergeMethod: "squash" });
    const writes = test.execute.mock.calls
      .map(([request]) => request)
      .filter((request) => request.method !== "GET");
    assert.deepStrictEqual(body(writes[0]!), { version: 7, title: "New title" });
    assert.deepStrictEqual(body(writes[1]!), { version: 7, strategyId: "squash" });
    assert.strictEqual(new URL(writes[1]!.url).searchParams.get("version"), "7");
  }).pipe(Effect.provide(test.layer));
});

it.effect("does not retry a conflicted versioned merge", () => {
  const test = setup((request) =>
    request.method === "GET" ? json(pr) : json({ errors: [] }, 409),
  );
  return Effect.gen(function* () {
    const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;
    const error = yield* Effect.flip(api.runAction({ ...target, action: "merge" }));
    assert.strictEqual(error._tag, "BitbucketResponseError");
    assert.strictEqual(test.execute.mock.calls.length, 2);
  }).pipe(Effect.provide(test.layer));
});

it.effect("assembles anchored comments and nested replies from the activity stream", () => {
  const comment = {
    id: 10,
    version: 2,
    text: "Root",
    createdDate: 1700000000000,
    author: { name: "bob", slug: "bob" },
    threadResolved: true,
    comments: [{ id: 11, version: 0, text: "Reply", createdDate: 1700000001000 }],
  };
  const test = setup(() =>
    json(
      page([
        {
          id: 1,
          action: "COMMENTED",
          createdDate: 1700000000000,
          comment,
          commentAnchor: { path: { components: ["src", "app.ts"] }, line: 4, fileType: "FROM" },
        },
      ]),
    ),
  );
  return Effect.gen(function* () {
    const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;
    const result = yield* api.listComments(target);
    assert.strictEqual(result.comments.length, 2);
    assert.strictEqual(result.threads[0]?.path, "src/app.ts");
    assert.strictEqual(result.threads[0]?.side, "left");
    assert.strictEqual(result.threads[0]?.isResolved, true);
    assert.strictEqual(result.threads[0]?.comments.length, 2);
  }).pipe(Effect.provide(test.layer));
});

it.effect("resolves a thread using a versioned comment update", () => {
  const test = setup((request) =>
    request.method === "GET"
      ? json({ id: 10, version: 3, text: "Root", createdDate: 1700000000000 })
      : json({}),
  );
  return Effect.gen(function* () {
    const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;
    yield* api.setCommentResolution({ ...target, commentId: "10", resolved: true });
    const request = test.execute.mock.calls[1]?.[0];
    assert.ok(request);
    assert.strictEqual(request.method, "PUT");
    assert.deepStrictEqual(body(request), { version: 3, threadResolved: true });
  }).pipe(Effect.provide(test.layer));
});

it.effect("preserves existing reviewers when requesting another review", () => {
  const test = setup(() => json(pr));
  return Effect.gen(function* () {
    const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;
    yield* api.setReviewerRequest({ ...target, reviewers: [{ id: "bob" }], requested: true });
    assert.deepStrictEqual(body(test.execute.mock.calls[1]![0]), {
      version: 7,
      reviewers: [{ user: { name: "alice" } }, { user: { name: "bob" } }],
    });
  }).pipe(Effect.provide(test.layer));
});

it.effect("submits native inline comments before recording a changes-requested verdict", () => {
  const test = setup((request) =>
    new URL(request.url).pathname.endsWith("/repos")
      ? json(page([]))
      : new URL(request.url).pathname.endsWith("/users")
        ? json(page([{ name: "bob", slug: "bobby" }]))
        : request.method === "GET"
          ? json(pr)
          : json({}),
  );
  return Effect.gen(function* () {
    const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;
    yield* api.submitReview({
      ...target,
      verdict: "request-changes",
      body: "Please fix",
      comments: [{ path: "app.ts", body: "Check this", position: { kind: "deleted", oldLine: 3 } }],
    });
    const writes = test.execute.mock.calls
      .map(([request]) => request)
      .filter((request) => request.method !== "GET");
    assert.deepStrictEqual(body(writes[0]!), {
      text: "Check this",
      anchor: {
        diffType: "EFFECTIVE",
        path: "app.ts",
        line: 3,
        lineType: "REMOVED",
        fileType: "FROM",
      },
    });
    assert.strictEqual(
      writes[2]?.url,
      `${base}/rest/api/1.0/projects/PROJ/repos/app/pull-requests/42/participants/bobby`,
    );
    assert.deepStrictEqual(body(writes[2]!), {
      status: "NEEDS_WORK",
      lastReviewedCommit: "abc123def",
    });
  }).pipe(Effect.provide(test.layer));
});

it.effect("rejects non-advancing pages rather than looping", () => {
  const test = setup(() => json(page([pr], 0)));
  return Effect.gen(function* () {
    const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;
    const error = yield* Effect.flip(api.listPullRequests({ ...target, state: "open", limit: 20 }));
    assert.strictEqual(error._tag, "BitbucketPullRequestReadError");
    assert.strictEqual(test.execute.mock.calls.length, 1);
  }).pipe(Effect.provide(test.layer));
});

it.effect(
  "refines SSH remotes on the configured company host without a Bitbucket DNS label",
  () => {
    const test = setup(() => json({}));
    return Effect.gen(function* () {
      const discovery = yield* BitbucketSourceControlProvider.makeDiscovery;
      const result = yield* discovery.refineUnknownRemote!({
        cwd: "/repo",
        context: {
          ...context,
          remoteUrl: "ssh://git@git.company.test:7999/PROJ/app.git",
          provider: { kind: "unknown", name: "Unknown", baseUrl: "" },
        },
      });
      assert.strictEqual(result?.kind, "bitbucket");
      assert.strictEqual(result?.baseUrl, base);
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect("refuses a repository URL on another host before sending the token", () => {
  const test = setup(() => json(repository));
  return Effect.gen(function* () {
    const api = yield* BitbucketApi.BitbucketApi;
    const error = yield* Effect.flip(
      api.getRepositoryCloneUrls({
        cwd: "/repo",
        repository: "https://elsewhere.test/scm/PROJ/app.git",
      }),
    );
    assert.strictEqual(error._tag, "BitbucketUntrustedUrlError");
    assert.strictEqual(test.execute.mock.calls.length, 0);
  }).pipe(Effect.provide(test.layer));
});

it.effect("refuses redirects to another host without forwarding credentials", () => {
  const test = setup(
    () =>
      new Response(null, { status: 302, headers: { location: "https://elsewhere.test/patch" } }),
  );
  return Effect.gen(function* () {
    const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;
    const error = yield* Effect.flip(api.getPullRequestDiff(target));
    assert.strictEqual(error._tag, "BitbucketUntrustedUrlError");
    assert.strictEqual(test.execute.mock.calls.length, 1);
  }).pipe(Effect.provide(test.layer));
});

it.effect("rejects invalid Data Center configuration before sending credentials", () => {
  const test = setup(() => json({}), "https://user:password@git.company.test/bitbucket");
  return Effect.gen(function* () {
    const api = yield* BitbucketApi.BitbucketApi;
    const error = yield* Effect.flip(api.request({ method: "GET", url: "/rest/api/1.0/repos" }));
    assert.strictEqual(error._tag, "BitbucketServerUrlError");
    assert.strictEqual(test.execute.mock.calls.length, 0);
  }).pipe(Effect.provide(test.layer));
});

it.effect("applies saved server URLs and tokens without a restart and can return to Cloud", () => {
  const test = setup(() => json(page([])));
  return Effect.gen(function* () {
    const api = yield* BitbucketApi.BitbucketApi;
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* settings.updateSettings({
      bitbucket: { serverUrl: "https://another.company.test/git", accessToken: "replacement-pat" },
    });
    yield* api.request({ method: "GET", url: "/rest/api/1.0/repos" });
    assert.strictEqual(
      test.execute.mock.calls[0]?.[0].url,
      "https://another.company.test/git/rest/api/1.0/repos",
    );
    assert.strictEqual(
      test.execute.mock.calls[0]?.[0].headers.authorization,
      "Bearer replacement-pat",
    );
    yield* settings.updateSettings({ bitbucket: { serverUrl: "" } });
    assert.strictEqual(yield* api.getServerUrl, null);
    yield* api.request({ method: "GET", url: "/user" });
    assert.strictEqual(test.execute.mock.calls[1]?.[0].url, "https://api.bitbucket.org/2.0/user");
  }).pipe(Effect.provide(test.layer));
});

it.effect(
  "shares a parsed patch between revision and statistics reads and counts header-like added lines",
  () => {
    const patch =
      "diff --git a/a b/a\nindex 1234567..7654321 100644\n--- a/a\n+++ b/a\n@@ -1 +1,2 @@\n-old\n+++literal\n+new\n";
    const test = setup(() => new Response(patch));
    return Effect.gen(function* () {
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;
      assert.deepStrictEqual(yield* api.getDiffStat(target), {
        additions: 2,
        deletions: 1,
        changedFiles: 1,
      });
      const revisions = yield* api.getFileRevisions({ ...target, paths: ["a"] });
      assert.strictEqual(revisions.revisions.get("a"), "7654321");
      assert.strictEqual(test.execute.mock.calls.length, 1);
    }).pipe(Effect.provide(test.layer));
  },
);
