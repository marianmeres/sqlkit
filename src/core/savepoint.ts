/**
 * A savepoint by statement: what an adapter whose database takes `SAVEPOINT` does for
 * `Driver.savepoint` inside an open transaction. Both dialects spell the three statements
 * the same way. (A Durable Object refuses them, and nests its own transaction instead.)
 *
 * The savepoint is opened, `fn` runs, and it is released when `fn` answered: its work
 * stays in the transaction. When `fn` failed it is rolled back to and released, and
 * `fn`'s failure is the answer, as it was thrown. Either way the transaction is as open
 * as it was.
 *
 * **What the savepoint's own statements refuse is the answer too.** A savepoint that
 * would not open leaves nothing to undo. One that would not be released is rolled back
 * to, so that what is reported as failed is not kept, and the release's refusal is
 * thrown. One that would not be rolled back to throws that refusal rather than `fn`'s
 * failure: the transaction goes on after a savepoint, so its caller has to learn that the
 * unit is still in it. A caller tells the three from `fn`'s own failure by identity.
 *
 * `send` runs one text of statements on the transaction's connection, with no values and
 * no result. Each adapter gives its own: guarded where its errors are typed there, and
 * straight to the handle where a script would cost it its compiled statements.
 *
 * Runtime-neutral: no import at all.
 */

/** The savepoint's name and the three texts that open it, keep it, and undo it. */
function statementsOf(name: string): { open: string; release: string; undo: string } {
	return {
		open: `savepoint ${name}`,
		release: `release savepoint ${name}`,
		// Rolling back to a savepoint leaves it in place: released, it is gone.
		undo: `rollback to savepoint ${name}; release savepoint ${name}`,
	};
}

/**
 * The name of the savepoint `depth` levels inside a transaction, 1 for the first. One
 * connection's savepoints are a stack, so the depth names each of them apart; the prefix
 * keeps them apart from one a caller wrote by hand.
 */
export function savepointName(depth: number): string {
	return `sqlkit_${depth}`;
}

/** Run `fn` in the savepoint `name`, each of its statements sent through `send`. */
export async function savepointBy<T>(
	send: (text: string) => unknown,
	name: string,
	fn: () => Promise<T>,
): Promise<T> {
	const { open, release, undo } = statementsOf(name);
	await send(open);
	let result: T;
	try {
		result = await fn();
	} catch (error) {
		await send(undo);
		throw error;
	}
	try {
		await send(release);
	} catch (error) {
		try {
			await send(undo);
		} catch {
			// The release's refusal is the one to report.
		}
		throw error;
	}
	return result;
}

/** {@link savepointBy} on a synchronous engine: `send` and `fn` answer at once. */
export function savepointBySync<T>(
	send: (text: string) => void,
	name: string,
	fn: () => T,
): T {
	const { open, release, undo } = statementsOf(name);
	send(open);
	let result: T;
	try {
		result = fn();
	} catch (error) {
		send(undo);
		throw error;
	}
	try {
		send(release);
	} catch (error) {
		try {
			send(undo);
		} catch {
			// The release's refusal is the one to report.
		}
		throw error;
	}
	return result;
}
