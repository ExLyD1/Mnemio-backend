import { buildApp } from './app.js';
import { env } from './config/env.js';
import { prisma } from './db/prisma.js';

const start = async () => {
    const app = await buildApp();

    const shutdown = async (signal: string) => {
        app.log.info({ signal }, 'Shutting down...');
        try {
            await app.close();
            await prisma.$disconnect();
            process.exit(0);
        } catch (err) {
            app.log.error({ err }, 'Error during shutdown');
            process.exit(1);
        }
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    try {
        await app.listen({ host: env.HOST, port: env.PORT });
    } catch (err) {
        app.log.error({ err }, 'Failed to start server');
        process.exit(1);
    }
};

start();
