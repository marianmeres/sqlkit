/**
 * `toPgDriver`: a `Driver` for whatever a library was handed as its database, a pool, a
 * client or a driver. It is the one place in the adapter where an object's shape decides
 * what it is: the two factories guess nothing, and a host that knows what it holds calls
 * one of them. A library whose `db` option takes any of the three has to decide, and
 * decides here, by one rule.
 *
 * **One driver per pool, and per client.** The driver built for an object is kept by that
 * object and handed back to every later call, because a second driver over the same
 * object is not harmless:
 *
 * - A driver listens to its pool's or client's `error` event, and reports one only when
 *   nobody else listens. Two drivers are two listeners: each takes the other for the
 *   host's and stays quiet, so the error is reported by neither. A caller that converts
 *   on every call (a health check on a timer) would add one each time.
 * - One client is one session. Each driver over it gives its own transactions their turn
 *   and knows nothing of the other's, so a statement sent through the second lands inside
 *   the transaction the first has open.
 *
 * So every caller that converts the same pool or client shares one driver, and with it
 * its transactions: a statement issued inside a transaction's callback joins that
 * transaction, whoever converted. The driver is kept per copy of this package: two copies
 * in one app build one each.
 *
 * A `Driver` is handed back as it is, and nothing is kept for it.
 */

import { type Driver, missingFromDriver } from "../core/contract.ts";
import { createPgClientDriver } from "./client.ts";
import { createPgDriver } from "./pool.ts";
import { describe } from "./session.ts";
import { countsConnections, isClientShaped, isPoolShaped } from "./shape.ts";
import type { PgPoolLike, PgStandaloneClientLike } from "./types.ts";

/**
 * What {@link toPgDriver} takes: a node-postgres `pg.Pool`, a connected `pg.Client`, or a
 * `Driver` of the `pg` dialect. The type for a library's own `db` option.
 */
export type PgDb = PgPoolLike | PgStandaloneClientLike | Driver;

const TAKES =
	"toPgDriver(db) takes a node-postgres pg.Pool, a pg.Client or a Driver of the pg dialect";

/** The driver built for each pool and each client, kept for as long as the object is. */
const drivers = new WeakMap<object, Driver>();

/**
 * The `Driver` for `db`.
 *
 * - **A `Driver`** is handed back as it is: not wrapped, not kept. One of another dialect
 *   is refused, and so is one that is not the contract as this version states it (a
 *   driver built before `savepoint` was added): the refusal names what it lacks.
 * - **A pool or a client** gets the driver its factory builds, `createPgDriver` or
 *   `createPgClientDriver`, with no options: once, and the same one on every later call
 *   with that object. A driver bound to a schema is built with the factory and passed
 *   as a `Driver`.
 *
 * A pool is told by its count of connections (a numeric `totalCount`, as node-postgres's
 * has), or by having no `query` of its own, which a client cannot lack. Anything else
 * that has a client's methods is taken for a client: a pool of another make, which has
 * `query` and counts nothing, goes through `createPgDriver`.
 *
 * Nothing is connected, sent or closed here. `close()` on the driver ends the pool or
 * the client, as on any driver: a library that was handed its database does not call it.
 *
 * @throws {TypeError} For anything else: a value that is none of the three, a `Driver` of
 *   another dialect, a `Driver` that lacks a member of the contract.
 */
export function toPgDriver(db: PgDb): Driver {
	const given: unknown = db;
	if (typeof given !== "object" || given === null) {
		throw new TypeError(`${TAKES}, got ${describe(given)}`);
	}
	// A driver states its dialect; a pool and a client have none.
	if (typeof (given as { dialect?: unknown }).dialect === "string") {
		return pgDriverOf(given);
	}
	let driver = drivers.get(given);
	if (driver === undefined) {
		driver = build(given);
		drivers.set(given, driver);
	}
	return driver;
}

/** A value that says it is a driver, held to the contract and to the dialect. */
function pgDriverOf(given: object): Driver {
	const missing = missingFromDriver(given) ?? [];
	if (missing.length > 0) {
		throw new TypeError(
			"toPgDriver(db) takes a Driver as this version of the package has it: " +
				`this one has no ${missing.join(", no ")}`,
		);
	}
	const driver = given as Driver;
	if (driver.dialect !== "pg") {
		throw new TypeError(
			`toPgDriver(db) takes a Driver of the pg dialect, got "${driver.dialect}" ` +
				`(${driver.adapter})`,
		);
	}
	return driver;
}

/** The driver for a pool or a client, by the rule {@link toPgDriver} states. */
function build(given: object): Driver {
	const pool =
		countsConnections(given) ||
		typeof (given as { query?: unknown }).query !== "function";
	if (pool) {
		if (isPoolShaped(given)) return createPgDriver(given);
	} else if (isClientShaped(given)) {
		return createPgClientDriver(given);
	}
	throw new TypeError(`${TAKES}, got an object that is none of them`);
}
