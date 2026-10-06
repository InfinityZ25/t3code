import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Exit from "effect/Exit";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type {
  PullRequestComment,
  PullRequestReviewThread,
  PullRequestReviewPosition,
} from "@t3tools/contracts";

import * as BitbucketApi from "../sourceControl/BitbucketApi.ts";
import {
  encodeDataCenterBody,
  DataCenterPullRequest,
  DataCenterUser,
  dataCenterPage,
  dataCenterRepositoryPath,
  dataCenterPullRequest,
  dataCenterActor,
} from "../sourceControl/bitbucketDataCenter.ts";
import * as BitbucketPullRequestApi from "./BitbucketPullRequestApi.ts";
import { parseDiffFileRevisions } from "./bitbucketDiffRevisions.ts";

type Api = BitbucketPullRequestApi.BitbucketPullRequestApi["Service"];
type Target = { readonly repository: string; readonly number: number };
const MAX_PAGES = 10;
const PAGE_SIZE = 100;

const CommentFields = Schema.Struct({
  id: Schema.Int,
  version: Schema.Int,
  text: Schema.String,
  author: Schema.optional(DataCenterUser),
  createdDate: Schema.Number,
  updatedDate: Schema.optional(Schema.Number),
  state: Schema.optional(Schema.String),
  threadResolved: Schema.optional(Schema.Boolean),
  pending: Schema.optional(Schema.Boolean),
  anchor: Schema.optional(
    Schema.Struct({
      path: Schema.Union([
        Schema.String,
        Schema.Struct({
          components: Schema.Array(Schema.String),
        }),
      ]),
      line: Schema.optional(Schema.Int),
      fileType: Schema.optional(Schema.String),
      orphaned: Schema.optional(Schema.Boolean),
    }),
  ),
});
type Comment = typeof CommentFields.Type & {
  readonly comments?: ReadonlyArray<Comment> | undefined;
};
const CommentSchema: Schema.Codec<Comment, unknown> = Schema.Struct({
  ...CommentFields.fields,
  comments: Schema.optional(
    Schema.Array(Schema.suspend((): Schema.Codec<Comment, unknown> => CommentSchema)),
  ),
});
const Activity = Schema.Struct({
  id: Schema.Int,
  action: Schema.String,
  createdDate: Schema.Number,
  user: Schema.optional(DataCenterUser),
  comment: Schema.optional(CommentSchema),
  commentAnchor: Schema.optional(CommentFields.fields.anchor.schema),
});
const Commit = Schema.Struct({
  id: Schema.String,
  message: Schema.String,
  authorTimestamp: Schema.Number,
  author: Schema.Struct({ name: Schema.String }),
});
const Check = Schema.Struct({
  name: Schema.String,
  state: Schema.String,
  description: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
});

const decodeDiffKey = Schema.decodeSync(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String, Schema.Number])),
);

function diffStats(patch: string) {
  let additions = 0,
    deletions = 0,
    changedFiles = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      changedFiles++;
      inHunk = false;
    } else if (line.startsWith("@@ ")) inHunk = true;
    else if (inHunk && line.startsWith("+")) additions++;
    else if (inHunk && line.startsWith("-")) deletions++;
  }
  return { additions, deletions, changedFiles };
}

function reviewAnchor(position: PullRequestReviewPosition) {
  switch (position.kind) {
    case "added":
      return { line: position.newLine, lineType: "ADDED", fileType: "TO" };
    case "deleted":
      return { line: position.oldLine, lineType: "REMOVED", fileType: "FROM" };
    case "context":
      return {
        line: position.side === "left" ? position.oldLine : position.newLine,
        lineType: "CONTEXT",
        fileType: position.side === "left" ? "FROM" : "TO",
      };
  }
}

/** Data Center 9.4 uses native project paths and versioned writes, sharing only the HTTP transport with Cloud. */
export const make = Effect.gen(function* () {
  const bitbucket = yield* BitbucketApi.BitbucketApi;
  const read = <S extends Schema.Top>(
    url: string,
    schema: S,
  ): Effect.Effect<
    S["Type"],
    BitbucketPullRequestApi.BitbucketPullRequestApiError,
    S["DecodingServices"]
  > =>
    bitbucket.request({ method: "GET", url }).pipe(
      Effect.flatMap((response) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(response.body).pipe(
          Effect.mapError(
            (cause) =>
              new BitbucketPullRequestApi.BitbucketPullRequestReadError({
                operation: "dataCenterRead",
                cause,
              }),
          ),
        ),
      ),
    );

  const repoPath = (
    repository: string,
  ): Effect.Effect<string, BitbucketPullRequestApi.BitbucketRepositoryUnsupportedError> => {
    const [project, slug, ...rest] = repository.split("/");
    return project && slug && rest.length === 0
      ? Effect.succeed(dataCenterRepositoryPath(project, slug))
      : Effect.fail(
          new BitbucketPullRequestApi.BitbucketRepositoryUnsupportedError({ repository }),
        );
  };
  const prPath = (input: Target) =>
    repoPath(input.repository).pipe(Effect.map((path) => `${path}/pull-requests/${input.number}`));
  const getRaw = (input: Target) =>
    prPath(input).pipe(Effect.flatMap((path) => read(path, DataCenterPullRequest)));
  const write = (url: string, body: unknown, method: "POST" | "PUT" = "POST") =>
    bitbucket.request({ method, url, body: encodeDataCenterBody(body) }).pipe(Effect.asVoid);

  const pages = <S extends Schema.Top>(
    url: string,
    schema: S,
    limit = PAGE_SIZE * MAX_PAGES,
  ): Effect.Effect<
    { readonly values: ReadonlyArray<S["Type"]>; readonly truncated: boolean },
    BitbucketPullRequestApi.BitbucketPullRequestApiError,
    S["DecodingServices"]
  > =>
    Effect.gen(function* () {
      const values: S["Type"][] = [];
      let start = 0;
      for (let page = 0; page < MAX_PAGES; page++) {
        const separator = url.includes("?") ? "&" : "?";
        const response = yield* read(
          `${url}${separator}limit=${Math.min(PAGE_SIZE, Math.max(1, limit - values.length))}&start=${start}`,
          dataCenterPage(schema),
        );
        values.push(...response.values);
        if (response.isLastPage || values.length >= limit)
          return {
            values: values.slice(0, limit),
            truncated: !response.isLastPage || values.length > limit,
          };
        // Data Center's next offset need not equal start + size. Reject a stuck cursor.
        if (response.nextPageStart === undefined || response.nextPageStart <= start)
          return yield* new BitbucketPullRequestApi.BitbucketPullRequestReadError({
            operation: "pagination",
            cause: new Error("Non-advancing Data Center page"),
          });
        start = response.nextPageStart;
      }
      return { values, truncated: true };
    });

  const getViewer: Api["getViewer"] = () =>
    bitbucket
      .request({ method: "GET", url: "/rest/api/1.0/repos?limit=1" })
      .pipe(
        Effect.flatMap((response) =>
          response.account && response.account !== "anonymous"
            ? Effect.succeed(response.account)
            : Effect.fail(new BitbucketPullRequestApi.BitbucketViewerUnavailableError()),
        ),
      );
  const getPullRequestDiff: Api["getPullRequestDiff"] = (input) =>
    Effect.gen(function* () {
      if (input.commit && !/^[a-f0-9]{7,64}$/iu.test(input.commit))
        return yield* new BitbucketPullRequestApi.BitbucketDiffCommitError();
      const path = input.commit
        ? `${yield* repoPath(input.repository)}/commits/${input.commit}/diff`
        : `${yield* prPath(input)}.diff`;
      const response = yield* bitbucket.request({
        method: "GET",
        url: path,
        accept: "text/plain",
        maxBytes: 8 * 1024 * 1024,
      });
      return { patch: response.body, truncated: response.truncated };
    });
  // Share a parsed, bounded patch between file revision and statistics reads without holding
  // large patch bodies. Include the deployment URL so changing servers invalidates the key.
  const parsedDiffs = yield* Cache.makeWith(
    (key: string) => {
      const [, repository, number] = decodeDiffKey(key);
      return getPullRequestDiff({ repository, number }).pipe(
        Effect.map((diff) => ({
          revisions: parseDiffFileRevisions(diff.patch),
          stats: diffStats(diff.patch),
          truncated: diff.truncated,
        })),
      );
    },
    {
      capacity: 16,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.seconds(5) : Duration.zero),
    },
  );
  const parsedDiff = (input: Target) =>
    bitbucket.getServerUrl.pipe(
      Effect.flatMap((server) =>
        Cache.get(
          parsedDiffs,
          encodeDataCenterBody([server ?? "", input.repository, input.number]),
        ),
      ),
    );

  const updateComment = (
    input: Target & { readonly commentId: string },
    fields: { readonly text?: string; readonly threadResolved?: boolean },
  ) =>
    Effect.gen(function* () {
      const url = `${yield* prPath(input)}/comments/${encodeURIComponent(input.commentId)}`;
      const current = yield* read(url, CommentSchema);
      yield* write(url, { version: current.version, ...fields }, "PUT");
    });

  return {
    getViewer,
    listPullRequests: (input) =>
      Effect.gen(function* () {
        const path = yield* repoPath(input.repository);
        const params = new URLSearchParams({
          state:
            input.state === "all"
              ? "ALL"
              : input.state === "closed"
                ? "DECLINED"
                : input.state.toUpperCase(),
          order: "NEWEST",
          direction: "INCOMING",
          ...(input.query ? { filterText: input.query } : {}),
        });
        const batch = yield* pages(
          `${path}/pull-requests?${params}`,
          DataCenterPullRequest,
          input.limit,
        );
        return {
          items: batch.values.map(dataCenterPullRequest),
          truncated: batch.truncated,
          continues: false,
        };
      }),
    getPullRequest: (input) => getRaw(input).pipe(Effect.map(dataCenterPullRequest)),
    // The merge endpoint enforces REPO_WRITE and repository merge checks. A read token can still review.
    getRepositoryPermission: (input) =>
      Effect.gen(function* () {
        const path = yield* repoPath(input.repository);
        yield* read(path, Schema.Struct({ slug: Schema.String }));
        return true;
      }),
    getPullRequestDiff,
    getFileRevisions: (input) =>
      input.paths.length === 0
        ? Effect.succeed({ revisions: new Map<string, string>(), complete: false })
        : parsedDiff(input).pipe(
            Effect.map((diff) => {
              const revisions = new Map(diff.revisions);
              if (!diff.truncated)
                for (const path of input.paths) if (!revisions.has(path)) revisions.set(path, "");
              return { revisions, complete: !diff.truncated };
            }),
          ),
    getDiffStat: (input) => parsedDiff(input).pipe(Effect.map((diff) => diff.stats)),
    getMergeability: (input) =>
      prPath(input).pipe(
        Effect.flatMap((path) =>
          read(
            `${path}/merge`,
            Schema.Struct({ conflicted: Schema.Boolean, outcome: Schema.optional(Schema.String) }),
          ),
        ),
        Effect.map((merge) =>
          merge.conflicted ? ("conflicting" as const) : ("mergeable" as const),
        ),
      ),
    listComments: (input) =>
      Effect.gen(function* () {
        const batch = yield* pages(`${yield* prPath(input)}/activities`, Activity);
        const comments = new Map<string, PullRequestComment>();
        const threads = new Map<string, PullRequestReviewThread>();
        const visit = (comment: Comment, anchor: Comment["anchor"]): PullRequestComment[] => {
          if (comment.pending || comment.state === "PENDING") return [];
          const path = anchor
            ? typeof anchor.path === "string"
              ? anchor.path
              : anchor.path.components.join("/")
            : null;
          const item: PullRequestComment = {
            id: String(comment.id),
            kind: path ? "review-comment" : "issue-comment",
            body: comment.text,
            author: comment.author ? dataCenterActor(comment.author) : null,
            createdAt: DateTime.formatIso(DateTime.makeUnsafe(comment.createdDate)),
            url: null,
            path,
            reviewState: null,
          };
          comments.set(item.id, item);
          return [item, ...(comment.comments ?? []).flatMap((reply) => visit(reply, anchor))];
        };
        for (const activity of batch.values) {
          if (activity.comment) {
            const root = activity.comment;
            const anchor = activity.commentAnchor ?? root.anchor;
            const items = visit(root, anchor);
            const path = anchor
              ? typeof anchor.path === "string"
                ? anchor.path
                : anchor.path.components.join("/")
              : null;
            if (path && items.length)
              threads.set(String(root.id), {
                id: String(root.id),
                path,
                line: anchor?.line ?? null,
                side: anchor?.fileType === "FROM" ? "left" : "right",
                isResolved: root.threadResolved ?? root.state === "RESOLVED",
                isOutdated: anchor?.orphaned ?? false,
                comments: items.map(({ id, author, body, createdAt, url }) => ({
                  id,
                  author,
                  body,
                  createdAt,
                  url,
                })),
              });
          } else if (activity.user && ["APPROVED", "UNAPPROVED"].includes(activity.action)) {
            comments.set(`activity-${activity.id}`, {
              id: `activity-${activity.id}`,
              kind: "review",
              body: "",
              author: dataCenterActor(activity.user),
              createdAt: DateTime.formatIso(DateTime.makeUnsafe(activity.createdDate)),
              url: null,
              path: null,
              reviewState:
                activity.action === "APPROVED"
                  ? "approved"
                  : activity.action === "UNAPPROVED"
                    ? "commented"
                    : "changes_requested",
            });
          }
        }
        return {
          comments: [...comments.values()].toSorted((a, b) =>
            a.createdAt.localeCompare(b.createdAt),
          ),
          threads: [...threads.values()],
          truncated: batch.truncated,
        };
      }),
    listCommits: (input) =>
      Effect.gen(function* () {
        const batch = yield* pages(`${yield* prPath(input)}/commits`, Commit);
        return batch.values.toReversed().map((commit) => ({
          oid: commit.id,
          messageHeadline: commit.message.split("\n")[0] ?? "",
          committedDate: DateTime.formatIso(DateTime.makeUnsafe(commit.authorTimestamp)),
          authors: [{ login: commit.author.name, name: commit.author.name, avatarUrl: null }],
        }));
      }),
    listChecks: (input) =>
      Effect.gen(function* () {
        const pr = yield* getRaw(input);
        if (!pr.fromRef.latestCommit) return [];
        const batch = yield* pages(
          `/rest/build-status/1.0/commits/${encodeURIComponent(pr.fromRef.latestCommit)}`,
          Check,
        );
        return batch.values.map((check) => ({
          name: check.name,
          status:
            check.state === "SUCCESSFUL"
              ? ("success" as const)
              : check.state === "FAILED"
                ? ("failure" as const)
                : check.state === "INPROGRESS"
                  ? ("pending" as const)
                  : check.state === "CANCELLED"
                    ? ("cancelled" as const)
                    : ("neutral" as const),
          description: check.description ?? null,
          url: check.url ?? null,
        }));
      }),
    listReviewerCandidates: (input) =>
      Effect.gen(function* () {
        const pr = yield* getRaw(input);
        const [project, slug] = input.repository.split("/");
        const params = new URLSearchParams({
          permission: "REPO_READ",
          "permission.projectKey": project ?? "",
          "permission.repositorySlug": slug ?? "",
        });
        const batch = yield* pages(`/rest/api/1.0/users?${params}`, DataCenterUser, PAGE_SIZE);
        return {
          candidates: batch.values
            .filter((user) => user.name !== pr.author?.user.name)
            .map((user) => ({
              ...dataCenterActor(user),
              id: user.name,
              kind: "user" as const,
              isRequested: (pr.reviewers ?? []).some(
                (reviewer) => reviewer.user.name === user.name,
              ),
            })),
          truncated: batch.truncated,
        };
      }),
    setReviewerRequest: (input) =>
      Effect.gen(function* () {
        const pr = yield* getRaw(input);
        const names = new Set((pr.reviewers ?? []).map((reviewer) => reviewer.user.name));
        for (const reviewer of input.reviewers)
          if (input.requested) names.add(reviewer.id);
          else names.delete(reviewer.id);
        yield* write(
          yield* prPath(input),
          { version: pr.version, reviewers: [...names].map((name) => ({ user: { name } })) },
          "PUT",
        );
      }),
    runAction: (input) =>
      Effect.gen(function* () {
        const pr = yield* getRaw(input);
        const path = yield* prPath(input);
        if (input.action === "merge")
          yield* write(`${path}/merge?version=${pr.version}`, {
            version: pr.version,
            strategyId:
              input.mergeMethod === "squash"
                ? "squash"
                : input.mergeMethod === "rebase"
                  ? "rebase-no-ff"
                  : "no-ff",
          });
        else if (input.action === "close")
          yield* write(`${path}/decline?version=${pr.version}`, { version: pr.version });
        else
          return yield* new BitbucketPullRequestApi.BitbucketPullRequestReadError({
            operation: "runAction",
            cause: new Error("Unsupported action"),
          });
      }),
    updateChangeRequest: (input) =>
      Effect.gen(function* () {
        const current = yield* getRaw(input);
        yield* write(
          yield* prPath(input),
          {
            version: current.version,
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.body === undefined ? {} : { description: input.body }),
          },
          "PUT",
        );
      }),
    comment: (input) =>
      prPath(input).pipe(Effect.flatMap((path) => write(`${path}/comments`, { text: input.body }))),
    updateComment: (input) => updateComment(input, { text: input.body }),
    replyToComment: (input) =>
      prPath(input).pipe(
        Effect.flatMap((path) =>
          write(`${path}/comments`, { text: input.body, parent: { id: Number(input.commentId) } }),
        ),
      ),
    setCommentResolution: (input) => updateComment(input, { threadResolved: input.resolved }),
    submitReview: (input) =>
      Effect.gen(function* () {
        const path = yield* prPath(input);
        for (const comment of input.comments)
          yield* write(`${path}/comments`, {
            text: comment.body,
            anchor: {
              diffType: "EFFECTIVE",
              path: comment.path,
              ...reviewAnchor(comment.position),
            },
          });
        if (input.body.trim()) yield* write(`${path}/comments`, { text: input.body });
        if (input.verdict !== "comment") {
          const viewer = yield* getViewer();
          const users = yield* pages(
            `/rest/api/1.0/users?filter=${encodeURIComponent(viewer)}`,
            DataCenterUser,
          );
          const user = users.values.find((user) => user.name === viewer);
          if (!user) return yield* new BitbucketPullRequestApi.BitbucketViewerUnavailableError();
          const current = yield* getRaw(input);
          yield* write(
            `${path}/participants/${encodeURIComponent(user.slug)}`,
            {
              status: input.verdict === "approve" ? "APPROVED" : "NEEDS_WORK",
              ...(current.fromRef.latestCommit
                ? { lastReviewedCommit: current.fromRef.latestCommit }
                : {}),
            },
            "PUT",
          );
        }
      }),
  } satisfies Api;
});
