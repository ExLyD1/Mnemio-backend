import type { FastifyRequest, FastifyReply } from 'fastify';
import {
    importQuizletSchema,
    importTextSchema,
    importApkgSchema,
} from '../schemas/imports.schema.js';
import * as importsService from '../services/imports.service.js';
import * as apkgService from '../services/imports.apkg.service.js';
import { env } from '../config/env.js';
import { BadRequestError } from '../shared/errors.js';
import { apkgTooLarge } from '../services/imports.apkg.binary.js';

export const importApkg = async (request: FastifyRequest, reply: FastifyReply) => {
    let bytes: Buffer | undefined;
    const fields: Record<string, string> = {};
    try {
        for await (const part of request.parts({
            limits: {
                fileSize: env.IMPORT_APKG_MAX_BYTES,
                files: 1,
                fields: 2,
                parts: 3,
                fieldSize: 100,
            },
        })) {
            if (part.type === 'file') {
                if (part.fieldname !== 'file' || bytes) {
                    throw new BadRequestError(
                        'IMPORT_APKG_INVALID',
                        'Expected a single file field',
                    );
                }
                bytes = await part.toBuffer();
                if (part.file.truncated) {
                    apkgTooLarge('Package exceeds upload limit');
                }
            } else {
                if (
                    !['sourceLanguage', 'targetLanguage'].includes(part.fieldname) ||
                    part.fieldname in fields ||
                    part.valueTruncated ||
                    typeof part.value !== 'string'
                ) {
                    throw new BadRequestError('IMPORT_APKG_INVALID', 'Invalid multipart field');
                }
                fields[part.fieldname] = part.value;
            }
        }
    } catch (err) {
        const code = err instanceof Error && 'code' in err ? err.code : null;
        if (code === 'FST_REQ_FILE_TOO_LARGE') {
            apkgTooLarge('Package exceeds upload limit');
        }
        if (typeof code === 'string' && code.startsWith('FST_')) {
            throw new BadRequestError('IMPORT_APKG_INVALID', 'Invalid multipart package');
        }
        throw err;
    }
    if (!bytes) {
        throw new BadRequestError('IMPORT_APKG_INVALID', 'Send the package in the file field');
    }
    const input = importApkgSchema.parse(fields);
    const result = await apkgService.importApkg(request.currentUser.sub, bytes, input);
    reply.code(201).send(result);
};

export const importQuizlet = async (request: FastifyRequest, reply: FastifyReply) => {
    const input = importQuizletSchema.parse(request.body);
    const result = await importsService.importQuizletByUrl(request.currentUser.sub, input.url);
    reply.send(result);
};

export const importText = async (request: FastifyRequest, reply: FastifyReply) => {
    const input = importTextSchema.parse(request.body);
    const result = await importsService.importByText(
        request.currentUser.sub,
        input.text,
        input.format,
    );
    reply.send(result);
};
