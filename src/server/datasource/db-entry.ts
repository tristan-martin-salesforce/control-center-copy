/**
 * The db DataSource's entry (R7 step 5). datasource/index.ts loads this module only when CC_DATA=db, so a process
 * (or a test) on the mock never loads pg, drizzle or the job queue through getDataSource().
 */
export { createDbDataSource } from './db';
