import type {OwnershipDatabase} from './ownership';
import type {createPublishingObjectStorage} from './objectStorageAdapters';
/** Existing upload reservations and same-workspace attachment, physical proof
 * obtained from server storage instead of a client hash/version assertion. */
export function createCanonicalShowworkUploadVerifier(deps:{database:OwnershipDatabase;storage:Pick<ReturnType<typeof createPublishingObjectStorage>,'verifySource'>}) {
 return async(raw:unknown)=>{
  const request=raw as {calendarId:string;postId:string;actor:string;upload:{reservationId?:string;fileKey?:string;sourcePostId?:string}};
  const source=await deps.database.transaction(async tx=>{
   const owner=(await tx.query(`SELECT "managerId" FROM "SocialCalendar" WHERE id=$1`,[request.calendarId])).rows[0];if(!owner)throw Error('WORKSPACE_MISSING');
   if(request.upload.sourcePostId){const asset=(await tx.query(`SELECT a.* FROM "CalendarPostAsset" a JOIN "CalendarPost" p ON p.id=a."postId" WHERE p.id=$1 AND p."calendarId"=$2 AND a."fileKey"=$3 ORDER BY a.id LIMIT 1`,[request.upload.sourcePostId,request.calendarId,request.upload.fileKey])).rows[0];if(!asset)throw Error('SOURCE_ASSET_WORKSPACE_MISMATCH');return {asset,reservation:null};}
   const reservation=(await tx.query(`SELECT *,"expiresAt">clock_timestamp() AS live FROM "ContentWorkspaceStorageReservation" WHERE id=$1 AND "calendarId"=$2 AND "creatorId"=$3 AND "fileKey"=$4`,[request.upload.reservationId,request.calendarId,owner.managerId,request.upload.fileKey])).rows[0];
   if(!reservation||!['PENDING','COMPLETED'].includes(reservation.status)||reservation.status==='PENDING'&&!reservation.live||!reservation.fileKey.startsWith(`calendars/${request.calendarId}/${request.postId}/`))throw Error('UPLOAD_RESERVATION_INVALID');return {reservation,asset:null};
  });
  const fileKey=source.asset?.fileKey??source.reservation!.fileKey,proof=await deps.storage.verifySource(fileKey,source.asset?.objectVersion??undefined);
  if(source.asset?.contentSha256&&source.asset.contentSha256!==proof.contentSha256)throw Error('SOURCE_ASSET_CHANGED');
  if(source.reservation&&String(source.reservation.bytes)!==proof.sizeBytes)throw Error('UPLOAD_RESERVATION_SIZE_MISMATCH');
  return {...proof,fileKey,verifiedFor:{calendarId:request.calendarId,postId:request.postId},...(source.reservation?{reservationId:source.reservation.id}:{sourceAssetId:source.asset!.id,sourcePostId:source.asset!.postId})};
 };
}
