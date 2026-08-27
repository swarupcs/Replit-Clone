/** Why a database request failed, in a form the controller can turn into a
 *  status code.
 *
 *  In its own module so the Postgres and Mongo services can both throw it
 *  without importing each other: `databaseQueryService` owns the connection
 *  record and has to be able to close a Mongo client when that record
 *  changes, and that only stays a one-way dependency if the error type does
 *  not live in either service.
 */
export class DatabaseQueryError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "DatabaseQueryError";
  }
}
