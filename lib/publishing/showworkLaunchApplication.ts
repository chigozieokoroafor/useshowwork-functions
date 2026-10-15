/** Reviewed actual-handler composition. Construction does not install or activate it. */
import {createShowworkPublishingApplication} from './showworkApplication';
import {POST as subscribe} from '@/app/api/calendars/subscribe/route';
import {POST as cancelSubscription} from '@/app/api/calendars/cancel-subscription/route';
import {POST as upgrade} from '@/app/api/calendars/upgrade-to-company/route';
import {POST as downgrade} from '@/app/api/calendars/downgrade-to-individual/route';
import {POST as verify} from '@/app/api/calendars/verify-subscription/route';
import {POST as verifyWorkspace} from '@/app/api/calendars/[id]/verify-subscription/route';
import {POST as retryPayment} from '@/app/api/calendars/[id]/retry-payment/route';
import {POST as createWorkspace} from '@/app/api/calendars/route';
import {POST as webhook} from '@/app/api/payments/webhook/route';
import {PATCH as adminCreator} from '@/app/api/admin/creators/[id]/route';
import {POST as stopComplimentary} from '@/app/api/admin/creators/[id]/complimentary/route';
import {PATCH as adminWorkspace} from '@/app/api/admin/social-calendars/[id]/route';
import {PATCH as adminLegacyWorkspace} from '@/app/admin/social-calendars/[id]/route';
import {PATCH as adminPartner} from '@/app/api/admin/partners/[id]/route';
import {POST as offer, PATCH as revokeOffer, PUT as retryOfferEmail} from '@/app/api/admin/billing-offers/route';
import {DELETE as deleteMedia} from '@/app/api/media/[mediaId]/route';
import {POST as replaceMedia} from '@/app/api/media/[mediaId]/replace/complete/route';
import {POST as replaceMultipart} from '@/app/api/media/[mediaId]/replace/multipart-complete/route';
import {DELETE as deletePortfolioMedia} from '@/app/api/portfolio/media/[mediaId]/route';
import {DELETE as deletePortfolioSection} from '@/app/api/portfolio/sections/[sectionId]/route';
import {DELETE as deleteSection} from '@/app/api/sections/[sectionId]/route';
import {DELETE as deleteAttachment} from '@/app/api/managed-projects/[id]/brief-attachments/[attachmentId]/route';
import {DELETE as deleteBusinessDocument} from '@/app/api/calendars/[id]/business-documents/[documentId]/route';
import {createOriginalMediaCleanup} from './originalMediaCleanup';
import type {createPublishingObjectStorage} from './objectStorageAdapters';

type Base=Parameters<typeof createShowworkPublishingApplication>[0];
export function createShowworkLaunchApplication(input:Omit<Base,'nativePolicy'|'nativePolicyHandlers'|'nativeReadHandlers'|'storage'>&{
 nativePolicy:Omit<NonNullable<Base['nativePolicy']>,'handlers'|'cleanupOriginals'|'completeMultipartUpload'>;
 storage:ReturnType<typeof createPublishingObjectStorage>;
}){
 if(input.publishingEnabled!==false||!input.accountFetch||!input.nativePolicy?.prisma||!input.nativePolicy.billingFetch||!input.nativePolicy.notify||!input.storage?.deleteOriginalVersion||!input.storage.completeOriginalMultipart)throw Error('LAUNCH_DEPENDENCY_CONFIGURATION_REQUIRED');
 const handlers={
  'app/api/calendars/[id]/business-documents/[documentId]/route.ts#DELETE@14':deleteBusinessDocument,
  'app/api/calendars/subscribe/route.ts#POST@46':subscribe,
  'app/api/calendars/cancel-subscription/route.ts#POST@16':cancelSubscription,
  'app/api/calendars/upgrade-to-company/route.ts#POST@39':upgrade,
  'app/api/calendars/downgrade-to-individual/route.ts#POST@32':downgrade,
  'app/api/calendars/verify-subscription/route.ts#POST@23':verify,
  'app/api/calendars/[id]/verify-subscription/route.ts#POST@24':verifyWorkspace,
  'app/api/calendars/[id]/retry-payment/route.ts#POST@38':retryPayment,
  'app/api/calendars/route.ts#POST@122':createWorkspace,
  'app/api/payments/webhook/route.ts#POST@115':webhook,
  'app/api/admin/creators/[id]/route.ts#PATCH@12':adminCreator,
  'app/api/admin/creators/[id]/complimentary/route.ts#POST@9':stopComplimentary,
  'app/api/admin/social-calendars/[id]/route.ts#PATCH@20':adminWorkspace,
  'app/admin/social-calendars/[id]/route.ts#PATCH@22':adminLegacyWorkspace,
  'app/api/admin/partners/[id]/route.ts#PATCH@55':adminPartner,
  'app/api/admin/billing-offers/route.ts#POST@42':offer,
  'app/api/admin/billing-offers/route.ts#PATCH@98':revokeOffer,
  'app/api/admin/billing-offers/route.ts#PUT@136':retryOfferEmail,
  'app/api/media/[mediaId]/route.ts#DELETE@17':deleteMedia,
  'app/api/media/[mediaId]/replace/complete/route.ts#POST@11':replaceMedia,
  'app/api/media/[mediaId]/replace/multipart-complete/route.ts#POST@16':replaceMultipart,
  'app/api/portfolio/media/[mediaId]/route.ts#DELETE@8':deletePortfolioMedia,
  'app/api/portfolio/sections/[sectionId]/route.ts#DELETE@52':deletePortfolioSection,
  'app/api/sections/[sectionId]/route.ts#DELETE@43':deleteSection,
  'app/api/managed-projects/[id]/brief-attachments/[attachmentId]/route.ts#DELETE@7':deleteAttachment,
 };
 const cleanupOriginals=createOriginalMediaCleanup({database:input.database,storage:input.storage});
 return createShowworkPublishingApplication({...input,cleanupOriginals,nativePolicy:{...input.nativePolicy,handlers,cleanupOriginals,completeMultipartUpload:input.storage.completeOriginalMultipart}});
}
