/** Retry a read once when the database connection briefly drops. Never use for writes. */
export async function retryDatabaseRead<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code !== "P1001" && code !== "P1017") throw error;
    await new Promise<void>(resolve => setTimeout(resolve, 200));
    return read();
  }
}
