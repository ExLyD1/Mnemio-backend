import path from 'node:path';

/** Prefer signatures; use filename only for formats without a recognized signature. */
export const mediaMime = (bytes: Buffer, filename: string): string | null => {
    if (
        bytes.length >= 8 &&
        bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ) {
        return 'image/png';
    }
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
        return 'image/jpeg';
    }
    const start = bytes.toString('ascii', 0, 12);
    if (start.startsWith('GIF87a') || start.startsWith('GIF89a')) {
        return 'image/gif';
    }
    if (start.startsWith('RIFF') && start.slice(8, 12) === 'WEBP') {
        return 'image/webp';
    }
    if (start.startsWith('RIFF') && start.slice(8, 12) === 'WAVE') {
        return 'audio/wav';
    }
    if (start.startsWith('OggS')) {
        return 'audio/ogg';
    }
    if (start.startsWith('ID3') || (bytes[0] === 255 && ((bytes[1] ?? 0) & 0xe0) === 0xe0)) {
        return 'audio/mpeg';
    }
    if (bytes.length >= 4 && bytes.readUInt32BE(0) === 0x1a45dfa3) {
        return 'audio/webm';
    }
    const extensions: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
        '.ogg': 'audio/ogg',
        '.webm': 'audio/webm',
    };
    return extensions[path.extname(filename).toLowerCase()] ?? null;
};
