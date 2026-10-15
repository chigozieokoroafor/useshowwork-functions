import { Prisma, PrismaClient } from "@prisma/client";
import { verifyTransaction } from "@/lib/paystack";
import { classifyPaymentRevenue } from "@/lib/paymentRevenue";
import {scopedApplicationDatabase} from '@/lib/publishing/nativeApplicationContext';
import {createHash} from 'node:crypto';

// Native billing/auth policies and the canonical SQL adapter must use the same
// reviewed database. Do not let two independently configured URLs split writes.
function canonicalApplicationDatasource(){
  if(process.env.SHOWWORK_CANONICAL_APPLICATION_ENABLED!=='true')return undefined;
  if(!process.env.PUBLISHING_DATABASE_URL)throw Error('CANONICAL_APPLICATION_DATABASE_REQUIRED');
  const url=new URL(process.env.PUBLISHING_DATABASE_URL);
  url.searchParams.set('schema',process.env.PUBLISHING_DATABASE_SCHEMA??'public');
  return url.toString();
}
const canonicalDatasource=canonicalApplicationDatasource();

function createDatabase() {
  const client = new PrismaClient(canonicalDatasource?{datasources:{db:{url:canonicalDatasource}}}:undefined);
  client.$use(async (params, next) => {
    if (params.model === "PaymentRecord" && params.action === "create") {
      let verification = null;
      if (params.args.data.paystackReference) {
        try {
          verification = await verifyTransaction(
            params.args.data.paystackReference,
          );
        } catch {
          // Preserve the charge for reconciliation without inflating revenue.
        }
      }
      Object.assign(
        params.args.data,
        classifyPaymentRevenue(params.args.data, verification),
      );
    }
    return next(params);
  });
  return client;
}

// A generated schema can change while Next's development process retains globals.
// Reuse the connection pool only when it was built for this schema.
const schemaSignature = JSON.stringify({
  canonicalDatasource:canonicalDatasource?createHash('sha256').update(canonicalDatasource).digest('hex'):null,
  models: Prisma.dmmf.datamodel.models.map(model => ({
    name: model.name,
    fields: model.fields.map(field => ({ name: field.name, type: field.type, kind: field.kind, isList: field.isList, isRequired: field.isRequired })),
  })),
  enums: Prisma.dmmf.datamodel.enums.map(value => ({ name: value.name, values: value.values.map(entry => entry.name) })),
});
const globalForPrisma = globalThis as unknown as {
  revenuePrisma?: ReturnType<typeof createDatabase>;
  revenuePrismaSchema?: string;
};
const cached = globalForPrisma.revenuePrisma;
const cacheMatches = cached && globalForPrisma.revenuePrismaSchema === schemaSignature
  && !!cached.billingOfferSubscription && !!cached.billingOfferRedemption && !!cached.billingOffer && !!cached.billingBenefitNotification && !!cached.calendarTeamActivity;
const nativeDatabase = cacheMatches ? cached : createDatabase();
/** Trusted bootstrap receives the original client, avoiding recursively scoped facades. */
export const nativeApplicationDatabase = nativeDatabase;
export const db = scopedApplicationDatabase(nativeDatabase);
if (process.env.NODE_ENV !== "production") {
  globalForPrisma.revenuePrisma = nativeDatabase;
  globalForPrisma.revenuePrismaSchema = schemaSignature;
  if (cached && !cacheMatches) void cached.$disconnect().catch(() => {});
}
