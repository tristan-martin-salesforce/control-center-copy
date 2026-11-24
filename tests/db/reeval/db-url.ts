/** The lane database: control_center_bereeval_<CC_TEST_DB_SUFFIX|main> (or BEREEVAL_DATABASE_URL). */
const suffix = (process.env.CC_TEST_DB_SUFFIX ?? 'main').toLowerCase().replace(/[^a-z0-9]/g, '') || 'main';

export const BEREEVAL_DATABASE_URL = process.env.BEREEVAL_DATABASE_URL ?? `postgres://localhost:5432/control_center_bereeval_${suffix}`;
