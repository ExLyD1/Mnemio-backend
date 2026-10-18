import { inflateRawSync, zstdDecompressSync, crc32 } from 'node:zlib';
import { AppError, BadRequestError } from '../shared/errors.js';

export const invalidApkg = (message = 'Invalid Anki package'): never => {
    throw new BadRequestError('IMPORT_APKG_INVALID', message);
};
export const apkgTooLarge = (message = 'Anki package exceeds extraction limits'): never => {
    throw new AppError(413, 'IMPORT_APKG_TOO_LARGE', message);
};
export const ZIP_LIMITS = { entries: 50_000, entryBytes: 256_000_000, totalBytes: 512_000_000 };
type Entry = {
    name: string;
    flags: number;
    method: number;
    compressed: number;
    size: number;
    offset: number;
    crc: number;
};

/** Central-directory based, no filesystem extraction, no paths from the archive are trusted. */
export class ApkgZip {
    private entries = new Map<string, Entry>();
    private directoryOffset = 0;
    constructor(
        private readonly bytes: Buffer,
        limits = ZIP_LIMITS,
    ) {
        try {
            let end = -1;
            for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
                if (
                    bytes.readUInt32LE(i) === 0x06054b50 &&
                    i + 22 + bytes.readUInt16LE(i + 20) === bytes.length
                ) {
                    end = i;
                    break;
                }
            }
            if (end < 0) {
                invalidApkg('Not a ZIP archive');
            }
            const count = bytes.readUInt16LE(end + 10);
            const directorySize = bytes.readUInt32LE(end + 12);
            this.directoryOffset = bytes.readUInt32LE(end + 16);
            if (
                bytes.readUInt16LE(end + 4) ||
                bytes.readUInt16LE(end + 6) ||
                bytes.readUInt16LE(end + 8) !== count ||
                count === 0xffff ||
                this.directoryOffset === 0xffffffff
            ) {
                invalidApkg('Multi-volume and ZIP64 packages are unsupported');
            }
            if (count > limits.entries) {
                apkgTooLarge('Too many ZIP entries');
            }
            if (this.directoryOffset + directorySize !== end) {
                invalidApkg('Invalid ZIP directory');
            }
            let cursor = this.directoryOffset,
                total = 0;
            for (let i = 0; i < count; i++) {
                if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) {
                    invalidApkg('Corrupt ZIP directory');
                }
                const flags = bytes.readUInt16LE(cursor + 8),
                    method = bytes.readUInt16LE(cursor + 10);
                const compressed = bytes.readUInt32LE(cursor + 20),
                    size = bytes.readUInt32LE(cursor + 24);
                const nameLength = bytes.readUInt16LE(cursor + 28),
                    extraLength = bytes.readUInt16LE(cursor + 30),
                    commentLength = bytes.readUInt16LE(cursor + 32);
                const offset = bytes.readUInt32LE(cursor + 42),
                    crc = bytes.readUInt32LE(cursor + 16);
                const next = cursor + 46 + nameLength + extraLength + commentLength;
                if (
                    next > end ||
                    offset + 30 > this.directoryOffset ||
                    bytes.readUInt16LE(cursor + 34)
                ) {
                    invalidApkg('Corrupt ZIP entry');
                }
                if (flags & 0x41) {
                    invalidApkg('Encrypted ZIP entries are unsupported');
                }
                if (method !== 0 && method !== 8) {
                    invalidApkg('Unsupported ZIP compression');
                }
                const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
                if (!name || this.entries.has(name)) {
                    invalidApkg('Duplicate or empty ZIP entry');
                }
                total += size;
                if (size > limits.entryBytes || total > limits.totalBytes) {
                    apkgTooLarge();
                }
                this.entries.set(name, { name, flags, method, compressed, size, offset, crc });
                cursor = next;
            }
            if (cursor !== end) {
                invalidApkg('Corrupt ZIP directory length');
            }
        } catch (err) {
            if (err instanceof AppError) {
                throw err;
            }
            invalidApkg('Corrupt ZIP archive');
        }
    }
    has(name: string): boolean {
        return this.entries.has(name);
    }
    read(name: string): Buffer {
        const e = this.entries.get(name);
        if (!e) {
            return invalidApkg(`Missing ZIP entry: ${name}`);
        }
        try {
            const b = this.bytes,
                p = e.offset;
            if (
                b.readUInt32LE(p) !== 0x04034b50 ||
                b.readUInt16LE(p + 6) !== e.flags ||
                b.readUInt16LE(p + 8) !== e.method
            ) {
                invalidApkg('Corrupt ZIP local header');
            }
            const nameLength = b.readUInt16LE(p + 26),
                extraLength = b.readUInt16LE(p + 28);
            if (b.subarray(p + 30, p + 30 + nameLength).toString('utf8') !== e.name) {
                invalidApkg('ZIP filename mismatch');
            }
            const start = p + 30 + nameLength + extraLength;
            if (start + e.compressed > this.directoryOffset) {
                invalidApkg('Truncated ZIP entry');
            }
            const compressed = b.subarray(start, start + e.compressed);
            const result =
                e.method === 0
                    ? compressed
                    : inflateRawSync(compressed, { maxOutputLength: Math.max(1, e.size) });
            if (result.length !== e.size || crc32(result) !== e.crc) {
                invalidApkg('ZIP size or checksum mismatch');
            }
            return result;
        } catch (err) {
            if (err instanceof AppError) {
                throw err;
            }
            return invalidApkg('Corrupt compressed ZIP entry');
        }
    }
}
export const isZstd = (b: Buffer): boolean => b.length >= 4 && b.readUInt32LE(0) === 0xfd2fb528;
export const decodeZstd = (b: Buffer, limit = ZIP_LIMITS.entryBytes): Buffer => {
    if (!isZstd(b)) {
        return b;
    }
    try {
        return zstdDecompressSync(b, { maxOutputLength: limit });
    } catch (err) {
        if (err instanceof Error && 'code' in err && err.code === 'ERR_BUFFER_TOO_LARGE') {
            apkgTooLarge();
        }
        return invalidApkg('Corrupt zstd entry');
    }
};

export type ProtoField = { number: number; wire: number; value: number | Buffer };
/** Unknown protobuf fields are retained; varints never exceed 64 bits. */
export const protobuf = (b: Buffer): ProtoField[] => {
    let offset = 0;
    const varint = (): number => {
        let n = 0n;
        for (let i = 0; i < 10; i++) {
            const v = b[offset++];
            if (v === undefined || (i === 9 && v > 1)) {
                return invalidApkg('Corrupt protobuf varint');
            }
            n |= BigInt(v) << BigInt(i * 7);
            if (!(v & 128)) {
                return Number(n);
            }
        }
        return invalidApkg('Corrupt protobuf varint');
    };
    const fields: ProtoField[] = [];
    while (offset < b.length) {
        const tag = varint(),
            number = Math.floor(tag / 8),
            wire = tag % 8;
        if (!number) {
            invalidApkg('Invalid protobuf field');
        }
        let value: number | Buffer;
        if (wire === 0) {
            value = varint();
        } else if (wire === 1 || wire === 2 || wire === 5) {
            const length = wire === 2 ? varint() : wire === 1 ? 8 : 4;
            if (offset + length > b.length) {
                invalidApkg('Truncated protobuf');
            }
            value = b.subarray(offset, offset + length);
            offset += length;
        } else {
            return invalidApkg('Unsupported protobuf wire type');
        }
        fields.push({ number, wire, value });
    }
    return fields;
};
export const protoBytes = (fields: ProtoField[], number: number): Buffer => {
    const v = fields.find((f) => f.number === number)?.value;
    return Buffer.isBuffer(v) ? v : Buffer.alloc(0);
};
export const protoText = (fields: ProtoField[], number: number): string =>
    protoBytes(fields, number).toString('utf8');
export const protoNumber = (fields: ProtoField[], number: number, fallback = 0): number => {
    const v = fields.find((f) => f.number === number)?.value;
    return typeof v === 'number' ? v : fallback;
};

/** Rewrite collation names only in active sqlite_schema SQL records.
 * SQLite table b-tree/payload layout: https://sqlite.org/fileformat2.html.
 * Handles overflow pages; all edits have identical byte lengths. No user-data
 * pages or stale/free schema copies are touched. Call before opening read-only.
 */
export const normalizeAnkiCollation = (bytes: Buffer): void => {
    const pageSize = bytes.readUInt16BE(16) === 1 ? 65536 : bytes.readUInt16BE(16);
    const usable = pageSize - bytes.readUInt8(20);
    if (pageSize < 512 || pageSize > 65536 || pageSize & (pageSize - 1) || usable < 480) {
        invalidApkg('Invalid SQLite page size');
    }
    const varint = (b: Buffer, start: number): [number, number] => {
        let n = 0n,
            p = start;
        for (let i = 0; i < 9; i++) {
            const v = b[p++];
            if (v === undefined) {
                return invalidApkg('Invalid SQLite varint');
            }
            n = (n << BigInt(i === 8 ? 8 : 7)) | BigInt(i === 8 ? v : v & 127);
            if (i === 8 || v < 128) {
                if (n > BigInt(Number.MAX_SAFE_INTEGER)) {
                    invalidApkg('Oversized SQLite value');
                }
                return [Number(n), p];
            }
        }
        return invalidApkg();
    };
    const seen = new Set<number>();
    const pageOffset = (page: number): number => {
        if (page < 1 || page * pageSize > bytes.length || seen.has(page)) {
            return invalidApkg('Invalid SQLite schema page');
        }
        seen.add(page);
        return (page - 1) * pageSize;
    };
    const pages = [1];
    while (pages.length) {
        const page = pages.pop();
        if (page === undefined) {
            break;
        }
        const base = pageOffset(page),
            header = base + (page === 1 ? 100 : 0);
        const kind = bytes[header],
            count = bytes.readUInt16BE(header + 3);
        if (kind !== 5 && kind !== 13) {
            invalidApkg('Invalid SQLite schema tree');
        }
        if (kind === 5) {
            pages.push(bytes.readUInt32BE(header + 8));
        }
        const pointers = header + (kind === 5 ? 12 : 8);
        if (pointers + count * 2 > base + usable) {
            invalidApkg('Invalid SQLite schema cells');
        }
        for (let i = 0; i < count; i++) {
            const cell = base + bytes.readUInt16BE(pointers + i * 2);
            if (cell < pointers + count * 2 || cell >= base + usable) {
                invalidApkg('Invalid SQLite schema cell');
            }
            if (kind === 5) {
                pages.push(bytes.readUInt32BE(cell));
                continue;
            }
            const [size, afterSize] = varint(bytes, cell),
                [, start] = varint(bytes, afterSize);
            if (size > ZIP_LIMITS.entryBytes) {
                apkgTooLarge();
            }
            const minLocal = Math.floor(((usable - 12) * 32) / 255) - 23,
                maxLocal = usable - 35;
            let local = size;
            if (size > maxLocal) {
                local = minLocal + ((size - minLocal) % (usable - 4));
                if (local > maxLocal) {
                    local = minLocal;
                }
            }
            if (start + local + (size > local ? 4 : 0) > base + usable) {
                invalidApkg('Invalid SQLite schema payload');
            }
            const ranges: { start: number; length: number }[] = [{ start, length: local }];
            let remaining = size - local;
            let next = remaining ? bytes.readUInt32BE(start + local) : 0;
            while (remaining) {
                const overflow = pageOffset(next),
                    length = Math.min(remaining, usable - 4);
                ranges.push({ start: overflow + 4, length });
                remaining -= length;
                next = bytes.readUInt32BE(overflow);
            }
            if (next) {
                invalidApkg('Unexpected SQLite schema overflow');
            }
            const payload = Buffer.concat(
                ranges.map((r) => bytes.subarray(r.start, r.start + r.length)),
            );
            const [headerSize, serialStart] = varint(payload, 0);
            let serialPos = serialStart,
                dataPos = headerSize;
            for (let column = 0; column < 5; column++) {
                const [serial, following] = varint(payload, serialPos);
                serialPos = following;
                const length =
                    serial >= 12
                        ? Math.floor((serial - 12) / 2)
                        : [0, 1, 2, 3, 4, 6, 8, 8, 0, 0][serial];
                if (length === undefined || serialPos > headerSize || dataPos + length > size) {
                    return invalidApkg('Invalid SQLite schema record');
                }
                if (column === 4 && serial >= 13 && serial % 2 === 1) {
                    const sql = payload.subarray(dataPos, dataPos + length).toString('utf8');
                    const normalized = sql.replace(/(\bCOLLATE\s+)unicase\b/gi, '$1BINARY ');
                    if (sql !== normalized) {
                        const replacement = Buffer.from(normalized);
                        if (replacement.length !== length) {
                            invalidApkg('Invalid SQLite schema encoding');
                        }
                        replacement.copy(payload, dataPos);
                        let pos = 0;
                        for (const range of ranges) {
                            payload.copy(bytes, range.start, pos, pos + range.length);
                            pos += range.length;
                        }
                    }
                }
                dataPos += length;
            }
        }
    }
};
