import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  DEFAULT_SERVER_SETTINGS,
  NonNegativeInt,
  TrimmedNonEmptyString,
  type BitbucketSettings,
  type SourceControlProviderAuth,
  type SourceControlRepositoryCloneUrls,
  type SourceControlRepositoryVisibility,
} from "@t3tools/contracts";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { sanitizeBranchFragment } from "@t3tools/shared/git";
import {
  detectSourceControlProviderFromRemoteUrl,
  isSshRemoteUrl,
} from "@t3tools/shared/sourceControl";

import {
  BitbucketPullRequestListSchema,
  BitbucketPullRequestSchema,
  normalizeBitbucketPullRequestRecord,
  type NormalizedBitbucketPullRequestRecord,
} from "./bitbucketPullRequests.ts";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import {
  encodeDataCenterBody,
  DataCenterRepository,
  DataCenterPullRequest,
  dataCenterPage,
  dataCenterRepositoryPath,
  dataCenterRepositoryName,
  dataCenterCloneUrls,
  dataCenterSummary,
} from "./bitbucketDataCenter.ts";
import { retryAtFromHeader } from "./SourceControlRateLimit.ts";

const decodeDataCenterRepository = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DataCenterRepository),
);

const DEFAULT_API_BASE_URL = "https://api.bitbucket.org/2.0";
/** A response body past this is cut short, so one huge diff cannot exhaust the server. */
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** Bitbucket redirects a diff once; this leaves room without following a chain forever. */
const MAX_REDIRECTS = 3;

const BitbucketApiEnvConfig = Config.all({
  baseUrl: Config.String("T3CODE_BITBUCKET_API_BASE_URL").pipe(
    Config.withDefault(DEFAULT_API_BASE_URL),
  ),
  serverUrl: Config.String("T3CODE_BITBUCKET_SERVER_URL").pipe(Config.option),
  accessToken: Config.String("T3CODE_BITBUCKET_ACCESS_TOKEN").pipe(Config.option),
  email: Config.String("T3CODE_BITBUCKET_EMAIL").pipe(Config.option),
  apiToken: Config.String("T3CODE_BITBUCKET_API_TOKEN").pipe(Config.option),
});

const BitbucketApiOperation = Schema.Literals([
  "resolveRepository",
  "getRepository",
  "getBranchingModel",
  "getPullRequest",
  "listPullRequests",
  "createRepository",
  "createPullRequest",
  "probeAuth",
  "checkoutPullRequest",
  // The raw escape hatch. Callers name their own operation in their own error, the way the
  // pull request wrappers do on top of `gh` and `glab`.
  "request",
]);
type BitbucketApiOperation = typeof BitbucketApiOperation.Type;

export class BitbucketRepositoryLocatorError extends Schema.TaggedError<BitbucketRepositoryLocatorError>()(
  "BitbucketRepositoryLocatorError",
  {
    repository: Schema.String,
  },
) {
  static readonly detail = "Bitbucket repositories must be specified as workspace/repository.";

  get detail(): string {
    return BitbucketRepositoryLocatorError.detail;
  }

  override get message(): string {
    return `Bitbucket API failed: ${this.detail}`;
  }
}

export class BitbucketRequestError extends Schema.TaggedError<BitbucketRequestError>()(
  "BitbucketRequestError",
  {
    operation: BitbucketApiOperation,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return "Failed to send the Bitbucket request.";
  }

  override get message(): string {
    return `Bitbucket API failed in ${this.operation}: ${this.detail}`;
  }
}

export class BitbucketResponseError extends Schema.TaggedError<BitbucketResponseError>()(
  "BitbucketResponseError",
  {
    operation: BitbucketApiOperation,
    status: Schema.Int,
    responseBodyLength: NonNegativeInt,
    retryAt: Schema.optional(Schema.Number),
  },
) {
  get detail(): string {
    return `Bitbucket returned HTTP ${this.status}.`;
  }

  override get message(): string {
    return `Bitbucket API failed in ${this.operation}: ${this.detail}`;
  }
}

export class BitbucketResponseBodyReadError extends Schema.TaggedError<BitbucketResponseBodyReadError>()(
  "BitbucketResponseBodyReadError",
  {
    operation: BitbucketApiOperation,
    status: Schema.Int,
    retryAt: Schema.optional(Schema.Number),
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return `Bitbucket returned HTTP ${this.status}.`;
  }

  override get message(): string {
    return `Bitbucket API failed in ${this.operation}: ${this.detail}`;
  }
}

export class BitbucketResponseDecodeError extends Schema.TaggedError<BitbucketResponseDecodeError>()(
  "BitbucketResponseDecodeError",
  {
    operation: BitbucketApiOperation,
    status: Schema.Int,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return "Bitbucket returned invalid JSON for the requested resource.";
  }

  override get message(): string {
    return `Bitbucket API failed in ${this.operation}: ${this.detail}`;
  }
}

export class BitbucketRepositoryVcsResolveError extends Schema.TaggedError<BitbucketRepositoryVcsResolveError>()(
  "BitbucketRepositoryVcsResolveError",
  {
    cwd: Schema.String,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return `Failed to resolve VCS repository for ${this.cwd}.`;
  }

  override get message(): string {
    return `Bitbucket API failed in resolveRepository: ${this.detail}`;
  }
}

export class BitbucketRepositoryRemotesListError extends Schema.TaggedError<BitbucketRepositoryRemotesListError>()(
  "BitbucketRepositoryRemotesListError",
  {
    cwd: Schema.String,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return `Failed to list remotes for ${this.cwd}.`;
  }

  override get message(): string {
    return `Bitbucket API failed in resolveRepository: ${this.detail}`;
  }
}

export class BitbucketRepositoryRemoteNotFoundError extends Schema.TaggedError<BitbucketRepositoryRemoteNotFoundError>()(
  "BitbucketRepositoryRemoteNotFoundError",
  {
    cwd: Schema.String,
  },
) {
  get detail(): string {
    return `No Bitbucket repository remote was detected for ${this.cwd}.`;
  }

  override get message(): string {
    return `Bitbucket API failed in resolveRepository: ${this.detail}`;
  }
}

export class BitbucketPullRequestBodyReadError extends Schema.TaggedError<BitbucketPullRequestBodyReadError>()(
  "BitbucketPullRequestBodyReadError",
  {
    cwd: Schema.String,
    bodyFile: Schema.String,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return `Failed to read pull request body file ${this.bodyFile}.`;
  }

  override get message(): string {
    return `Bitbucket API failed in createPullRequest: ${this.detail}`;
  }
}

export class BitbucketCheckoutError extends Schema.TaggedError<BitbucketCheckoutError>()(
  "BitbucketCheckoutError",
  {
    cwd: Schema.String,
    reference: Schema.String,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return "Failed to check out the Bitbucket pull request.";
  }

  override get message(): string {
    return `Bitbucket API failed in checkoutPullRequest: ${this.detail}`;
  }
}

/**
 * A url that does not belong to the configured Bitbucket. Refused rather than followed, because
 * the request carries the account's credentials and a url that came back in a response — a
 * pagination cursor, or the target of a redirect — is not this server's to trust.
 */
export class BitbucketUntrustedUrlError extends Schema.TaggedError<BitbucketUntrustedUrlError>()(
  "BitbucketUntrustedUrlError",
  {
    /** The host only. A rejected hop is often a signed url, whose query carries a credential. */
    host: Schema.String,
  },
) {
  get detail(): string {
    return `The response pointed at ${this.host}, outside the configured Bitbucket.`;
  }

  override get message(): string {
    return `Bitbucket API failed in request: ${this.detail}`;
  }
}

export class BitbucketServerUrlError extends Schema.TaggedError<BitbucketServerUrlError>()(
  "BitbucketServerUrlError",
  {},
) {
  get detail(): string {
    return "Set a valid HTTP(S) Bitbucket Data Center base URL without credentials, query, or fragment.";
  }
  override get message(): string {
    return this.detail;
  }
}

export const BitbucketApiError = Schema.Union([
  BitbucketServerUrlError,
  BitbucketUntrustedUrlError,
  BitbucketRepositoryLocatorError,
  BitbucketRequestError,
  BitbucketResponseError,
  BitbucketResponseBodyReadError,
  BitbucketResponseDecodeError,
  BitbucketRepositoryVcsResolveError,
  BitbucketRepositoryRemotesListError,
  BitbucketRepositoryRemoteNotFoundError,
  BitbucketPullRequestBodyReadError,
  BitbucketCheckoutError,
]);
export type BitbucketApiError = typeof BitbucketApiError.Type;
const isBitbucketApiError = Schema.is(BitbucketApiError);

const RawBitbucketRepositorySchema = Schema.Struct({
  full_name: TrimmedNonEmptyString,
  links: Schema.Struct({
    html: Schema.optional(
      Schema.Struct({
        href: TrimmedNonEmptyString,
      }),
    ),
    clone: Schema.optional(
      Schema.Array(
        Schema.Struct({
          name: TrimmedNonEmptyString,
          href: TrimmedNonEmptyString,
        }),
      ),
    ),
  }),
  mainbranch: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        name: TrimmedNonEmptyString,
      }),
    ),
  ),
});

const RawBitbucketBranchingModelSchema = Schema.Struct({
  development: Schema.optional(
    Schema.Struct({
      branch: Schema.optional(
        Schema.NullOr(
          Schema.Struct({
            name: Schema.optional(TrimmedNonEmptyString),
          }),
        ),
      ),
      is_valid: Schema.optional(Schema.Boolean),
      name: Schema.optional(Schema.NullOr(Schema.String)),
      use_mainbranch: Schema.optional(Schema.Boolean),
    }),
  ),
});

const BitbucketUserSchema = Schema.Struct({
  username: Schema.optional(TrimmedNonEmptyString),
  display_name: Schema.optional(TrimmedNonEmptyString),
  account_id: Schema.optional(TrimmedNonEmptyString),
});

export interface BitbucketRepositoryLocator {
  readonly workspace: string;
  readonly repoSlug: string;
}

export class BitbucketApi extends Context.Service<
  BitbucketApi,
  {
    readonly getServerUrl: Effect.Effect<string | null, BitbucketApiError>;
    readonly probeAuth: Effect.Effect<SourceControlProviderAuth, never>;

    /**
     * One authenticated request, returning the body verbatim. Bitbucket answers most endpoints
     * with JSON and a few — a pull request diff, for one — with plain text, so the body is
     * handed back undecoded for the caller to read as it sees fit.
     */
    readonly request: (input: {
      readonly method: "GET" | "POST" | "PUT" | "DELETE";
      readonly accept?: "text/plain";
      /**
       * A path below the API base, or a whole URL as a paged response reports its next page.
       * A whole URL is refused unless it belongs to the configured Bitbucket.
       */
      readonly url: string;
      /** A JSON document, for the endpoints that take one. */
      readonly body?: string;
      /** Response bytes to keep; past this the body comes back cut short and marked. */
      readonly maxBytes?: number;
    }) => Effect.Effect<
      { readonly body: string; readonly truncated: boolean; readonly account?: string },
      BitbucketApiError
    >;
    readonly listPullRequests: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
      readonly headSelector: string;
      readonly source?: SourceControlProvider.SourceControlRefSelector;
      readonly state: "open" | "closed" | "merged" | "all";
      readonly limit?: number;
    }) => Effect.Effect<ReadonlyArray<NormalizedBitbucketPullRequestRecord>, BitbucketApiError>;
    readonly getPullRequest: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
      readonly reference: string;
    }) => Effect.Effect<NormalizedBitbucketPullRequestRecord, BitbucketApiError>;
    readonly getRepositoryCloneUrls: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
      readonly repository: string;
    }) => Effect.Effect<SourceControlRepositoryCloneUrls, BitbucketApiError>;
    readonly createRepository: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly visibility: SourceControlRepositoryVisibility;
    }) => Effect.Effect<SourceControlRepositoryCloneUrls, BitbucketApiError>;
    readonly createPullRequest: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
      readonly baseBranch: string;
      readonly headSelector: string;
      readonly source?: SourceControlProvider.SourceControlRefSelector;
      readonly target?: SourceControlProvider.SourceControlRefSelector;
      readonly title: string;
      readonly bodyFile: string;
    }) => Effect.Effect<void, BitbucketApiError>;
    readonly getDefaultBranch: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
    }) => Effect.Effect<string | null, BitbucketApiError>;
    readonly checkoutPullRequest: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
      readonly reference: string;
      readonly force?: boolean;
    }) => Effect.Effect<void, BitbucketApiError>;
  }
>()("t3/sourceControl/BitbucketApi") {}

function nonEmpty(value: string | undefined): Option.Option<string> {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? Option.none() : Option.some(trimmed);
}

function normalizeChangeRequestId(reference: string): string {
  const trimmed = reference.trim().replace(/^#/, "");
  const urlMatch = /(?:pull-requests|pullrequests|pull-request|pull|pr)\/(\d+)(?:\D.*)?$/i.exec(
    trimmed,
  );
  return urlMatch?.[1] ?? trimmed;
}

function sourceWorkspace(input: {
  readonly headSelector: string;
  readonly source?: SourceControlProvider.SourceControlRefSelector;
}): string | undefined {
  if (input.source?.owner) return input.source.owner;
  return SourceControlProvider.parseSourceControlOwnerRef(input.headSelector)?.owner;
}

function toBitbucketStates(state: "open" | "closed" | "merged" | "all"): ReadonlyArray<string> {
  switch (state) {
    case "open":
      return ["OPEN"];
    case "closed":
      return ["DECLINED", "SUPERSEDED"];
    case "merged":
      return ["MERGED"];
    case "all":
      return ["OPEN", "MERGED", "DECLINED", "SUPERSEDED"];
  }
}

function bitbucketQueryString(filters: ReadonlyArray<string>): string {
  return filters.join(" AND ");
}

function bitbucketStateFilter(states: ReadonlyArray<string>): string {
  return states.length === 1
    ? `state = "${states[0]}"`
    : `(${states.map((state) => `state = "${state}"`).join(" OR ")})`;
}

function parseBitbucketRepositorySlug(value: string): BitbucketRepositoryLocator | null {
  const normalized = value.trim().replace(/\.git$/u, "");
  const parts = normalized.split("/").filter((part) => part.length > 0);
  const web = /(?:^|\/)projects\/([^/]+)\/repos\/([^/]+)(?:\/|$)/iu.exec(normalized);
  if (web?.[1] && web[2]) return { workspace: web[1], repoSlug: web[2] };
  const personal = /(?:^|\/)users\/([^/]+)\/repos\/([^/]+)(?:\/|$)/iu.exec(normalized);
  if (personal?.[1] && personal[2]) return { workspace: `~${personal[1]}`, repoSlug: personal[2] };
  if (parts.length < 2) return null;
  const workspace = parts.at(-2);
  const repoSlug = parts.at(-1);
  return workspace && repoSlug ? { workspace, repoSlug } : null;
}

function requireRepositoryLocator(
  repository: string,
): Effect.Effect<BitbucketRepositoryLocator, BitbucketApiError> {
  const locator = parseBitbucketRepositorySlug(repository);
  return locator
    ? Effect.succeed(locator)
    : Effect.fail(
        new BitbucketRepositoryLocatorError({
          repository,
        }),
      );
}

function parseBitbucketRemoteUrl(remoteUrl: string): BitbucketRepositoryLocator | null {
  const trimmed = remoteUrl.trim();
  const scpMatch = /^[a-zA-Z0-9._-]+@[^:/]+:(.+)$/.exec(trimmed);
  if (scpMatch?.[1]) {
    return parseBitbucketRepositorySlug(scpMatch[1]);
  }

  try {
    return parseBitbucketRepositorySlug(new URL(trimmed).pathname);
  } catch {
    return null;
  }
}

function normalizeRepositoryCloneUrls(
  raw: typeof RawBitbucketRepositorySchema.Type,
): SourceControlRepositoryCloneUrls {
  const httpClone =
    raw.links.clone?.find((entry) => entry.name.toLowerCase() === "https")?.href ??
    raw.links.html?.href;
  const sshClone = raw.links.clone?.find((entry) => entry.name.toLowerCase() === "ssh")?.href;

  return {
    nameWithOwner: raw.full_name,
    url: httpClone ?? raw.links.html?.href ?? raw.full_name,
    sshUrl: sshClone ?? httpClone ?? raw.full_name,
  };
}

function defaultChangeRequestTargetBranch(input: {
  readonly repository: typeof RawBitbucketRepositorySchema.Type;
  readonly branchingModel: typeof RawBitbucketBranchingModelSchema.Type | null;
}): string | null {
  const repositoryMainBranch = input.repository.mainbranch?.name ?? null;
  const development = input.branchingModel?.development;
  if (!development || development.use_mainbranch === true || development.is_valid === false) {
    return repositoryMainBranch;
  }

  const developmentBranch = development.branch?.name?.trim() ?? development.name?.trim() ?? "";
  if (developmentBranch.length === 0 || developmentBranch === "null") {
    return repositoryMainBranch;
  }

  return developmentBranch;
}

function shouldPreferSshRemote(originRemoteUrl: string | null): boolean {
  if (!originRemoteUrl) return false;
  return isSshRemoteUrl(originRemoteUrl);
}

function selectCloneUrl(input: {
  readonly cloneUrls: SourceControlRepositoryCloneUrls;
  readonly originRemoteUrl: string | null;
}): string {
  return shouldPreferSshRemote(input.originRemoteUrl)
    ? input.cloneUrls.sshUrl
    : input.cloneUrls.url;
}

function checkoutBranchName(input: {
  readonly pullRequestId: number;
  readonly headBranch: string;
  readonly isCrossRepository: boolean;
}): string {
  if (!input.isCrossRepository) {
    return input.headBranch;
  }

  return `t3code/pr-${input.pullRequestId}/${sanitizeBranchFragment(input.headBranch)}`;
}

function repositoryNameWithOwner(
  repository: Schema.Schema.Type<typeof BitbucketPullRequestSchema>["source"]["repository"],
): string | null {
  const fullName = repository?.full_name?.trim() ?? "";
  return fullName.length > 0 ? fullName : null;
}

function repositoryOwnerName(repositoryName: string): string {
  return repositoryName.split("/")[0]?.trim() || "bitbucket";
}

type BitbucketCredential =
  | { readonly kind: "access-token"; readonly accessToken: string }
  | { readonly kind: "api-token"; readonly email: string; readonly apiToken: string };

/**
 * Visible ASCII only. A value the HTTP stack rejects makes it throw an error quoting the whole
 * header, and that error travels to clients as a cause, so an unusable token is treated as unset.
 */
const HEADER_SAFE = /^[\x21-\x7e]+$/u;

function credentialFrom(input: {
  readonly accessToken: string;
  readonly email: string;
  readonly apiToken: string;
}): BitbucketCredential | null {
  if (HEADER_SAFE.test(input.accessToken)) {
    return { kind: "access-token", accessToken: input.accessToken };
  }
  if (HEADER_SAFE.test(input.email) && HEADER_SAFE.test(input.apiToken)) {
    return { kind: "api-token", email: input.email, apiToken: input.apiToken };
  }
  return null;
}

/**
 * Credentials saved in settings win over the `T3CODE_BITBUCKET_*` environment variables, which
 * stay as a fallback. Within each source the access token wins.
 */
function resolveCredential(
  settings: BitbucketSettings,
  env: Config.Success<typeof BitbucketApiEnvConfig>,
): BitbucketCredential | null {
  return (
    credentialFrom(settings) ??
    credentialFrom({
      accessToken: Option.getOrElse(env.accessToken, () => ""),
      email: Option.getOrElse(env.email, () => ""),
      apiToken: Option.getOrElse(env.apiToken, () => ""),
    })
  );
}

function authFromCredential(credential: BitbucketCredential | null): SourceControlProviderAuth {
  if (credential?.kind === "access-token") {
    return {
      status: "unknown",
      account: Option.none(),
      host: Option.some("bitbucket.org"),
      detail: Option.some("An access token is configured."),
    };
  }

  if (credential?.kind === "api-token") {
    return {
      status: "unknown",
      account: Option.some(credential.email),
      host: Option.some("bitbucket.org"),
      detail: Option.some("An API token is configured."),
    };
  }

  return {
    status: "unauthenticated",
    account: Option.none(),
    host: Option.some("bitbucket.org"),
    detail: Option.some(
      "Add a Bitbucket token in Settings → Source Control, or set the T3CODE_BITBUCKET_* environment variables on the server.",
    ),
  };
}

/** Null for anything that is not a url at all, which is never the configured Bitbucket. */
function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function responseError(
  operation: BitbucketApiOperation,
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<never, BitbucketApiError> {
  // Bounded like any other body: an error response is no smaller than a successful one, and
  // only its length is reported anyway.
  return Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const retryAt = retryAtFromHeader(response.headers["retry-after"], now);
    const collected = yield* collectUint8StreamText({
      stream: response.stream,
      maxBytes: DEFAULT_MAX_RESPONSE_BYTES,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new BitbucketResponseBodyReadError({
            operation,
            status: response.status,
            retryAt,
            cause,
          }),
      ),
    );
    return yield* new BitbucketResponseError({
      operation,
      status: response.status,
      responseBodyLength: collected.text.length,
      retryAt,
    });
  });
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* BitbucketApiEnvConfig;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;

  const apiUrl = (path: string) => `${config.baseUrl.replace(/\/+$/u, "")}${path}`;

  // Read on every request so credentials saved in settings apply without a restart.
  const currentCredential = serverSettings.getSettings.pipe(
    Effect.map((settings) => resolveCredential(settings.bitbucket, config)),
    Effect.catch((error) =>
      // No cause: a settings decode error can quote a hand-edited token.
      Effect.logWarning("failed to read Bitbucket credentials from settings", {
        operation: error.operation,
      }).pipe(Effect.as(resolveCredential(DEFAULT_SERVER_SETTINGS.bitbucket, config))),
    ),
  );

  const getServerUrl = serverSettings.getSettings.pipe(
    Effect.map(
      (settings) => settings.bitbucket.serverUrl ?? Option.getOrElse(config.serverUrl, () => ""),
    ),
    Effect.catch(() => Effect.succeed(Option.getOrElse(config.serverUrl, () => ""))),
    Effect.flatMap((value): Effect.Effect<string | null, BitbucketApiError> => {
      if (value.trim() === "") return Effect.succeed(null);
      try {
        const url = new URL(value.trim());
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        ) {
          return Effect.fail(new BitbucketServerUrlError());
        }
        return Effect.succeed(url.href.replace(/\/+$/u, ""));
      } catch {
        return Effect.fail(new BitbucketServerUrlError());
      }
    }),
  );

  const matchesServer = (remote: string, server: string) => {
    const scp = /^[^@]+@([^:/]+):/.exec(remote);
    try {
      const base = new URL(server);
      if (scp) return scp[1]?.toLowerCase() === base.hostname.toLowerCase();
      const url = new URL(remote);
      return url.protocol === "ssh:"
        ? url.hostname.toLowerCase() === base.hostname.toLowerCase()
        : url.origin === base.origin &&
            url.pathname.startsWith(`${base.pathname.replace(/\/+$/u, "")}/`);
    } catch {
      return false;
    }
  };

  const withAuth = (request: HttpClientRequest.HttpClientRequest) =>
    currentCredential.pipe(
      Effect.map((credential) =>
        credential === null
          ? request
          : credential.kind === "access-token"
            ? request.pipe(HttpClientRequest.bearerToken(credential.accessToken))
            : request.pipe(HttpClientRequest.basicAuth(credential.email, credential.apiToken)),
      ),
    );

  const decodeResponse = <S extends Schema.Top>(
    operation: BitbucketApiOperation,
    schema: S,
    response: HttpClientResponse.HttpClientResponse,
  ): Effect.Effect<S["Type"], BitbucketApiError, S["DecodingServices"]> =>
    HttpClientResponse.matchStatus({
      "2xx": (success) =>
        HttpClientResponse.schemaBodyJson(schema)(success).pipe(
          Effect.mapError(
            (cause) =>
              new BitbucketResponseDecodeError({
                operation,
                status: success.status,
                cause,
              }),
          ),
        ),
      orElse: (failed) => responseError(operation, failed),
    })(response);

  const executeJson = <S extends Schema.Top>(
    operation: BitbucketApiOperation,
    request: HttpClientRequest.HttpClientRequest,
    schema: S,
  ): Effect.Effect<S["Type"], BitbucketApiError, S["DecodingServices"]> =>
    withAuth(request.pipe(HttpClientRequest.acceptJson)).pipe(
      Effect.flatMap(httpClient.execute),
      Effect.mapError(
        (cause) =>
          new BitbucketRequestError({
            operation,
            cause,
          }),
      ),
      Effect.flatMap((response) => decodeResponse(operation, schema, response)),
    );

  const resolveRepository = Effect.fn("BitbucketApi.resolveRepository")(function* (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly repository?: string;
  }) {
    const server = yield* getServerUrl;
    if (input.repository !== undefined) {
      if (
        server &&
        /^(?:[a-z]+:\/\/|[^@]+@)/iu.test(input.repository) &&
        !matchesServer(input.repository, server)
      ) {
        return yield* new BitbucketUntrustedUrlError({
          host: originOf(input.repository) ?? "another host",
        });
      }
      return yield* requireRepositoryLocator(input.repository);
    }
    if (server && input.context && !matchesServer(input.context.remoteUrl, server)) {
      return yield* new BitbucketUntrustedUrlError({
        host: originOf(input.context.remoteUrl) ?? "another host",
      });
    }

    const fromContext =
      input.context?.provider.kind === "bitbucket"
        ? parseBitbucketRemoteUrl(input.context.remoteUrl)
        : null;
    if (fromContext) return fromContext;

    const handle = yield* vcsRegistry.resolve({ cwd: input.cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new BitbucketRepositoryVcsResolveError({
            cwd: input.cwd,
            cause,
          }),
      ),
    );
    const remotes = yield* handle.driver.listRemotes(input.cwd).pipe(
      Effect.mapError(
        (cause) =>
          new BitbucketRepositoryRemotesListError({
            cwd: input.cwd,
            cause,
          }),
      ),
    );

    for (const remote of remotes.remotes) {
      if (
        server
          ? !matchesServer(remote.url, server)
          : detectSourceControlProviderFromRemoteUrl(remote.url)?.kind !== "bitbucket"
      )
        continue;
      const parsed = parseBitbucketRemoteUrl(remote.url);
      if (parsed) return parsed;
    }

    return yield* new BitbucketRepositoryRemoteNotFoundError({
      cwd: input.cwd,
    });
  });

  const getRepositoryFromLocator = (repository: BitbucketRepositoryLocator) =>
    executeJson(
      "getRepository",
      HttpClientRequest.get(
        apiUrl(
          `/repositories/${encodeURIComponent(repository.workspace)}/${encodeURIComponent(repository.repoSlug)}`,
        ),
      ),
      RawBitbucketRepositorySchema,
    );

  const getRepository = (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly repository?: string;
  }) => resolveRepository(input).pipe(Effect.flatMap(getRepositoryFromLocator));

  const getBranchingModelFromLocator = (repository: BitbucketRepositoryLocator) =>
    executeJson(
      "getBranchingModel",
      HttpClientRequest.get(
        apiUrl(
          `/repositories/${encodeURIComponent(repository.workspace)}/${encodeURIComponent(repository.repoSlug)}/branching-model`,
        ),
      ),
      RawBitbucketBranchingModelSchema,
    );

  const getRawPullRequestFromRepository = (
    repository: BitbucketRepositoryLocator,
    reference: string,
  ) =>
    executeJson(
      "getPullRequest",
      HttpClientRequest.get(
        apiUrl(
          `/repositories/${encodeURIComponent(repository.workspace)}/${encodeURIComponent(repository.repoSlug)}/pullrequests/${encodeURIComponent(normalizeChangeRequestId(reference))}`,
        ),
      ),
      BitbucketPullRequestSchema,
    );

  const getRawPullRequest = (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly reference: string;
  }) =>
    resolveRepository(input).pipe(
      Effect.flatMap((repository) => getRawPullRequestFromRepository(repository, input.reference)),
    );

  const readConfigValueNullable = (cwd: string, key: string) =>
    git.readConfigValue(cwd, key).pipe(Effect.orElseSucceed(() => null));

  const resolveCheckoutRemote = Effect.fn("BitbucketApi.resolveCheckoutRemote")(function* (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly destinationRepository: BitbucketRepositoryLocator;
    readonly sourceRepositoryName: string;
    readonly isCrossRepository: boolean;
  }) {
    if (
      input.context?.provider.kind === "bitbucket" &&
      !input.isCrossRepository &&
      parseBitbucketRemoteUrl(input.context.remoteUrl) !== null
    ) {
      return input.context.remoteName;
    }

    if (!input.isCrossRepository) {
      const remoteName = yield* git
        .resolvePrimaryRemoteName(input.cwd)
        .pipe(Effect.orElseSucceed(() => null));
      if (remoteName) return remoteName;
    }

    const cloneUrls = yield* getRepository({
      cwd: input.cwd,
      repository: input.sourceRepositoryName,
      ...(input.context ? { context: input.context } : {}),
    }).pipe(Effect.map(normalizeRepositoryCloneUrls));
    const originRemoteUrl = yield* readConfigValueNullable(input.cwd, "remote.origin.url");
    return yield* git.ensureRemote({
      cwd: input.cwd,
      preferredName: input.isCrossRepository
        ? repositoryOwnerName(input.sourceRepositoryName)
        : input.destinationRepository.workspace,
      url: selectCloneUrl({ cloneUrls, originRemoteUrl }),
    });
  });

  // A pull request's diff, diffstat and conflicts are served as redirects to a commit-range
  // URL, and the client does not follow redirects unless asked. The hop stays on the same host,
  // so the credentials travel with it.
  /**
   * The one host these credentials may be sent to. A url that came back inside a response — a
   * pagination cursor, or the target of a redirect — is data, not instruction, so it is checked
   * against this before the account's token travels with it.
   */
  const trustedUrl = (value: string) =>
    getServerUrl.pipe(
      Effect.map((server) => {
        const base = server ?? config.baseUrl.replace(/\/+$/u, "");
        if (!/^https?:\/\//u.test(value)) return `${base}${value}`;
        try {
          const url = new URL(value);
          return url.origin === originOf(base) && !url.username && !url.password ? value : null;
        } catch {
          return null;
        }
      }),
    );

  /**
   * Redirects are followed here rather than by the client, which forwards every header to
   * whatever host it is sent to. A pull request diff, diffstat and conflicts are all served as
   * redirects, so they have to be followed — but only back to the same Bitbucket.
   */
  const send = (input: {
    readonly method: "GET" | "POST" | "PUT" | "DELETE";
    readonly url: string;
    readonly body?: string;
    readonly redirects: number;
    readonly accept?: "text/plain";
  }): Effect.Effect<HttpClientResponse.HttpClientResponse, BitbucketApiError> =>
    Effect.gen(function* () {
      const url = yield* trustedUrl(input.url);
      if (url === null) {
        return yield* new BitbucketUntrustedUrlError({
          host: originOf(input.url) ?? "an unreadable url",
        });
      }
      const base =
        input.method === "GET"
          ? HttpClientRequest.get(url)
          : input.method === "POST"
            ? HttpClientRequest.post(url)
            : input.method === "DELETE"
              ? HttpClientRequest.make("DELETE")(url)
              : HttpClientRequest.put(url);
      // No `Accept: application/json`: the diff endpoints answer with a patch, not JSON.
      const withBody =
        input.body === undefined
          ? base
          : base.pipe(HttpClientRequest.bodyText(input.body, "application/json"));
      return yield* withAuth(
        input.accept
          ? withBody.pipe(HttpClientRequest.setHeader("Accept", input.accept))
          : withBody,
      ).pipe(
        Effect.flatMap(httpClient.execute),
        Effect.mapError(
          (cause): BitbucketApiError => new BitbucketRequestError({ operation: "request", cause }),
        ),
        Effect.flatMap((response) => {
          const location = response.headers.location;
          if (
            response.status >= 300 &&
            response.status < 400 &&
            location !== undefined &&
            input.redirects < MAX_REDIRECTS
          ) {
            return send({
              ...input,
              url: new URL(location, url).toString(),
              redirects: input.redirects + 1,
            });
          }
          return Effect.succeed(response);
        }),
      );
    });

  const request: BitbucketApi["Service"]["request"] = (input) =>
    send({ ...input, redirects: 0 }).pipe(
      Effect.flatMap((response) =>
        HttpClientResponse.matchStatus({
          // Read through the body stream rather than `text`, so an oversized diff is stopped
          // as it arrives instead of being materialized whole and then cut. The same collector
          // the process runner bounds command output with.
          "2xx": (success) =>
            collectUint8StreamText({
              stream: success.stream,
              maxBytes: input.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new BitbucketResponseBodyReadError({
                    operation: "request",
                    status: success.status,
                    cause,
                  }),
              ),
              Effect.map((collected) => ({
                body: collected.text,
                truncated: collected.truncated,
                ...(success.headers["x-ausername"]
                  ? { account: success.headers["x-ausername"] }
                  : {}),
              })),
            ),
          orElse: (failed) => responseError("request", failed),
        })(response),
      ),
    );

  const cloud = BitbucketApi.of({
    getServerUrl,
    request,
    probeAuth: executeJson(
      "probeAuth",
      HttpClientRequest.get(apiUrl("/user")),
      BitbucketUserSchema,
    ).pipe(
      Effect.map((user) => ({
        status: "authenticated" as const,
        account: nonEmpty(user.username ?? user.display_name ?? user.account_id),
        host: Option.some("bitbucket.org"),
        detail: Option.none<string>(),
      })),
      Effect.catch(() => currentCredential.pipe(Effect.map(authFromCredential))),
    ),
    listPullRequests: (input) =>
      resolveRepository(input).pipe(
        Effect.flatMap((repository) => {
          const states = toBitbucketStates(input.state);
          const query: Record<string, string | ReadonlyArray<string>> = {
            pagelen: String(Math.max(1, Math.min(input.limit ?? 20, 50))),
            sort: "-updated_on",
            q: bitbucketQueryString([
              `source.branch.name = "${SourceControlProvider.sourceBranch(input).replaceAll('"', '\\"')}"`,
              bitbucketStateFilter(states),
            ]),
            state: states,
          };

          return executeJson(
            "listPullRequests",
            HttpClientRequest.get(
              apiUrl(
                `/repositories/${encodeURIComponent(repository.workspace)}/${encodeURIComponent(repository.repoSlug)}/pullrequests`,
              ),
              { urlParams: query },
            ),
            BitbucketPullRequestListSchema,
          );
        }),
        Effect.map((list) => list.values.map(normalizeBitbucketPullRequestRecord)),
      ),
    getPullRequest: (input) =>
      getRawPullRequest(input).pipe(Effect.map(normalizeBitbucketPullRequestRecord)),
    getRepositoryCloneUrls: (input) =>
      getRepository(input).pipe(Effect.map(normalizeRepositoryCloneUrls)),
    createRepository: (input) =>
      requireRepositoryLocator(input.repository).pipe(
        Effect.flatMap((repository) =>
          executeJson(
            "createRepository",
            HttpClientRequest.post(
              apiUrl(
                `/repositories/${encodeURIComponent(repository.workspace)}/${encodeURIComponent(repository.repoSlug)}`,
              ),
            ).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                scm: "git",
                is_private: input.visibility === "private",
              }),
            ),
            RawBitbucketRepositorySchema,
          ),
        ),
        Effect.map(normalizeRepositoryCloneUrls),
      ),
    createPullRequest: (input) =>
      Effect.gen(function* () {
        const repository = yield* resolveRepository(input);
        const description = yield* fileSystem.readFileString(input.bodyFile).pipe(
          Effect.mapError(
            (cause) =>
              new BitbucketPullRequestBodyReadError({
                cwd: input.cwd,
                bodyFile: input.bodyFile,
                cause,
              }),
          ),
        );
        const sourceOwner = sourceWorkspace(input);
        const body = {
          title: input.title,
          description,
          source: {
            branch: {
              name: SourceControlProvider.sourceBranch(input),
            },
            ...(sourceOwner
              ? {
                  repository: {
                    full_name: `${sourceOwner}/${input.source?.repository ?? repository.repoSlug}`,
                  },
                }
              : {}),
          },
          destination: {
            branch: {
              name: input.target?.refName ?? input.baseBranch,
            },
          },
        };

        yield* executeJson(
          "createPullRequest",
          HttpClientRequest.post(
            apiUrl(
              `/repositories/${encodeURIComponent(repository.workspace)}/${encodeURIComponent(repository.repoSlug)}/pullrequests`,
            ),
          ).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
          BitbucketPullRequestSchema,
        );
      }),
    getDefaultBranch: (input) =>
      resolveRepository(input).pipe(
        Effect.flatMap((locator) =>
          Effect.all(
            {
              repository: getRepositoryFromLocator(locator),
              branchingModel: getBranchingModelFromLocator(locator).pipe(
                Effect.orElseSucceed(
                  (): typeof RawBitbucketBranchingModelSchema.Type | null => null,
                ),
              ),
            },
            { concurrency: "unbounded" },
          ),
        ),
        Effect.map(defaultChangeRequestTargetBranch),
      ),
    // Bitbucket Cloud pull requests are Git-backed and Bitbucket does not provide
    // an official checkout CLI. This provider-local path uses GitVcsDriver as a
    // narrow escape hatch to materialize Bitbucket PR refs. Do not generalize this
    // as the source-control provider model: if we support non-Git-compatible
    // hosting providers or native JJ/Sapling checkout flows, move this into a
    // VCS-specific change-request checkout capability.
    checkoutPullRequest: (input) =>
      Effect.gen(function* () {
        const destinationRepository = yield* resolveRepository(input);
        const pullRequest = yield* getRawPullRequestFromRepository(
          destinationRepository,
          input.reference,
        );
        const destinationRepositoryName =
          repositoryNameWithOwner(pullRequest.destination.repository) ??
          `${destinationRepository.workspace}/${destinationRepository.repoSlug}`;
        const sourceRepositoryName =
          repositoryNameWithOwner(pullRequest.source.repository) ?? destinationRepositoryName;
        const isCrossRepository = sourceRepositoryName !== destinationRepositoryName;
        const remoteName = yield* resolveCheckoutRemote({
          cwd: input.cwd,
          destinationRepository,
          sourceRepositoryName,
          isCrossRepository,
          ...(input.context ? { context: input.context } : {}),
        });
        const remoteBranch = pullRequest.source.branch.name;
        const localBranch = checkoutBranchName({
          pullRequestId: pullRequest.id,
          headBranch: remoteBranch,
          isCrossRepository,
        });
        const localBranchNames = yield* git.listLocalBranchNames(input.cwd);
        const localBranchExists = localBranchNames.includes(localBranch);

        if (input.force === true || !localBranchExists) {
          yield* git.fetchRemoteBranch({
            cwd: input.cwd,
            remoteName,
            remoteBranch,
            localBranch,
          });
        } else {
          yield* git.fetchRemoteTrackingBranch({
            cwd: input.cwd,
            remoteName,
            remoteBranch,
          });
        }

        yield* git.setBranchUpstream({
          cwd: input.cwd,
          branch: localBranch,
          remoteName,
          remoteBranch,
        });
        yield* Effect.scoped(git.switchRef({ cwd: input.cwd, refName: localBranch }));
      }).pipe(
        Effect.mapError((cause) =>
          isBitbucketApiError(cause)
            ? cause
            : new BitbucketCheckoutError({
                cwd: input.cwd,
                reference: input.reference,
                cause,
              }),
        ),
      ),
  });

  const readDataCenter = <S extends Schema.Top>(url: string, schema: S) =>
    request({ method: "GET", url }).pipe(
      Effect.flatMap((response) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(response.body),
      ),
      Effect.mapError((cause): BitbucketApiError =>
        isBitbucketApiError(cause)
          ? cause
          : new BitbucketResponseDecodeError({ operation: "request", status: 200, cause }),
      ),
    );
  const repositoryPath = (locator: BitbucketRepositoryLocator) =>
    dataCenterRepositoryPath(locator.workspace, locator.repoSlug);
  const dcRawPullRequest = (input: Parameters<BitbucketApi["Service"]["getPullRequest"]>[0]) =>
    resolveRepository(input).pipe(
      Effect.flatMap((locator) =>
        readDataCenter(
          `${repositoryPath(locator)}/pull-requests/${encodeURIComponent(normalizeChangeRequestId(input.reference))}`,
          DataCenterPullRequest,
        ),
      ),
    );
  const dataCenter: BitbucketApi["Service"] = {
    request,
    getServerUrl,
    probeAuth: getServerUrl.pipe(
      Effect.flatMap((server) =>
        request({ method: "GET", url: "/rest/api/1.0/repos?limit=1" }).pipe(
          Effect.map((response): SourceControlProviderAuth => ({
            status:
              response.account && response.account !== "anonymous" ? "authenticated" : "unknown",
            account: nonEmpty(response.account),
            host: nonEmpty(server ? new URL(server).host : undefined),
            detail: Option.none(),
          })),
          Effect.catch((error) =>
            currentCredential.pipe(
              Effect.map((credential) => ({
                ...authFromCredential(credential),
                ...(error._tag === "BitbucketResponseError" && error.status === 401
                  ? {
                      status: "unauthenticated" as const,
                      detail: Option.some("Bitbucket rejected the configured credentials."),
                    }
                  : {}),
                host: nonEmpty(server ? new URL(server).host : undefined),
              })),
            ),
          ),
        ),
      ),
      Effect.catch(() =>
        Effect.succeed({
          status: "unknown" as const,
          account: Option.none(),
          host: Option.none(),
          detail: Option.some(new BitbucketServerUrlError().detail),
        }),
      ),
    ),
    getRepositoryCloneUrls: (input) =>
      resolveRepository(input).pipe(
        Effect.flatMap((locator) => readDataCenter(repositoryPath(locator), DataCenterRepository)),
        Effect.map(dataCenterCloneUrls),
      ),
    createRepository: (input) =>
      Effect.gen(function* () {
        const locator = yield* resolveRepository(input);
        const response = yield* request({
          method: "POST",
          url: `/rest/api/1.0/projects/${encodeURIComponent(locator.workspace)}/repos`,
          body: encodeDataCenterBody({
            name: locator.repoSlug,
            scmId: "git",
            public: input.visibility === "public",
          }),
        });
        const raw = yield* decodeDataCenterRepository(response.body).pipe(
          Effect.mapError(
            (cause) =>
              new BitbucketResponseDecodeError({
                operation: "createRepository",
                status: 201,
                cause,
              }),
          ),
        );
        return dataCenterCloneUrls(raw);
      }),
    getDefaultBranch: (input) =>
      resolveRepository(input).pipe(
        Effect.flatMap((locator) =>
          readDataCenter(
            `${repositoryPath(locator)}/branches/default`,
            Schema.Struct({ displayId: Schema.String }),
          ),
        ),
        Effect.map((branch) => branch.displayId),
      ),
    getPullRequest: (input) => dcRawPullRequest(input).pipe(Effect.map(dataCenterSummary)),
    listPullRequests: (input) =>
      Effect.gen(function* () {
        const locator = yield* resolveRepository(input);
        const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
        const matches: NormalizedBitbucketPullRequestRecord[] = [];
        let start = 0;
        for (let page = 0; page < 10; page++) {
          const params = new URLSearchParams({
            state:
              input.state === "all"
                ? "ALL"
                : input.state === "closed"
                  ? "DECLINED"
                  : input.state.toUpperCase(),
            direction: "INCOMING",
            limit: "100",
            start: String(start),
          });
          const list = yield* readDataCenter(
            `${repositoryPath(locator)}/pull-requests?${params}`,
            dataCenterPage(DataCenterPullRequest),
          );
          for (const pr of list.values) {
            const owner = sourceWorkspace(input);
            if (pr.fromRef.displayId !== SourceControlProvider.sourceBranch(input)) continue;
            if (owner && pr.fromRef.repository.project.key.toLowerCase() !== owner.toLowerCase())
              continue;
            if (input.source?.repository && pr.fromRef.repository.slug !== input.source.repository)
              continue;
            matches.push(dataCenterSummary(pr));
          }
          if (matches.length >= limit || list.isLastPage) return matches.slice(0, limit);
          if (list.nextPageStart === undefined || list.nextPageStart <= start)
            return yield* new BitbucketResponseDecodeError({
              operation: "listPullRequests",
              status: 200,
              cause: new Error("Non-advancing Data Center page"),
            });
          start = list.nextPageStart;
        }
        return matches.slice(0, limit);
      }),
    createPullRequest: (input) =>
      Effect.gen(function* () {
        const locator = yield* resolveRepository(input);
        const description = yield* fileSystem.readFileString(input.bodyFile).pipe(
          Effect.mapError(
            (cause) =>
              new BitbucketPullRequestBodyReadError({
                cwd: input.cwd,
                bodyFile: input.bodyFile,
                cause,
              }),
          ),
        );
        yield* request({
          method: "POST",
          url: `${repositoryPath(locator)}/pull-requests`,
          body: encodeDataCenterBody({
            title: input.title,
            description,
            fromRef: {
              id: `refs/heads/${SourceControlProvider.sourceBranch(input)}`,
              repository: {
                slug: input.source?.repository ?? locator.repoSlug,
                project: { key: sourceWorkspace(input) ?? locator.workspace },
              },
            },
            toRef: {
              id: `refs/heads/${input.target?.refName ?? input.baseBranch}`,
              repository: { slug: locator.repoSlug, project: { key: locator.workspace } },
            },
          }),
        });
      }),
    checkoutPullRequest: (input) =>
      Effect.gen(function* () {
        const pr = yield* dcRawPullRequest(input);
        const sourceName = dataCenterRepositoryName(pr.fromRef.repository);
        const destinationName = dataCenterRepositoryName(pr.toRef.repository);
        const source = pr.fromRef.repository;
        const urls = yield* readDataCenter(
          dataCenterRepositoryPath(source.project.key, source.slug),
          DataCenterRepository,
        ).pipe(Effect.map(dataCenterCloneUrls));
        const origin = yield* readConfigValueNullable(input.cwd, "remote.origin.url");
        const remoteName =
          input.context && sourceName === destinationName
            ? input.context.remoteName
            : yield* git.ensureRemote({
                cwd: input.cwd,
                preferredName: source.project.key,
                url: selectCloneUrl({ cloneUrls: urls, originRemoteUrl: origin }),
              });
        const localBranch = checkoutBranchName({
          pullRequestId: pr.id,
          headBranch: pr.fromRef.displayId,
          isCrossRepository: sourceName !== destinationName,
        });
        const branches = yield* git.listLocalBranchNames(input.cwd);
        if (input.force || !branches.includes(localBranch))
          yield* git.fetchRemoteBranch({
            cwd: input.cwd,
            remoteName,
            remoteBranch: pr.fromRef.displayId,
            localBranch,
          });
        else
          yield* git.fetchRemoteTrackingBranch({
            cwd: input.cwd,
            remoteName,
            remoteBranch: pr.fromRef.displayId,
          });
        yield* git.setBranchUpstream({
          cwd: input.cwd,
          branch: localBranch,
          remoteName,
          remoteBranch: pr.fromRef.displayId,
        });
        yield* Effect.scoped(git.switchRef({ cwd: input.cwd, refName: localBranch }));
      }).pipe(
        Effect.mapError((cause): BitbucketApiError =>
          isBitbucketApiError(cause)
            ? cause
            : new BitbucketCheckoutError({ cwd: input.cwd, reference: input.reference, cause }),
        ),
      ),
  };

  const route = <A>(
    cloudEffect: Effect.Effect<A, BitbucketApiError>,
    nativeEffect: Effect.Effect<A, BitbucketApiError>,
  ) => getServerUrl.pipe(Effect.flatMap((server) => (server ? nativeEffect : cloudEffect)));
  return BitbucketApi.of({
    request,
    getServerUrl,
    probeAuth: route(cloud.probeAuth, dataCenter.probeAuth).pipe(
      Effect.catch(() => dataCenter.probeAuth),
    ),
    listPullRequests: (input) =>
      route(cloud.listPullRequests(input), dataCenter.listPullRequests(input)),
    getPullRequest: (input) => route(cloud.getPullRequest(input), dataCenter.getPullRequest(input)),
    getRepositoryCloneUrls: (input) =>
      route(cloud.getRepositoryCloneUrls(input), dataCenter.getRepositoryCloneUrls(input)),
    createRepository: (input) =>
      route(cloud.createRepository(input), dataCenter.createRepository(input)),
    createPullRequest: (input) =>
      route(cloud.createPullRequest(input), dataCenter.createPullRequest(input)),
    getDefaultBranch: (input) =>
      route(cloud.getDefaultBranch(input), dataCenter.getDefaultBranch(input)),
    checkoutPullRequest: (input) =>
      route(cloud.checkoutPullRequest(input), dataCenter.checkoutPullRequest(input)),
  });
});

export const layer = Layer.effect(BitbucketApi, make);
