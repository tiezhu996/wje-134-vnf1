export const PG_UNIQUE_VIOLATION = '23505';

interface PostgresErrorLike {
  code?: string;
  constraint?: string;
}

/**
 * 判断异常是否为指定约束（或任意唯一约束）触发的唯一键冲突，
 * 用于把并发写入导致的数据库级拒绝转换成 409，而不是 500。
 */
export function isUniqueViolation(error: unknown, constraintName?: string): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const pgError = error as PostgresErrorLike;
  if (pgError.code !== PG_UNIQUE_VIOLATION) {
    return false;
  }

  return !constraintName || pgError.constraint === constraintName;
}
