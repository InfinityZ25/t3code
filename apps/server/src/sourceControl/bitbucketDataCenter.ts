import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  PositiveInt,
  TrimmedNonEmptyString,
  type SourceControlRepositoryCloneUrls,
} from "@t3tools/contracts";
import type { BitbucketPullRequest } from "../pullRequest/bitbucketPullRequestJson.ts";
import type { NormalizedBitbucketPullRequestRecord } from "./bitbucketPullRequests.ts";

export const DataCenterUser = Schema.Struct({
  name: TrimmedNonEmptyString,
  slug: TrimmedNonEmptyString,
  displayName: Schema.optional(Schema.String),
  avatarUrl: Schema.optional(Schema.String),
});

export const DataCenterRepository = Schema.Struct({
  slug: TrimmedNonEmptyString,
  project: Schema.Struct({ key: TrimmedNonEmptyString }),
  links: Schema.Struct({
    self: Schema.Array(Schema.Struct({ href: TrimmedNonEmptyString })).check(Schema.isMinLength(1)),
    clone: Schema.optional(
      Schema.Array(Schema.Struct({ name: Schema.String, href: TrimmedNonEmptyString })),
    ),
  }),
});

const RepositoryRef = Schema.Struct({
  slug: TrimmedNonEmptyString,
  project: Schema.Struct({ key: TrimmedNonEmptyString }),
});
const BranchRef = Schema.Struct({
  id: TrimmedNonEmptyString,
  displayId: TrimmedNonEmptyString,
  latestCommit: Schema.optional(Schema.String),
  repository: RepositoryRef,
});
const Participant = Schema.Struct({
  user: DataCenterUser,
  status: Schema.optional(Schema.String),
  approved: Schema.optional(Schema.Boolean),
});
export const DataCenterPullRequest = Schema.Struct({
  id: PositiveInt,
  version: Schema.Int,
  title: TrimmedNonEmptyString,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.String,
  draft: Schema.optional(Schema.Boolean),
  createdDate: Schema.Number,
  updatedDate: Schema.Number,
  author: Schema.optional(Participant),
  reviewers: Schema.optional(Schema.Array(Participant)),
  fromRef: BranchRef,
  toRef: BranchRef,
  links: Schema.Struct({ self: Schema.Array(Schema.Struct({ href: TrimmedNonEmptyString })) }),
});

export const dataCenterPage = <S extends Schema.Top>(item: S) =>
  Schema.Struct({
    values: Schema.Array(item),
    isLastPage: Schema.Boolean,
    nextPageStart: Schema.optional(Schema.Int),
  });

export function dataCenterRepositoryPath(project: string, slug: string): string {
  return `/rest/api/1.0/projects/${encodeURIComponent(project)}/repos/${encodeURIComponent(slug)}`;
}

export function dataCenterRepositoryName(repository: typeof RepositoryRef.Type): string {
  return `${repository.project.key}/${repository.slug}`;
}

export function dataCenterCloneUrls(
  raw: typeof DataCenterRepository.Type,
): SourceControlRepositoryCloneUrls {
  const http = raw.links.clone?.find((link) => link.name === "http" || link.name === "https")?.href;
  const ssh = raw.links.clone?.find((link) => link.name === "ssh")?.href;
  return {
    nameWithOwner: dataCenterRepositoryName(raw),
    url: http ?? raw.links.self[0]?.href ?? dataCenterRepositoryName(raw),
    sshUrl: ssh ?? http ?? raw.links.self[0]?.href ?? dataCenterRepositoryName(raw),
  };
}

export function dataCenterActor(user: typeof DataCenterUser.Type) {
  return { login: user.name, name: user.displayName ?? null, avatarUrl: user.avatarUrl ?? null };
}

export function dataCenterPullRequest(
  raw: typeof DataCenterPullRequest.Type,
): BitbucketPullRequest {
  const reviewers = raw.reviewers ?? [];
  return {
    number: raw.id,
    title: raw.title,
    url: raw.links.self[0]?.href ?? "",
    author: raw.author ? dataCenterActor(raw.author.user) : null,
    headBranch: raw.fromRef.displayId,
    headRepositoryNameWithOwner: dataCenterRepositoryName(raw.fromRef.repository),
    baseBranch: raw.toRef.displayId,
    state: raw.state === "MERGED" ? "merged" : raw.state === "DECLINED" ? "closed" : "open",
    isDraft: raw.draft ?? false,
    mergeability: "unknown",
    createdAt: DateTime.formatIso(DateTime.makeUnsafe(raw.createdDate)),
    updatedAt: DateTime.formatIso(DateTime.makeUnsafe(raw.updatedDate)),
    body: raw.description ?? "",
    reviewRequestLogins: reviewers.map((reviewer) => reviewer.user.name),
    reviewers: reviewers.map((reviewer) => dataCenterActor(reviewer.user)),
    reviewerIds: reviewers.map((reviewer) => reviewer.user.name),
    reviews: [],
  };
}

export function dataCenterSummary(
  raw: typeof DataCenterPullRequest.Type,
): NormalizedBitbucketPullRequestRecord {
  const pr = dataCenterPullRequest(raw);
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    baseRefName: pr.baseBranch,
    headRefName: pr.headBranch,
    state: pr.state,
    isDraft: pr.isDraft,
    updatedAt: Option.some(DateTime.makeUnsafe(raw.updatedDate)),
    isCrossRepository:
      dataCenterRepositoryName(raw.fromRef.repository) !==
      dataCenterRepositoryName(raw.toRef.repository),
    headRepositoryNameWithOwner: pr.headRepositoryNameWithOwner,
    headRepositoryOwnerLogin: raw.fromRef.repository.project.key,
  };
}

export const encodeDataCenterBody = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
