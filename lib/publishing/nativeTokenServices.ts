import type {SocialConnection} from '@prisma/client';
import {publishingFetch as fetch} from './executionContext';
export function requireScopes(connection: Pick<SocialConnection, "tokenScopes" | "platform">, required: string[]) {
  const scopes = new Set((connection.tokenScopes || "").split(/[\s,]+/));
  const missing = required.filter(scope => !scopes.has(scope));
  if (missing.length) throw new Error(`${connection.platform} permission is missing (${missing.join(", ")}). Reconnect after enabling access in the developer app.`);
}
export async function requestSocialTokenRefresh(platform:'X'|'LINKEDIN',refreshToken:string){
 const isX=platform==='X',clientId=isX?process.env.X_CLIENT_ID:process.env.LINKEDIN_CLIENT_ID,clientSecret=isX?process.env.X_CLIENT_SECRET:process.env.LINKEDIN_CLIENT_SECRET;
 if(!clientId||!clientSecret||!refreshToken)throw Error('Refresh credentials are missing. Reconnect the account.');
 const body=new URLSearchParams({grant_type:'refresh_token',refresh_token:refreshToken,client_id:clientId});if(!isX)body.set('client_secret',clientSecret);
 const response=await fetch(isX?'https://api.x.com/2/oauth2/token':'https://www.linkedin.com/oauth/v2/accessToken',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',...(isX?{Authorization:`Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`}:{})},body,signal:AbortSignal.timeout(30000)});
 const result=await response.json();if(!response.ok||!result.access_token||!Number.isFinite(result.expires_in)||result.expires_in<=0)throw Error('The connection could not be renewed. Reconnect.');return result as {access_token:string;expires_in:number;refresh_token?:string;refresh_token_expires_in?:number;scope?:string};
}
