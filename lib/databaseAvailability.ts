/** Retry only reads or explicitly idempotent status writes, never model calls or draft insertion. */
export function databaseUnavailable(error: unknown) {
    const code=error && typeof error==='object' && 'code' in error ? String(error.code) : '';
    return ['P1001','P1002','P1017','P2024'].includes(code);
}
export async function retryDatabaseRead<T>(operation:()=>Promise<T>):Promise<T> {
    try{return await operation();}catch(error){
        if(!databaseUnavailable(error))throw error;
        await new Promise(resolve=>setTimeout(resolve,200));
        return operation();
    }
}

