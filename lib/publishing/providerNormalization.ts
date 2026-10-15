import type { LookupOperation, MockProviderResponse } from './capabilityProviders';
/** Successful lookups prove only the exact requested reference, never absence/no-send. */
export function normalizeProviderLookup(operation: LookupOperation, reference: string, response: MockProviderResponse): MockProviderResponse {
 const body = response.body;
 if (response.status < 200 || response.status >= 300) return response;
 if (operation === 'TT_STATUS') return {...response, body:{...body, status:body.data?.status ?? body.status}};
 if (operation === 'FB_VIDEO_STATUS') return {...response, body:{...body, video_status:body.status?.video_status ?? body.video_status, publishing_status:body.status?.publishing_phase?.status ?? body.publishing_status}};
 if (operation === 'IG_PERMALINK') return {...response, body:{...body, verified:body.id === reference && typeof body.permalink === 'string' && /^https:\/\//.test(body.permalink)}};
 if (operation === 'LI_POST_GET') return {...response, body:{...body, verified:body.id === reference && body.lifecycleState === 'PUBLISHED'}};
 if (operation === 'X_TWEET_GET') return {...response, body:{...body, verified:body.data?.id === reference}};
 return response;
}
