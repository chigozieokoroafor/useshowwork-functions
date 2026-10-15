import type { Prisma, PrismaClient } from "@prisma/client";
import type { Pool } from "pg";

/** Trusted composition only: no environment loading or request-selected target.
 * Parameterized, unnamed single statements avoid Prisma's PgBouncer reset
 * protocol. Native ORM transactions keep the existing budget and connection. */
export function createCoordinatorDatabase(native: Pick<PrismaClient, "$transaction">, pool: Pick<Pool, "query">) {
  const query = async <T,>(sql: Prisma.Sql): Promise<T> => {
    if (!sql || typeof sql.text !== "string" || !Array.isArray(sql.values)) throw new Error("Parameterized SQL required");
    try {
      const result = await pool.query({ text: sql.text, values: sql.values.map(value => value instanceof Date ? value.toISOString() : value) });
      return result.rows as T;
    } catch (cause) {
      const sqlState = (cause as { code?: string }).code;
      throw Object.assign(new Error("Publishing coordinator database operation failed"), { code: sqlState && /^[0-9A-Z]{5}$/.test(sqlState) ? "P2010" : "P1017", sqlState, cause });
    }
  };
  return { $queryRaw: query as PrismaClient["$queryRaw"], $transaction: native.$transaction.bind(native) };
}
