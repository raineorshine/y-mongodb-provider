import * as Y from 'yjs';
import * as binary from 'lib0/binary';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { Buffer } from 'buffer';

export const PREFERRED_TRIM_SIZE = 400;
const MAX_DOCUMENT_SIZE = 15000000; // ~15MB (plus space for metadata)

/**
 * Remove all documents from db with Clock between $from and $to
 *
 * @param {any} db
 * @param {string} docName
 * @param {number} from Greater than or equal
 * @param {number} to lower than (not equal)
 * @return {Promise<void>}
 */
export const clearUpdatesRange = async (db, docName, from, to) =>
	db.del({
		docName,
		clock: {
			$gte: from,
			$lt: to,
		},
	});

/**
 * Create a unique key for a update message.
 * @param {string} docName
 * @param {number} [clock] must be unique
 * @return {Object} [opts.version, opts.docName, opts.action, opts.clock]
 */
export const createDocumentUpdateKey = (docName, clock) => {
	if (clock !== undefined) {
		return {
			version: 'v1',
			action: 'update',
			docName,
			clock,
		};
	} else {
		return {
			version: 'v1',
			action: 'update',
			docName,
		};
	}
};

/**
 * We have a separate state vector key so we can iterate efficiently over all documents
 * @param {string} docName
 * @return {Object} [opts.docName, opts.version]
 */
export const createDocumentStateVectorKey = (docName) => ({
	docName,
	version: 'v1_sv',
});

/**
 * @param {string} docName
 * @param {string} metaKey
 * @return {Object} [opts.docName, opts.version, opts.docType, opts.metaKey]
 */
export const createDocumentMetaKey = (docName, metaKey) => ({
	version: 'v1',
	docName,
	metaKey: `meta_${metaKey}`,
});

/**
 * @param {any} db
 * @param {object} query
 * @param {object} opts
 * @return {Promise<any[]>}
 */
export const _getMongoBulkData = (db, query, opts) => db.readAsCursor(query, opts);

/**
 * @param {any} db
 * @return {Promise<any>}
 */
export const flushDB = (db) => db.flush();

/**
 * Convert the mongo document array to an array of values (as buffers)
 *
 * @param {any[]} docs
 * @return {Buffer[]}
 */
const _convertMongoUpdates = (docs) => {
	if (!Array.isArray(docs) || !docs.length) return [];

	const updates = [];
	for (let i = 0; i < docs.length; i++) {
		const doc = docs[i];
		if (!doc.part) {
			updates.push(doc.value.buffer);
		} else if (doc.part === 1) {
			// merge the docs together that got split because of mongodb size limits
			const parts = [Buffer.from(doc.value.buffer)];
			let j;
			let currentPartId = doc.part;
			for (j = i + 1; j < docs.length; j++) {
				const part = docs[j];
				if (part.clock === doc.clock) {
					if (currentPartId !== part.part - 1) {
						throw new Error('Couldnt merge updates together because a part is missing!');
					}
					parts.push(Buffer.from(part.value.buffer));
					currentPartId = part.part;
				} else {
					break;
				}
			}
			updates.push(Buffer.concat(parts));
		}
	}
	return updates;
};
/**
 * Get all document updates for a specific document.
 *
 * @param {any} db
 * @param {string} docName
 * @param {any} [opts]
 * @return {Promise<any[]>}
 */
export const getMongoUpdates = async (db, docName, opts = {}) => {
	const docs = await _getMongoBulkData(db, createDocumentUpdateKey(docName), opts);
	return _convertMongoUpdates(docs);
};

/**
 * @param {any} db
 * @param {string} docName
 * @return {Promise<number>} Returns -1 if this document doesn't exist yet
 */
export const getCurrentUpdateClock = (db, docName) =>
	_getMongoBulkData(
		db,
		{
			...createDocumentUpdateKey(docName, 0),
			clock: {
				$gte: 0,
				$lt: binary.BITS32,
			},
		},
		{ reverse: true, limit: 1 },
	).then((updates) => {
		if (updates.length === 0) {
			return -1;
		} else {
			return updates[0].clock;
		}
	});

/**
 * @param {any} db
 * @param {string} docName
 * @param {Uint8Array} sv state vector
 * @param {number} clock current clock of the document so we can determine
 * when this statevector was created
 */
export const writeStateVector = async (db, docName, sv, clock) => {
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, clock);
	encoding.writeVarUint8Array(encoder, sv);
	await db.put(createDocumentStateVectorKey(docName), {
		value: Buffer.from(encoding.toUint8Array(encoder)),
	});
};

/**
 * @param {any} db
 * @param {string} docName
 * @param {Uint8Array} update
 * @return {Promise<number>} Returns the clock of the stored update
 */
export const storeUpdate = async (db, docName, update) => {
	const clock = await getCurrentUpdateClock(db, docName);
	if (clock === -1) {
		// make sure that a state vector is always written, so we can search for available documents
		const ydoc = new Y.Doc();
		Y.applyUpdate(ydoc, update);
		const sv = Y.encodeStateVector(ydoc);
		await writeStateVector(db, docName, sv, 0);
	}

	const value = Buffer.from(update);
	// mongodb has a maximum document size of 16MB;
	//  if our buffer exceeds it, we store the update in multiple documents
	if (value.length <= MAX_DOCUMENT_SIZE) {
		await db.put(createDocumentUpdateKey(docName, clock + 1), {
			value,
		});
	} else {
		const totalChunks = Math.ceil(value.length / MAX_DOCUMENT_SIZE);

		const putPromises = [];
		for (let i = 0; i < totalChunks; i++) {
			const start = i * MAX_DOCUMENT_SIZE;
			const end = Math.min(start + MAX_DOCUMENT_SIZE, value.length);
			const chunk = value.subarray(start, end);

			putPromises.push(
				db.put({ ...createDocumentUpdateKey(docName, clock + 1), part: i + 1 }, { value: chunk }),
			);
		}

		await Promise.all(putPromises);
	}

	return clock + 1;
};

/**
 * For now this is a helper method that creates a Y.Doc and then re-encodes a document update.
 * In the future this will be handled by Yjs without creating a Y.Doc (constant memory consumption).
 *
 * @param {Array<Uint8Array>} updates
 * @return {{update:Uint8Array, sv: Uint8Array}}
 */
export const mergeUpdates = (updates) => {
	const ydoc = new Y.Doc();
	ydoc.transact(() => {
		for (let i = 0; i < updates.length; i++) {
			Y.applyUpdate(ydoc, updates[i]);
		}
	});
	return { update: Y.encodeStateAsUpdate(ydoc), sv: Y.encodeStateVector(ydoc) };
};

/**
 * @param {Uint8Array} buf
 * @return {{ sv: Uint8Array, clock: number }}
 */
export const decodeMongodbStateVector = (buf) => {
	let decoder;
	if (Buffer.isBuffer(buf)) {
		decoder = decoding.createDecoder(buf);
	} else if (Buffer.isBuffer(buf?.buffer)) {
		decoder = decoding.createDecoder(buf.buffer);
	} else {
		throw new Error('No buffer provided at decodeMongodbStateVector()');
	}
	const clock = decoding.readVarUint(decoder);
	const sv = decoding.readVarUint8Array(decoder);
	return { sv, clock };
};

/**
 * @param {any} db
 * @param {string} docName
 */
export const readStateVector = async (db, docName) => {
	const doc = await db.get({ ...createDocumentStateVectorKey(docName) });
	if (!doc?.value) {
		// no state vector created yet or no document exists
		return { sv: null, clock: -1 };
	}
	return decodeMongodbStateVector(doc.value);
};

export const getAllSVDocs = async (db) => db.readAsCursor({ version: 'v1_sv' });

/**
 * Merge all MongoDB documents of the same yjs document together.
 * @param {any} db
 * @param {string} docName
 * @param {Uint8Array} stateAsUpdate
 * @param {Uint8Array} stateVector
 * @return {Promise<number>} returns the clock of the flushed doc
 */
export const flushDocument = async (db, docName, stateAsUpdate, stateVector) => {
	const clock = await storeUpdate(db, docName, stateAsUpdate);
	await writeStateVector(db, docName, stateVector, clock);
	await clearUpdatesRange(db, docName, 0, clock);
	return clock;
};
