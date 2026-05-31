export type ErrorPayload = {
    code: string;
    message: string;
    details?: Record<string, unknown>;
};

export class AppError extends Error {
    public readonly statusCode: number;
    public readonly code: string;
    public readonly details: Record<string, unknown> | undefined;

    constructor(statusCode: number, code: string, message: string, details?: Record<string, unknown>) {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
        this.details = details;
        this.name = this.constructor.name;
    }

    toPayload(): ErrorPayload {
        return this.details !== undefined
            ? { code: this.code, message: this.message, details: this.details }
            : { code: this.code, message: this.message };
    }
}

export class BadRequestError extends AppError {
    constructor(code = 'BAD_REQUEST', message = 'Bad request', details?: Record<string, unknown>) {
        super(400, code, message, details);
    }
}

export class UnauthorizedError extends AppError {
    constructor(code = 'UNAUTHORIZED', message = 'Unauthorized', details?: Record<string, unknown>) {
        super(401, code, message, details);
    }
}

export class ForbiddenError extends AppError {
    constructor(code = 'FORBIDDEN', message = 'Forbidden', details?: Record<string, unknown>) {
        super(403, code, message, details);
    }
}

export class NotFoundError extends AppError {
    constructor(code = 'NOT_FOUND', message = 'Not found', details?: Record<string, unknown>) {
        super(404, code, message, details);
    }
}

export class ConflictError extends AppError {
    constructor(code = 'CONFLICT', message = 'Conflict', details?: Record<string, unknown>) {
        super(409, code, message, details);
    }
}

export class UnprocessableError extends AppError {
    constructor(code = 'UNPROCESSABLE', message = 'Unprocessable entity', details?: Record<string, unknown>) {
        super(422, code, message, details);
    }
}

export class RateLimitedError extends AppError {
    constructor(code = 'RATE_LIMITED', message = 'Too many requests', details?: Record<string, unknown>) {
        super(429, code, message, details);
    }
}
