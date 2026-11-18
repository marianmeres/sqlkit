// The Postgres the test suite runs against, read from `TEST_PG_*` (`.env`, see
// `.env.example`; CI sets them for its own server). A missing database is a loud failure,
// never a skip: the Postgres cases are part of the suite, not an option of it (D20).

/** What a node-postgres pool needs to reach the test database. */
export interface TestPgConfig {
	host: string;
	port: number;
	database: string;
	user: string | undefined;
	password: string | undefined;
}

/** The test database's connection settings; throws when `TEST_PG_DATABASE` is unset. */
export function testPgConfig(): TestPgConfig {
	const {
		TEST_PG_HOST,
		TEST_PG_PORT,
		TEST_PG_DATABASE,
		TEST_PG_USER,
		TEST_PG_PASSWORD,
	} = process.env;
	if (!TEST_PG_DATABASE) {
		throw new Error(
			"Postgres test config missing: set TEST_PG_DATABASE (and TEST_PG_HOST, " +
				"TEST_PG_PORT, TEST_PG_USER, TEST_PG_PASSWORD as needed; see .env.example). " +
				"The Postgres cases do not skip: a missing Postgres fails the suite.",
		);
	}
	const port = Number(TEST_PG_PORT || 5432);
	if (!Number.isSafeInteger(port) || port <= 0) {
		throw new Error(`TEST_PG_PORT is not a port number: ${String(TEST_PG_PORT)}`);
	}
	return {
		host: TEST_PG_HOST || "localhost",
		port,
		database: TEST_PG_DATABASE,
		user: TEST_PG_USER || undefined,
		password: TEST_PG_PASSWORD,
	};
}
