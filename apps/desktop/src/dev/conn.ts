/**
 * Dev-only: the small slice of a SQLite connection the Rust ports need, so the
 * same code runs on sql.js in the browser harness and on node:sqlite in tests.
 */
export type SqlScalar = string | number | null | Uint8Array;
export type DbRow = Record<string, SqlScalar>;

export interface Conn {
  /** Every row a statement returns, as objects keyed by column name. */
  all(sql: string, params?: SqlScalar[]): DbRow[];
  /** Runs one statement; returns the new rowid of an INSERT. */
  run(sql: string, params?: SqlScalar[]): { lastInsertRowid: number };
  /** Runs one or more statements without parameters. */
  exec(sql: string): void;
}

/** The first row, or undefined. */
export function first(conn: Conn, sql: string, params: SqlScalar[] = []): DbRow | undefined {
  return conn.all(sql, params)[0];
}

/** Runs `work` in a transaction (rusqlite's `conn.transaction()` + commit). */
export function inTransaction<T>(conn: Conn, work: () => T): T {
  conn.exec("SAVEPOINT harness");
  try {
    const result = work();
    conn.exec("RELEASE harness");
    return result;
  } catch (error) {
    conn.exec("ROLLBACK TO harness");
    conn.exec("RELEASE harness");
    throw error;
  }
}

/** The structural part of sql.js's Database this adapter uses. */
export interface SqlJsLike {
  prepare(sql: string): {
    bind(values: SqlScalar[]): boolean;
    step(): boolean;
    getAsObject(): Record<string, SqlScalar>;
    free(): boolean;
  };
  run(sql: string, params?: SqlScalar[]): unknown;
  exec(sql: string): unknown;
}

export function sqlJsConn(db: SqlJsLike): Conn {
  const all = (sql: string, params: SqlScalar[] = []) => {
    const statement = db.prepare(sql);
    try {
      statement.bind(params);
      const rows: DbRow[] = [];
      while (statement.step()) rows.push(statement.getAsObject());
      return rows;
    } finally {
      statement.free();
    }
  };
  return {
    all,
    run: (sql, params = []) => {
      db.run(sql, params);
      const id = all("SELECT last_insert_rowid() AS id")[0]?.id;
      return { lastInsertRowid: Number(id ?? 0) };
    },
    exec: (sql) => void db.exec(sql),
  };
}

/** The structural part of node:sqlite's DatabaseSync (tests). */
export interface NodeSqliteLike {
  prepare(sql: string): {
    all(...params: SqlScalar[]): unknown[];
    run(...params: SqlScalar[]): { lastInsertRowid: number | bigint };
  };
  exec(sql: string): void;
}

export function nodeConn(db: NodeSqliteLike): Conn {
  return {
    all: (sql, params = []) => db.prepare(sql).all(...params) as DbRow[],
    run: (sql, params = []) => ({
      lastInsertRowid: Number(db.prepare(sql).run(...params).lastInsertRowid),
    }),
    exec: (sql) => db.exec(sql),
  };
}
