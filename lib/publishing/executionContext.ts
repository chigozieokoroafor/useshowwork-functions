import { publishingIntegrationInstalled, assertLegacyPublishingAllowed, publishingRetentionRequired } from "./applicationBoundary";
import { AsyncLocalStorage } from "node:async_hooks";

type Context = {
  signal: AbortSignal;
  postId?: string;
  jobId?: string;
  workerToken?: string | null;
  beforePublication?: () => void | Promise<void>;
  publicationResponse?: (value: { rejected: boolean; status: number; reference: string | null }) => void;
};
const execution = new AsyncLocalStorage<Context>();
const auxiliary=new AsyncLocalStorage<{fetch:typeof globalThis.fetch;signal:AbortSignal}>();
/** Trusted account IO only; cannot reach a publication or media-create endpoint. */
export function withPublishingAccountIO<T>(input:{fetch:typeof globalThis.fetch;signal:AbortSignal},run:()=>Promise<T>){return auxiliary.run(input,run);}
export const publishingAccountIOActive=()=>auxiliary.getStore()!==undefined;
export function withPublishingExecution<T>(context: Context, operation: () => Promise<T>) { return execution.run(context, operation); }
export const currentPublishingSignal = () => execution.getStore()?.signal;
export const currentPublishingPostId = () => execution.getStore()?.postId;
export const currentPublishingOwner = () => {
  const value = execution.getStore();
  return value?.jobId && value.workerToken ? { id: value.jobId, token: value.workerToken } : null;
};

/** Existing callers outside a durable worker use the original fetch behavior.
 * No request headers, bodies, tokens or customer content are recorded here. */
export async function publishingFetch(input: string | URL | Request, init?: RequestInit) {
  // Intended VPS release permanently retires the legacy transport's post-create
  // endpoints. Canonical submission uses providerHttpAdapter with a durably
  // consumed, exact invocation authorization; this helper cannot obtain one.
  const legacyUrl = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const legacyMethod = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const legacyHeaders = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const legacyMutation = legacyMethod !== "GET" && legacyMethod !== "HEAD" || legacyHeaders.has("x-http-method-override") || [...legacyUrl.searchParams.keys()].some(k => k.toLowerCase().includes("method"));
  let legacyPayload: Record<string, unknown> = {};
  if (typeof init?.body === "string") { try { const parsed = JSON.parse(init.body); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) legacyPayload = parsed; } catch { /* Unknown payload never proves preparation-only. */ } }
  const retiredCreation = legacyUrl.hostname === "graph.facebook.com" && (
    legacyUrl.pathname.endsWith("/media_publish") || legacyUrl.pathname.endsWith("/feed") ||
    legacyUrl.pathname.endsWith("/photos") && legacyPayload.published !== false ||
    legacyUrl.pathname.endsWith("/video_reels") && legacyPayload.upload_phase !== "start"
  ) || legacyUrl.hostname === "graph-video.facebook.com" && legacyUrl.pathname.endsWith("/videos") ||
    legacyUrl.hostname === "api.x.com" && legacyUrl.pathname === "/2/tweets" ||
    legacyUrl.hostname === "api.linkedin.com" && legacyUrl.pathname === "/rest/posts" ||
    legacyUrl.hostname === "open.tiktokapis.com" && /\/post\/publish\/(content|video)\/init\/?$/.test(legacyUrl.pathname);
  if (legacyMutation && retiredCreation) throw Error(auxiliary.getStore() ? "ACCOUNT_IO_ENDPOINT_DENIED" : "LEGACY_PUBLICATION_TRANSPORT_RETIRED");
  const accountIO=auxiliary.getStore();
  if(accountIO){
    const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url),method=(init?.method??(input instanceof Request?input.method:'GET')).toUpperCase();
    const overrides=[...url.searchParams.keys()].some(k=>k.toLowerCase().includes('method'))||new Headers(init?.headers??(input instanceof Request?input.headers:undefined)).has('x-http-method-override');
    const allowed=!overrides&&url.protocol==='https:'&&!url.username&&!url.password&&(
      url.hostname==='graph.facebook.com'&&method==='GET'&&/^\/v\d+\.\d+\/(oauth\/access_token|me\/(accounts|permissions)|[0-9]+)$/.test(url.pathname)||
      url.hostname==='api.x.com'&&(method==='POST'&&url.pathname==='/2/oauth2/token'||method==='GET'&&url.pathname==='/2/users/me')||
      url.hostname==='www.linkedin.com'&&method==='POST'&&url.pathname==='/oauth/v2/accessToken'||url.hostname==='api.linkedin.com'&&method==='GET'&&(url.pathname==='/v2/userinfo'||/^\/rest\/(organizationAcls|organizations\/\d+)$/.test(url.pathname))||
      url.hostname==='open.tiktokapis.com'&&(method==='POST'&&url.pathname==='/v2/oauth/token/'||method==='GET'&&url.pathname==='/v2/user/info/'||method==='POST'&&url.pathname==='/v2/post/publish/creator_info/query/')
    );
    if(!allowed)throw Error('ACCOUNT_IO_ENDPOINT_DENIED');
    accountIO.signal.throwIfAborted();return accountIO.fetch(input,{...init,redirect:'error',signal:AbortSignal.any([accountIO.signal,AbortSignal.timeout(30000),...(init?.signal?[init.signal]:[])])});
  }
  // Existing inbox/analytics operations are not feed publication. Allow only
  // reviewed provider paths; no redirects, method overrides or media creation.
  const auxiliaryRead=legacyMethod==='GET'&&(
    legacyUrl.hostname==='api.x.com'&&/^\/2\/(users\/(me|by\/username\/[^/]+|[^/]+(?:\/tweets)?)|tweets|dm_events|dm_conversations\/with\/[^/]+\/dm_events)$/.test(legacyUrl.pathname)||
    legacyUrl.hostname==='api.linkedin.com'&&legacyUrl.pathname==='/rest/memberCreatorPostAnalytics'
  );
  const directMessage=legacyMethod==='POST'&&legacyUrl.hostname==='api.x.com'&&/^\/2\/dm_conversations\/with\/[^/]+\/messages$/.test(legacyUrl.pathname);
  if(publishingRetentionRequired()&&legacyUrl.protocol==='https:'&&!legacyUrl.username&&!legacyUrl.password&&!legacyHeaders.has('x-http-method-override')&&![...legacyUrl.searchParams.keys()].some(k=>k.toLowerCase().includes('method'))&&(auxiliaryRead||directMessage)){
    return globalThis.fetch(input,{...init,redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(30000),...(init?.signal?[init.signal]:[])])});
  }
  if (publishingIntegrationInstalled()) await assertLegacyPublishingAllowed("lib/publishing/executionContext.ts#egress");
  const context = execution.getStore();
  if (!context) return globalThis.fetch(input, { ...init, redirect: "error" });
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const body = typeof init?.body === "string" ? init.body : "";
  const publication = method === "POST" && (
    url.hostname === "graph.facebook.com" && (url.pathname.endsWith("/media_publish") || url.pathname.endsWith("/feed") || url.pathname.endsWith("/video_reels") && body.includes('"finish"')) ||
    url.hostname === "graph-video.facebook.com" && url.pathname.endsWith("/videos") ||
    url.hostname === "api.x.com" && url.pathname === "/2/tweets" ||
    url.hostname === "api.linkedin.com" && url.pathname === "/rest/posts" ||
    url.hostname === "open.tiktokapis.com" && /\/post\/publish\/(content|video)\/init\/$/.test(url.pathname)
  );
  context.signal.throwIfAborted();
  if (publication) await context.beforePublication?.();
  const originalSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const response = await globalThis.fetch(input, { ...init, redirect: "error", signal: originalSignal ? AbortSignal.any([context.signal, originalSignal]) : context.signal });
  if (publication) {
    const value = await response.clone().json().catch(() => null);
    const providerError = value?.error && (url.hostname !== "open.tiktokapis.com" || value.error.code !== "ok");
    const reference = response.headers.get("x-restli-id") ?? value?.data?.publish_id ?? value?.post_id ?? value?.data?.id ?? value?.id ?? null;
    context.publicationResponse?.({ rejected: response.status < 500 && (!response.ok || !!providerError), status: response.status, reference: typeof reference === "string" ? reference : null });
  }
  return response;
}
