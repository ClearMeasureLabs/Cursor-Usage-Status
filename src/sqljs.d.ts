declare module 'sql.js' {
  export type SqlStatement = {
    bind(values: unknown[]): void;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): void;
  };

  export type SqlDatabase = {
    prepare(sql: string): SqlStatement;
    close(): void;
  };

  export type SqlJsStatic = {
    Database: new (data?: ArrayBuffer | Uint8Array) => SqlDatabase;
  };

  type InitOptions = {
    wasmBinary?: Buffer | Uint8Array;
    locateFile?: (file: string) => string;
  };

  type InitSqlJs = (opts?: InitOptions) => Promise<SqlJsStatic>;

  const initSqlJs: InitSqlJs;
  export default initSqlJs;
}
